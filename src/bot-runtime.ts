import { WorkCardControls } from './work-card-controls.ts';
import { WorkPayments } from './work-payments.ts';
import { workCards, type WorkCard } from './work-cards.ts';
import { BotFiles } from './bot-files.ts';
import { connectionProblem } from './connection-status.ts';
import { argumentError } from './validation.ts';

export interface RuntimeIdentity { id: string; agentId: string; name: string; }
export interface RuntimeOptions {
  rpc: (method: string, body: object, service?: string) => Promise<any>;
  identity: (id: string) => Promise<RuntimeIdentity>;
  fetch?: typeof fetch;
  now?: () => number;
  siteOrigin?: string;
  loadActivity?:(agentId:string,beforeSeq?:number)=>WorkCard[];
  saveActivity?:(agentId:string,cards:WorkCard[])=>void;
  onChanged?:()=>void;
  accessToken?:()=>string;
  submitRoutine?:(bot:RuntimeIdentity,operation:'create'|'update',spec:Record<string,unknown>,id?:string)=>Promise<any>;
}
const record = (v: any): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const rows = (v: any, key: string): any[] => {
  const value = v?.[key];
  if (value !== undefined && !Array.isArray(value)) throw new Error(`Grok returned an invalid ${key} list.`);
  return value ?? [];
};
export const requiredText = (v: unknown, label: string, max = 10000): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`${label} is required (up to ${max} characters).`);
  return v;
};
/** Native email address rule: one @, a visible local part and a dotted domain ending in letters or punycode. */
export function emailAddress(v:string){
  if(v.length>254)return false;
  const parts=v.split('@');if(parts.length!==2||!/^[^\s\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069@]+$/u.test(parts[0]))return false;
  const labels=parts[1].split('.'),top=labels.at(-1) as string;
  return labels.length>=2&&labels.every(l=>/^[\p{L}\p{Nd}](?:[\p{L}\p{M}\p{Nd}-]*[\p{L}\p{M}\p{Nd}])?$/u.test(l))&&(/^(?:\p{L}\p{M}*){2,}$/u.test(top.normalize('NFC'))||/^xn--[a-z0-9-]*[a-z0-9]$/i.test(top));
}
const addresses=(v:unknown,label:string)=>{
  if(!Array.isArray(v)||v.length>100||!v.every(a=>typeof a==='string'))throw new Error(`${label} must be a list of up to 100 addresses.`);
  return v.map(a=>a.trim()).filter(Boolean);
};
/**
 * Builds the SendGrokBotDraft oneof exactly as Grok Bot's native composer does. Only the body may change by
 * default; recipients, subject, sender and meeting visibility change only through `review`, which must carry the
 * explicit editor confirmation and the card revision the person saw. Slack, meeting and session routing never change.
 */
function draftPayload(card:WorkCard,args:Record<string,unknown>):Record<string,unknown>{
  const draft=card.draft as Record<string,any>,review=record(args.review),keys=Object.keys(review);
  if(args.review!==undefined&&(args.reviewed!==true||args.revision!==draft.revision||!keys.length))throw new Error('Recipient and routing changes must be confirmed in the draft editor.');
  const allowed=card.kind==='email-draft'?['from','to','cc','subject']:card.kind==='meeting-chat-draft'?['markInternal']:[];
  if(keys.some(k=>!allowed.includes(k)))throw new Error('This draft’s destination can’t be changed here.');
  if(card.kind==='email-draft'){
    let from=draft.from as string;
    if(review.from!==undefined){
      const choices=draft.sendingAddresses as string[],wanted=String(review.from).toLowerCase(),match=choices.find(a=>a.toLowerCase()===wanted);
      if(!match)throw new Error('Choose one of this bot’s verified sending addresses.');
      from=match;
    }
    const to=review.to===undefined?draft.to as string[]:addresses(review.to,'To'),cc=review.cc===undefined?draft.cc as string[]:addresses(review.cc,'Cc');
    const subject=review.subject===undefined?draft.subject as string:typeof review.subject==='string'&&review.subject.length<=2000?review.subject.replace(/[\r\n]+/g,' '):null;
    if(subject===null)throw new Error('Subject must be text up to 2000 characters.');
    if(!to.length||![...to,...cc].every(emailAddress))throw new Error('Enter at least one valid recipient. Every To and Cc address must be a valid email address.');
    const email={from,to,cc,subject,body:requiredText(args.body,'Message body',100000)};
    return {email,...(typeof draft.signatureHtml==='string'?{shownSignatureHtml:draft.signatureHtml}:{})};
  }
  if(card.kind==='slack-draft'){
    return {slack:{...(draft.workspace?{workspace:draft.workspace}:{}),target:draft.target,...(draft.thread?{thread:draft.thread}:{}),body:requiredText(args.body,'Message body',100000)}};
  }
  if(review.markInternal!==undefined&&(typeof review.markInternal!=='boolean'||review.markInternal&&!draft.canMarkInternal))throw new Error('This meeting message can’t be marked internal.');
  return {meetingChat:{meetingId:draft.meetingId,...(draft.meetingTitle?{meetingTitle:draft.meetingTitle}:{}),body:requiredText(args.body,'Message body',4096),...(review.markInternal===true?{markInternal:true}:{})}};
}
function json(v: unknown) { if (typeof v !== 'string') return record(v); try { return record(JSON.parse(v)); } catch { throw new Error('Grok returned a malformed routine record. Refresh before changing it.'); } }
const text = (v: any) => typeof v === 'string' ? v : '';
const specSchema = { type: 'object', required: ['name', 'prompt', 'trigger'], additionalProperties: false, properties: {
  name: { type: 'string', minLength: 1, maxLength: 500 }, prompt: { type: 'string', minLength: 1, maxLength: 100000 },
  trigger: { type: 'object', required: ['type'], properties: { type: { type: 'string', minLength: 1 } } }, isEnabled: { type: 'boolean' },
} };

/** User-facing bot operations. Provider credentials and original desktop URLs never enter its resource DTOs. */
export class BotRuntime {
  private o: RuntimeOptions;
  private fetch: typeof fetch;
  private closed = false;
  private box: any = null;
  private boxAt = 0;
  private connecting: Promise<any> | null = null;
  private eventAbort:AbortController|null=null;
  private eventRetryAt=0;
  private eventNoticeAt=0;
  private writing = new Set<string>();
  private files: BotFiles;
  private controls: WorkCardControls;
  private payments: WorkPayments;
  private computerRoutines=new Map<string,any[]>();
  private resourceData=new Map<string,Record<string,any>>();
  constructor(options: RuntimeOptions) { this.o = options; this.controls=new WorkCardControls((method,body)=>this.rpc(method,body),(bot,method,body)=>this.gateway(bot,method,body,true,true)); this.fetch = options.fetch ?? fetch; this.payments=new WorkPayments((method,body)=>this.rpc(method,body),options.siteOrigin??'https://cursor.com',options.now);this.files = new BotFiles({rpc:(method,body)=>this.rpc(method,body),now:options.now}); }
  private async currentCardPage(bot:RuntimeIdentity,id:string,seq:unknown){
    const page=await this.rpc('ListGrokBotTranscriptEntries',{agentId:bot.agentId,limit:100});
    // Always prefer the newest record. A displayed older position is only a bounded lookup hint,
    // never authority: callers still recheck the returned card, session, revision and permitted action.
    if(workCards(page).cards.some(card=>card.id===id)||!Number.isSafeInteger(seq)||Number(seq)<0||Number(seq)>=Number.MAX_SAFE_INTEGER)return page;
    return this.rpc('ListGrokBotTranscriptEntries',{agentId:bot.agentId,limit:100,beforeSeq:String(Number(seq)+1)});
  }
  private now() { return (this.o.now ?? Date.now)(); }
  private assertOpen() { if (this.closed) throw new Error('This bot workspace is closed.'); }
  async identity(id: string) { this.assertOpen(); return this.o.identity(requiredText(id, 'Bot', 500)); }
  private rpc(method: string, body: object, service?: string) { this.assertOpen(); return this.o.rpc(method, body, service); }

  private async connection(wake: boolean) {
    this.assertOpen();
    if (this.box && this.now() - this.boxAt < 60_000) return this.box;
    if (this.connecting) return this.connecting;
    this.connecting = this.rpc('EnsureSandBox', { supportsAsleepBox: true, wake }).then((box) => {
      this.assertOpen();
      if(!box.gatewayUrl)throw new Error('The cloud computer is asleep or unavailable. Connect to wake it.');
      const url = new URL(box.gatewayUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Grok returned an unsafe computer gateway.');
      this.box = box; this.boxAt = this.now(); return box;
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async gateway(bot: RuntimeIdentity, method: string, args: Record<string, unknown>, wake: boolean, mutation = false) {
    const box = await this.connection(wake);
    const headers:Record<string,string>={'content-type':'application/json',...this.gatewayHeaders(box)};
    let result: Response;
    try {
      result = await this.fetch(`${box.gatewayUrl.replace(/\/$/, '')}/api/${method}`, { method: 'POST', headers, body: JSON.stringify({ ...args, id: bot.agentId }), signal: AbortSignal.timeout(30000), redirect: 'error' });
    } catch (err) { throw new Error(mutation ? 'The connection dropped after dispatch. Outcome unknown: check activity before retrying.' : connectionProblem(err).message); }
    this.assertOpen();
    if (!result.ok) {
      if ([401, 403, 410, 417].includes(result.status)) this.box = null;
      // Response bodies can include credentials or provider URLs. Do not forward a transport dump.
      throw new Error(connectionProblem(`HTTP ${result.status}`).message);
    }
    let value:any;
    try { value=await result.json(); } catch { throw new Error(mutation ? 'Grok returned an unreadable action receipt. Outcome unknown: check activity before retrying.' : 'The computer returned an unreadable response.'); }
    if(value?.error||value?.refusal||value?.status==='refused')throw new Error('The computer refused this request. Check its permissions and current state.');
    return value;
  }

  private gatewayHeaders(box:any):Record<string,string>{
    const token=this.o.accessToken?.();
    const headers:Record<string,string>={};
    if(token){headers.authorization=`Bearer ${token}`;if(box.gatewayToken)headers['x-sand-gateway-token']=box.gatewayToken;}
    else if(box.gatewayToken)headers.authorization=`Bearer ${box.gatewayToken}`;
    if(box.gatewayPortToken)headers['x-anyrun-port-token']=box.gatewayPortToken;else if(box.networkToken)headers['x-anyrun-network-token']=box.networkToken;
    return headers;
  }
  private startEvents(){
    if(!this.o.onChanged||this.eventAbort||this.closed||this.now()<this.eventRetryAt)return;
    const controller=new AbortController();this.eventAbort=controller;
    void (async()=>{
      const state=await this.rpc('GetSandBoxRunState',{});
      if(state.state==='SAND_BOX_RUN_STATE_HIBERNATED')return;
      const box=await this.connection(false);
      const headers:Record<string,string>={accept:'text/event-stream',...this.gatewayHeaders(box)};
      const result=await this.fetch(`${box.gatewayUrl.replace(/\/$/,'')}/events`,{headers,redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(300000)])});
      if(!result.ok||!result.body)return;
      const decoder=new TextDecoder();let buffered='';
      for await(const chunk of result.body){
        if(this.closed||controller.signal.aborted)break;
        buffered=(buffered+decoder.decode(chunk,{stream:true})).replace(/\r\n/g,'\n');
        if(buffered.length>1024*1024)throw new Error('Event frame exceeded its limit.');
        let boundary:number;
        while((boundary=buffered.indexOf('\n\n'))>=0){
          const event=buffered.slice(0,boundary);buffered=buffered.slice(boundary+2);
          if(event.split('\n').some(line=>line.startsWith('data:'))&&this.now()-this.eventNoticeAt>=2000){this.eventNoticeAt=this.now();this.o.onChanged?.();}
        }
      }
    })().catch(()=>{}).finally(()=>{if(this.eventAbort===controller)this.eventAbort=null;this.eventRetryAt=this.now()+30000;});
  }

  private async cloudRoutines(bot:RuntimeIdentity){
    const state=await this.rpc('GetSandBoxRunState',{});
    if(state.state==='SAND_BOX_RUN_STATE_HIBERNATED')return this.computerRoutines.get(bot.agentId)??[];
    const current=await this.gateway(bot,'getAgentAutomations',{},false);
    if(!Array.isArray(current))throw new Error('The computer returned an invalid routine list.');
    this.computerRoutines.set(bot.agentId,current);return current;
  }
  private async resources(bot: RuntimeIdentity) {
    const agentId = bot.agentId;
    const requests = [
      ['automations', 'ListGrokBotAgentAutomations'], ['skills', 'ListGrokBotAgentSkills'],
      ['files', 'ListGrokBotAgentFiles'], ['store', 'ListGrokBotUserStoreFiles'],
      ['memory', 'ListGrokBotUserBotMemories'], ['library', 'ListGrokBotLibraryDocs'], ['plugins', 'GetGrokBotAgentPlugins'],
      ['availablePlugins', 'GetEffectiveUserPlugins', 'aiserver.v1.DashboardService'], ['settings', 'GetGrokBotUserMcpSettings'],
      ['availableSkills','ListGrokBotUserSkills'], ['pins','ListGrokBotLibraryPins'],
    ];
    const loaded = await Promise.allSettled(requests.map(([, method, service]) => this.rpc(method, method === 'GetEffectiveUserPlugins' ? {excludeConfiguredVariables:true} : ['GetGrokBotUserMcpSettings','ListGrokBotUserSkills'].includes(method) ? {} : { agentId, ...(method === 'ListGrokBotAgentFiles' ? { pageToken: '' } : {}) },service)));
    this.assertOpen();
    const signedOut=loaded.find(r=>r.status==='rejected'&&r.reason instanceof Error&&r.reason.name==='SignedOutError');
    if(signedOut?.status==='rejected')throw signedOut.reason;
    const warnings: string[] = [], data: Record<string, any> = {...this.resourceData.get(agentId)};
    loaded.forEach((result, i) => { const key = requests[i][0]; if (result.status === 'fulfilled') data[key] = result.value; else warnings.push(`${key}: ${connectionProblem(result.reason).message}`); });
    this.resourceData.set(agentId,data);
    const routines = rows(data.automations, 'automations').map((r) => {
      const saved = json(r.recordJson ?? r);
      return { id: text(r.automationId) || text(saved.id), name: text(saved.name) || 'Routine', spec: saved, enabled: saved.isEnabled !== false, permissions: r.viewerPermissions ?? null,source:'account' };
    });
    try { for(const r of await this.cloudRoutines(bot)){if(!routines.some(existing=>existing.id===r.id||existing.spec.id===r.id))routines.push({id:text(r.id),name:text(r.name)||'Routine',spec:r,enabled:r.isEnabled!==false,permissions:null,source:'computer'});} }catch(error){warnings.push(`computer routines: ${connectionProblem(error).message}`);}
    const skills = rows(data.skills, 'skills').map((s) => ({ id: text(s.id) || text(s.name), name: text(s.name), description: text(s.description), content: text(s.body) || text(s.content), readOnly: s.readOnly === true, source: text(s.source) }));
    const files = [['files', 'agent'], ['store', 'store']].flatMap(([key, source]) => rows(data[key], 'files').map((f) => ({ id: `${source}:${f.path}`, name: text(f.name), path: text(f.path), sizeBytes: Number.isSafeInteger(Number(f.sizeBytes)) && Number(f.sizeBytes)>=0 ? Number(f.sizeBytes) : 0, source })));
    const selected=rows(data.plugins,'plugins');
    const pluginChoices=new Map<string,any>();
    for(const p of rows(data.availablePlugins,'plugins')){
      const id=String(p.plugin?.id??'');if(!id)continue;
      pluginChoices.set(id,{id,name:text(p.plugin?.displayName)||text(p.plugin?.name),enabled:false,managed:false});
    }
    for(const p of selected){
      const id=String(p.pluginId??p.plugin?.id??p.id??'');
      pluginChoices.set(id,{id,name:text(p.displayName)||text(p.plugin?.displayName)||text(p.name)||text(p.plugin?.name),enabled:p.isEnabled!==false,managed:p.ownedByMarketplace===true||!id||id==='0'});
    }
    const zone=text(data.settings?.settings?.userTimeZoneOverride)||text(data.settings?.settings?.userTimeZone);
    return { bot, routines, skills, availableSkills:rows(data.availableSkills,'skills').map(s=>({id:text(s.id)||text(s.name),name:text(s.name),description:text(s.description),content:text(s.body),source:text(s.source),readOnly:true})), files, memory: data.memory ?? {}, library: {...(data.library??{}),pins:rows(data.pins,'pins')}, plugins:{plugins:[...pluginChoices.values()]}, timeZone:zone||null,warnings,nextFilesPage:data.files?.nextPageToken||null };

  }
  private safeComputer(status: any) {
    return { state: text(status.state) || 'unknown', hasViewer: !!status.vncUrl, handoff: status.handoff ? { requestId: text(status.handoff.requestId), reason: text(status.handoff.reason) } : null,
      monitors: (Array.isArray(status.windows) ? status.windows : []).map((w: any) => ({ id: text(w.subagentId) || String(w.windowIndex ?? w.id ?? ''), title: text(w.title) || 'Screen', hasViewer: !!w.vncUrl })) };
  }
  /** Used by the scoped viewer manager only; not serialized to the native command reply. */
  async computerConnection(botId: string, wake: boolean) {
    const bot = await this.identity(botId);
    const status = await this.gateway(bot, wake ? 'ensureForeverBox' : 'getForeverBoxStatus', {}, wake);
    if (!status?.vncUrl || status.state !== 'running') throw new Error('The bot’s computer screen is not ready. Wait a moment and connect again.');
    return { bot, status, box: this.box };
  }
  async command(botId: string, action: string, args: Record<string, unknown> = {}): Promise<any> {
    const mutations = ['cardControl','routineCreate','routineUpdate','routineDelete','routineEnable','routineRun','handBack','teachStart','teachStop','pluginEnable','skillCreate','skillUpdate','skillDelete','skillEnable','memoryShare','libraryPin','cardDecision','cardRespond','draftSend','draftDiscard','phoneControl','paymentBegin','paymentFinish','mcpCall','fileUploadBegin','fileUploadFinish'];
    if (!mutations.includes(action)) return this.execute(botId, action, args);
    const bot = await this.identity(botId);
    if (this.writing.has(bot.agentId)) throw new Error('A change for this bot is already running. Wait for its result.');
    this.writing.add(bot.agentId);
    try {
      const result = await this.execute(botId, action, args);
      if (result?.accepted === false || result?.refusal) throw new Error('The provider refused this request. Refresh its permissions and current state.');
      return result;
    } finally { this.writing.delete(bot.agentId); }
  }
  private async execute(botId: string, action: string, args: Record<string, unknown> = {}): Promise<any> {
    this.assertOpen();
    const bot = await this.identity(botId);
    if (action === 'fileChunk') return this.files.chunk(botId,args);
    if (action === 'fileDownloadBegin') return this.files.beginDownload(bot,args.path);
    if (action === 'fileUploadBegin') return this.files.beginUpload(bot,args);
    if (action === 'fileUploadFinish') return this.files.finishUpload(bot,args.id);
    if (action === 'filesPage') return this.rpc('ListGrokBotAgentFiles',{agentId:bot.agentId,pageToken:requiredText(args.pageToken,'Page cursor',2000)});
    if(action==='appearanceOptions')return this.controls.appearance(bot);
    if(action==='sharingStatus'){
      const result=await this.rpc('GetGrokBotAgentInPlaceShareStatus',{agentId:bot.agentId});
      return {state:text(result.state),shared:result.shared===true,failureReason:text(result.failureReason)};
    }
    if(action==='cardControl'){
      const id=requiredText(args.id,'Card',500);
      const current=workCards(await this.currentCardPage(bot,id,args.seq)).cards.find(c=>c.id===id);
      return this.controls.command(bot,args,current);
    }
    if (action === 'resources') {this.startEvents();return this.resources(bot);}
    if (action === 'computerStatus') {
      const state = await this.rpc('GetSandBoxRunState', {});
      if (state.state === 'SAND_BOX_RUN_STATE_HIBERNATED') return { state: 'asleep', hasViewer: false, handoff: null, monitors: [] };
      return this.safeComputer(await this.gateway(bot, 'getForeverBoxStatus', {}, false));
    }
    if (action === 'computerConnect') return this.safeComputer((await this.computerConnection(botId, true)).status);
    if (action === 'activity') {
      this.startEvents();
      const beforeSeq=Number.isSafeInteger(args.beforeSeq)?Number(args.beforeSeq):undefined;
      try {
        const result=workCards(await this.rpc('ListGrokBotTranscriptEntries',{agentId:bot.agentId,limit:100,...(beforeSeq===undefined?{}:{beforeSeq:String(beforeSeq)})}));
        this.o.saveActivity?.(bot.agentId,result.cards);return {...result,stale:false};
      }catch(error){
        if(error instanceof Error&&error.name==='SignedOutError')throw error;
        const cards=this.o.loadActivity?.(bot.agentId,beforeSeq);
        if(!cards?.length)throw error;
        return {cards,beforeSeq:Math.min(...cards.map(c=>c.seq)),stale:true,warning:'Offline saved activity. Refresh to load results and current permissions.'};
      }
    }
    if(action==='teachStatus'){
      const state=await this.rpc('GetSandBoxRunState',{});
      if(state.state==='SAND_BOX_RUN_STATE_HIBERNATED')return {state:'idle',owned:false,startedAtMs:null};
      const status=await this.gateway(bot,'getTeachRecordingStatus',{},false);
      return {state:text(status.state)||'unknown',owned:status.agentId===bot.agentId,startedAtMs:Number(status.startedAtMs)||null};
    }
    if(action==='skillEnable'){
      const id=requiredText(args.id,'Skill',500);
      const available=rows(await this.rpc('ListGrokBotUserSkills',{}),'skills').find(s=>(s.id||s.name)===id);
      if(!available)throw new Error('This skill is no longer available. Refresh skills.');
      const current=rows(await this.rpc('ListGrokBotAgentSkills',{agentId:bot.agentId}),'skills');
      if(current.some(s=>s.name===available.name))throw new Error('This skill is already enabled for this bot.');
      return this.rpc('AddGrokBotAgentSkill',{agentId:bot.agentId,name:requiredText(available.name,'Skill name',500),description:text(available.description),content:requiredText(available.body,'Skill content',500000)});
    }
    if(action==='memoryShare'){
      const id=requiredText(args.id,'Memory',500);
      const available=rows(await this.rpc('ListGrokBotUserBotMemories',{agentId:bot.agentId}),'memories');
      if(!available.some(m=>m.factId===id))throw new Error('This memory is no longer available to this bot.');
      return this.rpc('PromoteGrokBotMemoriesToTeam',{agentId:bot.agentId,factIds:[id]});
    }
    if(action==='libraryPin'){
      const id=requiredText(args.id,'Library result',2000);
      if(typeof args.enabled!=='boolean')throw new Error('Choose a pinned state.');
      const available=rows(await this.rpc('ListGrokBotLibraryDocs',{agentId:bot.agentId}),'docs');
      if(!available.some(d=>d.key===id))throw new Error('This result is no longer available to this bot.');
      return this.rpc('SetGrokBotLibraryPin',{agentId:bot.agentId,pin:{externalDocKey:id},isPinned:args.enabled});
    }
    if (action === 'routines') return (await this.resources(bot)).routines;
    const commands: Record<string, string> = { routineCreate: 'createAgentAutomation', routineUpdate: 'updateAgentAutomation', routineDelete: 'deleteAgentAutomation', routineEnable: 'setAgentAutomationEnabled', routineRun: 'runAgentAutomationNow', handBack: 'handBackForeverBox', teachStart: 'startTeachRecording', teachStop: 'stopTeachRecording' };
    if(action==='mcpOpen'||action==='mcpCall'){
      const id=requiredText(args.id,'App document',500);
      const page=await this.currentCardPage(bot,id,args.seq);
      const current=workCards(page).cards.find(c=>c.id===id);
      if(!current||current.kind!=='mcp-app')throw new Error('This app document is no longer available to this bot.');
      const body={agentId:bot.agentId,entryId:current.id,sessionId:current.sessionId};
      if(action==='mcpOpen'){
        const result=await this.rpc('ReadGrokBotMcpAppDocument',body);
        if(typeof result.html!=='string'||result.html.length>4*1024*1024)throw new Error('This app document is unavailable or exceeds its size limit.');
        let source:any={};
        for(const entry of rows(page,'entries')){try{const parsed=JSON.parse(Buffer.from(entry.body,'base64').toString('utf8'));if(parsed.id===id){source=parsed;break;}}catch{}}
        return {html:result.html,metaJson:typeof result.metaJson==='string'?result.metaJson:'{}',toolArgumentsJson:typeof source.toolArgumentsJson==='string'?source.toolArgumentsJson:'{}',toolResultJson:typeof source.toolResultJson==='string'?source.toolResultJson:'{}'};
      }
      if(args.userConfirmed!==true)throw new Error('Confirm this app’s tool request before running it.');
      const toolName=requiredText(args.toolName,'App tool',500),input=record(args.arguments);
      const argumentsJson=JSON.stringify(input);
      if(argumentsJson.length>500000)throw new Error('The app’s tool input exceeds its size limit.');
      const result=await this.rpc('CallGrokBotMcpAppTool',{...body,toolName,argumentsJson,userActivated:true});
      if(result.failure)throw new Error('The app tool was refused or failed. Check its permissions and current state.');
      if(typeof result.resultJson!=='string'||result.resultJson.length>4*1024*1024)throw new Error('The app returned an invalid tool result.');
      return {resultJson:result.resultJson};
    }
    if(['paymentMethods','paymentBegin','paymentFinish'].includes(action)){
      const id=requiredText(args.id,'Payment card',500);
      const current=workCards(await this.currentCardPage(bot,id,args.seq)).cards.find(c=>c.id===id);
      if(action==='paymentMethods')return this.payments.methods(current);
      if(action==='paymentBegin')return this.payments.begin(bot,current,args.paymentMethodId);
      return this.payments.finish(bot,current,args.ceremonyId);
    }
    if(action==='phoneControl'){
      const id=requiredText(args.id,'Phone call card',500);
      const current=workCards(await this.currentCardPage(bot,id,args.seq)).cards.find(c=>c.id===id);
      const methods:Record<string,string>={hangUp:'HangUpGrokBotOutboundCall',transfer:'TransferGrokBotOutboundCall',retryRecording:'RetryGrokBotOutboundCallRecording'};
      const control=String(args.control);
      if(!current||current.kind!=='phone-call'||!current.actions.includes(control)||!methods[control])throw new Error('This call no longer permits that control. Refresh activity.');
      return this.rpc(methods[control],{outboundCallId:current.details.callId});
    }
    if(action==='draftSend'||action==='draftDiscard'){
      const id=requiredText(args.id,'Draft',500);
      let page:any;
      try {page=await this.currentCardPage(bot,id,args.seq);}
      catch (error) {if(error instanceof Error&&error.name==='SignedOutError')throw error;throw new Error('This draft could not be loaded. Refresh activity before trying again.');}
      const current=workCards(page).cards.find(c=>c.id===id);
      const operation=action==='draftSend'?'sendDraft':'discardDraft';
      if(!current?.draft||current.sessionId!==args.sessionId||!current.actions.includes(operation))throw new Error('This draft changed or is no longer editable. Refresh activity.');
      // Every send and discard is bound to the exact draft version the person reviewed (route, recipients, attachments, session).
      if(args.revision!==current.draft.revision)throw new Error('This draft changed since you reviewed it. Refresh activity and review it again.');
      const session=current.sessionId?{sessionId:current.sessionId}:{};
      const body:Record<string,unknown>={agentId:bot.agentId,entryId:current.id,...session};
      if(action==='draftSend'){
        Object.assign(body,draftPayload(current,args));
        const attachments=current.draft.attachments as {path:string;sizeBytes:number}[]|undefined??[];
        for(const file of attachments){
          let size=-1;
          try {const read=await this.rpc('ReadGrokBotAgentAttachmentChunk',{path:file.path,offset:'0',length:1,...session});if(read&&typeof read==='object')size=Number(read.totalSize??0);}
          catch (error) {if(error instanceof Error&&error.name==='SignedOutError')throw error;}
          if(size!==file.sizeBytes)throw new Error('An attachment is missing or changed since this draft was written. Refresh activity before sending.');
        }
      }
      let result:any;
      try {result=await this.rpc(action==='draftSend'?'SendGrokBotDraft':'DiscardGrokBotDraft',body);}
      catch (error) {if(error instanceof Error&&error.name==='SignedOutError')throw error;result=null;}
      // Proto JSON omits accepted:false, so only an explicit true is success; a non-object reply is an unknown outcome.
      if(!result||typeof result!=='object')throw new Error('The draft action could not be confirmed. Outcome unknown: check activity before retrying.');
      if(result.accepted!==true||result.refusal)throw new Error('The provider refused this request. Refresh its permissions and current state.');
      return {accepted:true};
    }
    if (action === 'cardRespond') {
      const id=requiredText(args.id,'Card',500);
      const current=workCards(await this.currentCardPage(bot,id,args.seq)).cards.find(c=>c.id===id);
      const operation=args.dismiss===true?'dismiss':'respond';
      if(!current||current.sessionId!==args.sessionId||!current.actions.includes(operation))throw new Error('This request is stale or no longer pending. Refresh activity.');
      const body:Record<string,unknown>={agentId:bot.agentId,entryId:current.id,sessionId:current.sessionId};
      let method='';
      if(current.kind==='widget'){
        method=operation==='dismiss'?'DismissGrokBotWidget':'RespondGrokBotWidget';
        if(operation==='respond'){
          const answers=current.multiSelect?args.values: [args.value];
          if(!Array.isArray(answers)||!answers.length||answers.length>100)throw new Error('Choose at least one answer.');
          const checked=[...new Set(answers.map(v=>requiredText(v,'Answer',10000).trim()))];
          const value=checked.join('\n');
          if(!current.allowCustom&&checked.some(v=>!current.options.some(o=>o.value===v)))throw new Error('Choose one of this question’s current options.');
          body.value=value;
        }
      }else if(current.kind==='secret-request'){
        method='SubmitGrokBotSecret';body.value=requiredText(args.value,'Secret',100000);
      }else{
        body.platform=1;
        if(operation==='dismiss'){method='DismissGrokBotUserForm';body.mode=1;}
        else{
          method='SubmitGrokBotUserForm';const values=record(args.values),clean:Record<string,string>={};
          for(const field of current.fields){
            const value=values[field.id]??'';
            if(typeof value!=='string'||value.length>100000)throw new Error('Enter valid form values.');
            if(field.required&&!(field.type==='checkbox'?value==='true':value.trim()))throw new Error('Complete the required fields.');
            if(value&&field.type==='select'&&!field.options.some(o=>o.value===value))throw new Error('Choose a current form option.');
            clean[field.id]=value;
          }
          if(Object.keys(values).some(key=>!current.fields.some(f=>f.id===key)))throw new Error('The form fields changed. Refresh before submitting.');
          body.values=clean;body.saveToVault=false;
        }
      }
      try { return await this.rpc(method,body); }
      catch (error) { if(error instanceof Error&&error.name==='SignedOutError')throw error;throw new Error('The response could not be confirmed. Outcome unknown: refresh this request before retrying.'); }
    }
    if (action === 'cardDecision') {
      const id = requiredText(args.id, 'Card', 500);
      if (!['approve', 'deny'].includes(String(args.decision))) throw new Error('Choose approve or deny.');
      const current = workCards(await this.currentCardPage(bot,id,args.seq)).cards.find(c=>c.id===id);
      if (!current || current.requestId !== args.requestId || !current.actions.includes(String(args.decision))) throw new Error('This request is stale or no longer pending. Refresh activity.');
      const methods:Record<string,string>={'local-tool-permission':'ResolveGrokBotLocalToolPermission','auto-review-approval':'ResolveGrokBotAutoReviewApproval','meeting-join-consent':'ResolveGrokBotAutoReviewApproval','connector-grant':'ResolveGrokBotConnectorGrant','credential-request':'ResolveGrokBotCredentialRequest','virtual-card-approval':'ResolveGrokBotVirtualCardApproval'};
      const method=methods[current.kind];
      const body:Record<string,unknown>={agentId:bot.agentId,entryId:current.id,requestId:current.requestId,resolution:args.decision==='approve'?1:2,...(current.sessionId?{sessionId:current.sessionId}:{})};
      if(['auto-review-approval','meeting-join-consent'].includes(current.kind))body.approvalPlatform='desktop';
      if(current.kind==='credential-request'&&current.details.confirmedAddSite){
        if(args.decision==='approve'&&args.confirmedAddSite!==current.details.confirmedAddSite)throw new Error('Confirm the exact site before sharing this credential.');
        body.confirmedAddSite=current.details.confirmedAddSite;
      }
      if(current.kind==='virtual-card-approval'&&args.decision==='approve')throw new Error('Payment approval requires its secure verification flow.');
      return this.rpc(method,body);
    }
    if (commands[action]) {
      let body: Record<string, unknown> = {};
      let routineSource='computer';
      let routineToolId: string | undefined;
      if (action.startsWith('routine')) {
        if (action !== 'routineCreate') {
          const id = requiredText(args.id, 'Routine', 500);
          const current = (await this.resources(bot)).routines.find((r: any) => r.id === id);
          if (!current) throw new Error('This routine no longer belongs to this bot. Refresh its routines.');
          const permission = action === 'routineUpdate' ? 'EDIT' : action === 'routineDelete' ? 'DELETE' : action === 'routineEnable' ? 'TOGGLE' : 'OPEN';
          if (Array.isArray(current.permissions?.allowedActions) && !current.permissions.allowedActions.some((p: unknown)=>typeof p==='string' && p.endsWith('_'+permission))) throw new Error('You do not have permission to change this routine.');
          body.automationId = id; routineSource=current.source;
          routineToolId = text(current.spec.id) || id;
        }
        if (action === 'routineCreate' || action === 'routineUpdate') {
          const invalid = argumentError(specSchema, args.spec); if (invalid) throw new Error(invalid);
          const spec = record(args.spec), trigger = record(spec.trigger);
          if (trigger.timeZone !== undefined) throw new Error('Routines use the account timezone. Remove the unsupported trigger timezone.');
          if (trigger.type === 'cron' && (typeof trigger.schedule !== 'string' || !trigger.schedule.trim())) throw new Error('A cron schedule is required.');
          if (!['cron','slack','github','origin','microsoftTeams','linear','sentry','pagerduty','email','webhook','event_source','group'].includes(trigger.type)) throw new Error('Choose a supported provider trigger.');
          body.spec = spec;
        }
        if (action === 'routineEnable') { if (typeof args.enabled !== 'boolean') throw new Error('Choose an enabled state.'); body.isEnabled = args.enabled; }
      } else if (action === 'handBack') {
        const requestId = requiredText(args.requestId, 'Handoff request', 500);
        const current = await this.gateway(bot, 'getForeverBoxStatus', {}, false);
        if (current.handoff?.requestId !== requestId) throw new Error('This handoff is stale. Refresh the computer before handing it back.');
        body = { requestId, trigger: args.trigger === 'viewer-closed' ? 'viewer-closed' : 'button' };
      } else {
        const current=await this.gateway(bot,'getTeachRecordingStatus',{},action==='teachStart');
        if(action==='teachStart'&&current.state==='recording')throw new Error('The computer is already recording a lesson. Stop it before starting another.');
        if(action==='teachStop'&&(current.state!=='recording'||current.agentId!==bot.agentId))throw new Error('This recording is inactive or belongs to another bot.');
        body=action==='teachStart'?{agentId:bot.agentId,entryPoint:'fullscreen_title_bar'}:{agentId:bot.agentId,save:args.save===true,desktopSendsPrompt:false};
      }
      if(this.o.submitRoutine&&(action==='routineCreate'||action==='routineUpdate'&&routineSource==='account')){
        return this.o.submitRoutine(bot,action==='routineCreate'?'create':'update',record(body.spec),routineToolId);
      }
      const accountMethods:Record<string,string>={routineDelete:'DeleteGrokBotAgentAutomation',routineEnable:'SetGrokBotAgentAutomationEnabled',routineRun:'RunGrokBotAgentAutomationNow'};
      if(accountMethods[action]&&routineSource==='account'){
        const result=await this.rpc(accountMethods[action],{agentId:bot.agentId,...body});
        this.computerRoutines.delete(bot.agentId);return result;
      }
      const result=await this.gateway(bot,commands[action],body,true,true);
      if(action.startsWith('routine')&&Array.isArray(result))this.computerRoutines.set(bot.agentId,result);
      return result;
    }
    if (action === 'pluginEnable') {
      const pluginId = requiredText(args.id,'Plugin',100); if (!/^[1-9]\d*$/.test(pluginId)||typeof args.enabled!=='boolean') throw new Error('Choose an app and enabled state.');
      const current = await this.rpc('GetGrokBotAgentPlugins',{agentId:bot.agentId,includeMcpConfig:true});
      const selected = rows(current,'plugins');
      if(selected.some(p=>String(p.pluginId)===pluginId&&p.ownedByMarketplace))throw new Error('This app is managed by the bot’s marketplace.');
      const plugins = selected.filter(p=>String(p.pluginId)!==pluginId).map(p=>{
        if(p.pluginId&&String(p.pluginId)!=='0')return {pluginId:String(p.pluginId)};
        if(typeof p.mcpConfigJson!=='string')throw new Error('This inline app’s configuration is unavailable. Refresh before changing apps.');
        return {inline:{name:text(p.name),displayName:text(p.displayName),description:text(p.description),mcpConfigJson:p.mcpConfigJson}};
      });
      if(args.enabled)plugins.push({pluginId});
      return this.rpc('SetGrokBotAgentPlugins',{agentId:bot.agentId,plugins});
    }
    const skills: Record<string, string> = { skillCreate: 'AddGrokBotAgentSkill', skillUpdate: 'UpdateGrokBotAgentSkill', skillDelete: 'RemoveGrokBotAgentSkill' };
    if (skills[action]) {
      const name = requiredText(args.name, 'Skill name', 500);
      if (action !== 'skillCreate') {
        const current = rows(await this.rpc('ListGrokBotAgentSkills', {agentId:bot.agentId}), 'skills').find(s=>s.name===name);
        if (!current || current.readOnly === true) throw new Error('This skill is unavailable or read-only. Refresh skills.');
      }
      const body: Record<string, unknown> = { agentId: bot.agentId, name };
      if (action !== 'skillDelete') { body.content = requiredText(args.content, 'Skill content', 500000); if (typeof args.description === 'string') body.description = args.description; }
      return await this.rpc(skills[action], body);
    }
    throw new Error('Unknown bot workspace action.');
  }
  close() { this.closed = true; this.eventAbort?.abort(); this.box = null; this.resourceData.clear(); this.computerRoutines.clear(); this.files.close(); this.payments.close(); }
}
