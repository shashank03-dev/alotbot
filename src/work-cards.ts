/** Safe, display-only transcript projection. Never forward arbitrary card objects or secret values. */
export interface WorkCard {
  id: string; seq: number; kind: string; title: string; text: string; status: string;
  draft: Record<string,unknown>|null;
  details:Record<string,string>; links:{label:string;url:string}[]; multiSelect:boolean; nativeRequired:boolean;
  fields: {id:string;label:string;type:string;required:boolean;options:{label:string;value:string}[]}[]; allowCustom:boolean;
  requestId: string; sessionId: string; actions: string[]; options: {label:string;value:string}[];
}
import {createHash} from 'node:crypto';
const text = (v: unknown, max = 20000) => typeof v === 'string' ? v.slice(0,max) : '';
/** Largest attachment the provider's draft composer accepts (native composer limit). */
export const DRAFT_ATTACHMENT_MAX=10*1024*1024;
/** True when a provider value would be cut by the projection, so sending it would silently change it. */
const overLimit=(v:unknown,len:number,max=1)=>Array.isArray(v)?v.length>max||v.some(x=>typeof x==='string'&&x.length>len):typeof v==='string'&&v.length>len;
const httpsUrl=(v:unknown)=>{if(typeof v!=='string'||v.length>2000)return false;try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};
const LIMIT_REASON='This draft has more recipients or longer fields than Alotbot can send unchanged. Review it in Grok Bot.';
const strings=(v:unknown,max:number,len:number)=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string').slice(0,max).map(x=>x.slice(0,len)):[];
const plain=(html:string)=>html.replace(/<br\b[^>]*>|<\/(?:p|div|tr)>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/\n{3,}/g,'\n\n').trim().slice(0,2000);
/**
 * Draft projection mirrors Grok Bot's native composer: email routing comes from the verified route, Slack
 * destinations from the verified channel, and attachments stay server-held on the entry (the send request has
 * no attachment field). Anything Alotbot cannot send faithfully carries an honest blockedReason instead.
 */
function projectDraft(kind:string,message:any,body:any):Record<string,unknown>{
  const d=message.draft,route=body.draftRoute&&typeof body.draftRoute==='object'?body.draftRoute:{},verified=body.draftRouteVerified&&typeof body.draftRouteVerified==='object'?body.draftRouteVerified:{};
  if(kind==='email-draft'){
    const emailRoute=route.platform==='email'?route:{},emailVerified=verified.platform==='email'?verified:null;
    const sendingAddresses=emailVerified?[...new Set([...strings(emailVerified.sendingAddresses,20,320),...(typeof emailVerified.sendingAddress==='string'?[emailVerified.sendingAddress.slice(0,320)]:[])])]:[];
    const drafted=text(d.from,1000),from=emailVerified?sendingAddresses.find(a=>a.toLowerCase()===drafted.toLowerCase())??(typeof emailVerified.sendingAddress==='string'?emailVerified.sendingAddress.slice(0,320):''):drafted;
    const raw=emailRoute.attachments,attachments:{filename:string;path:string;sizeBytes:number}[]=[];let blockedReason='';
    if(raw!==undefined&&raw!==null){
      const valid=Array.isArray(raw)&&raw.length<=25&&raw.every((a:any)=>a&&typeof a==='object'&&typeof a.path==='string'&&a.path.length>0&&a.path.length<=4096&&!a.path.includes('\0')&&Number.isSafeInteger(a.sizeBytes)&&a.sizeBytes>=0);
      if(!valid)blockedReason='This draft’s attachments are in a format Alotbot can’t verify. Send or edit it in Grok Bot.';
      else for(const a of raw)attachments.push({filename:text(a.filename,500)||a.path.split('/').pop()||'Attachment',path:a.path,sizeBytes:a.sizeBytes});
      if(attachments.some(a=>a.sizeBytes>DRAFT_ATTACHMENT_MAX))blockedReason='An attachment is larger than 10 MB, so this draft can’t be sent.';
    }
    if(overLimit(d.to,1000,100)||overLimit(d.cc,1000,100)||overLimit(d.subject,2000)||!emailVerified&&overLimit(d.from,1000))blockedReason=LIMIT_REASON;
    if(emailRoute.macMail!=null)blockedReason='This draft sends through Mail on a specific Mac. Send it from Grok Bot on that Mac.';
    else if(emailVerified&&!from)blockedReason='The sending account for this draft couldn’t be verified. Review it in Grok Bot.';
    const signatureHtml=typeof emailRoute.signatureHtml==='string'&&emailRoute.signatureHtml.length<=200000?emailRoute.signatureHtml:undefined;
    return {from,to:strings(d.to,100,1000),cc:strings(d.cc,100,1000),subject:text(d.subject,2000),body:text(d.body,100000),sendingAddresses,attachments,
      ...(signatureHtml===undefined?{}:{signatureHtml,signature:plain(signatureHtml)}),
      ...(typeof emailVerified?.replyTo==='string'?{replyTo:text(emailVerified.replyTo,1000)}:{}),...(typeof emailVerified?.forwarding==='string'?{forwarding:text(emailVerified.forwarding,1000)}:{}),
      ...(httpsUrl(emailVerified?.replyToUrl)?{replyToUrl:emailVerified.replyToUrl}:{}),
      ...(blockedReason?{blockedReason}:{})};
  }
  if(kind==='slack-draft'){
    const v=verified.platform==='slack'?{workspace:verified.workspace,target:verified.channelName,thread:verified.thread}:d;
    const target=text(v.target,500),blockedReason=!target?'This Slack draft has no verified destination. Review it in Grok Bot.':[v.workspace,v.target,v.thread].some(x=>overLimit(x,500))?LIMIT_REASON:'';
    return {workspace:text(v.workspace,500),target,thread:text(v.thread,500),body:text(d.body,100000),verifiedRoute:verified.platform==='slack',...(blockedReason?{blockedReason}:{})};
  }
  if(kind==='meeting-chat-draft'){
    const meetingId=text(d.meetingId,500),privateTo=d.privateTo===undefined?'':text(d.privateTo,500)||'a private recipient';
    return {meetingId,meetingTitle:text(d.meetingTitle,500),privateTo,recipientName:text(d.recipientName,500),body:text(d.body,100000),markInternal:message.meetingInternal===true,canMarkInternal:!privateTo&&message.meetingInternal!==true,
      ...(!meetingId?{blockedReason:'This meeting message has no meeting to send to. Review it in Grok Bot.'}:overLimit(d.meetingId,500)||overLimit(d.meetingTitle,500)?{blockedReason:LIMIT_REASON}:{})};
  }
  return {to:text(d.to,1000),chatId:text(d.chatId,500),recipientName:text(d.recipientName,500),body:text(d.body,100000),
    blockedReason:'iMessage drafts need a fresh Messages approval on the Mac that sends them. Send it from Grok Bot on that Mac.'};
}
const titles: Record<string,string> = {
  text:'Message', widget:'Question', 'auto-review-approval':'Action approval', 'local-tool-permission':'Mac permission',
  'user-form':'Information requested', 'secret-request':'Secret requested', 'credential-request':'Credential requested',
  attachment:'File result', visualization:'Visualization', 'email-draft':'Email draft', 'slack-draft':'Slack draft',
  'imessage-draft':'Message draft', 'meeting-chat-draft':'Meeting message draft', connector:'App connection',
  'cookie-origin-approval':'Browser access', 'connector-grant':'App permission', 'virtual-card-approval':'Payment approval',
  'meeting-join-consent':'Meeting approval', 'phone-call':'Phone call', 'bot-resources':'Bot resources',
  'appearance-picker':'Bot appearance','email-offer':'Bot email address','notifications-enable':'Notifications','publish-approval':'Publish app','team-access':'Team access',
};
export function workCards(result: any): {cards:WorkCard[];beforeSeq:number|null} {
  const cards:WorkCard[]=[];
  for(const entry of Array.isArray(result?.entries)?result.entries:[]) {
    if(!entry||typeof entry!=='object'||typeof entry.body!=='string'||entry.body.length>4*1024*1024)continue;
    const seq=Number(entry.seq); if(!Number.isSafeInteger(seq))continue;
    let body:any;
    try { body=JSON.parse(Buffer.from(entry.body,'base64').toString('utf8')); } catch { continue; }
    if(!body||typeof body!=='object'||Array.isArray(body))continue;
    const message=body.message??{},kind=text(message.type||body.event?.type||body.kind,100);
    const detail=message.approval??message.ask??message.widget??message.formRequest??message.secretRequest??message.credentialRequest??message.call??body.event??{};
    let status=text(detail.status,100)||(body.kind==='event'?'info':'unresolved');
    if(kind==='widget') status=body.respondedValue!=null?'answered':body.widgetDismissed===true?'dismissed':'pending';
    if(kind==='user-form') status=body.formResolution==null?'pending':text(body.formResolution,100)||'resolved';
    if(kind==='credential-request')status=body.credentialResolution==null||body.credentialResolution==='retryable'?'pending':text(body.credentialResolution,100);
    if(kind==='secret-request') status=body.secretProvided===true?'provided':'pending';
    const requestId=text(detail.requestId,500), id=text(body.id,500);
    const draftKinds=['email-draft','slack-draft','meeting-chat-draft','imessage-draft'];
    // Native email cards read draftSendState, then draftSaveState (saving/saved drafts are not sendable).
    if(draftKinds.includes(kind))status=text(body.draftSendState,100)||(kind==='email-draft'?text(body.draftSaveState,100):'')||'editable';
    const pending=status==='pending';
    let actions=pending&&requestId&&id&&['auto-review-approval','local-tool-permission','meeting-join-consent','connector-grant','virtual-card-approval'].includes(kind)?['approve','deny']:[];
    const options=kind==='widget'&&Array.isArray(detail.options)?detail.options.slice(0,100).filter((o:any)=>o&&typeof o==='object').flatMap((o:any)=>typeof o.label==='string'?[{label:text(o.label,500),value:text(o.value??o.label,2000)}]:[]):[];
    const fields=kind==='user-form'&&Array.isArray(detail.fields)?detail.fields.slice(0,100).filter((f:any)=>f&&typeof f==='object').map((f:any)=>({id:text(f.id,200),label:text(f.label,500),type:text(f.type,100),required:f.required===true,options:Array.isArray(f.options)?f.options.slice(0,100).filter((o:any)=>o&&typeof o==='object').map((o:any)=>({label:text(o.label,500),value:text(o.value,2000)})):[]})):[];
    const formSupported=fields.length>0&&detail.fields.length===fields.length&&detail.saveToVault!=='card'&&!fields.some((f:any)=>/^(cc_|billing_)/.test(f.id))&&fields.every((f:any)=>f.id&&['text','email','password','tel','number','textarea','select','checkbox'].includes(f.type));
    if(pending&&id&&((kind==='widget'&&!detail.order&&!detail.ruleChange&&!detail.resourceRemoval)||(kind==='user-form'&&formSupported&&!message.phoneCallQuestion)||(kind==='secret-request'&&message.secretRequest)))actions=['respond',...(kind==='secret-request'?[]:['dismiss'])];
    let draft:Record<string,unknown>|null=null;
    if(draftKinds.includes(kind)&&message.draft&&typeof message.draft==='object'){
      draft=projectDraft(kind,message,body);
      if(id&&status==='editable')actions=draft.blockedReason?['discardDraft']:['sendDraft','discardDraft'];
      draft.revision=createHash('sha256').update(JSON.stringify([id,kind,status,text(body.sessionId,500),draft])).digest('hex').slice(0,32);
    }
    const details:Record<string,string>={};
    for(const key of ['summary','goal','purpose','targetSite','merchantName','currency','title','toDisplay','name','origin','connector','serverName','accountName','failureReason','target','description','action','recipientName'])if(typeof detail[key]==='string')details[key]=text(detail[key],5000);
    if(Number.isSafeInteger(detail.amountCents)&&detail.amountCents>=0)details.amountCents=String(detail.amountCents);
    if(typeof detail.networkId==='string')details.networkId=text(detail.networkId,500);
    if(typeof detail.addSite?.registrableDomain==='string')details.confirmedAddSite=text(detail.addSite.registrableDomain,500);
    if(kind==='phone-call'){
      status=text(detail.status,100)||'unknown';details.callId=text(detail.callId,500);
      if(id&&details.callId){actions=status==='ended'?['retryRecording']:['hangUp','transfer'];}
    }
    const nativeRequired=['cookie-origin-approval','mobile-tool-permission','onepassword-connect'].includes(kind)||kind==='credential-request'&&typeof detail.appLink==='string'&&detail.appLink.startsWith('onepassword://');
    if(kind==='credential-request'&&status==='pending'&&id&&!nativeRequired)actions=['approve','deny'];
    const links:{label:string;url:string}[]=[];
    const addLink=(url:unknown,label:string)=>{if(typeof url!=='string')return;try{const parsed=new URL(url);if(parsed.protocol==='https:'&&!parsed.username&&!parsed.password)links.push({label,url:parsed.href});}catch{}};
    if(['attachment','visualization','cursor-agent','calendar-event','bot-template-share','phone-call'].includes(kind)){
      addLink(message.url,text(message.file_name)||text(message.title)||'Open result');
      addLink(message.resultUrl,'Open result');addLink(message.recording?.url,'Play recording');addLink(detail.recording?.url,'Play recording');
    }
    if(['appearance-picker','email-offer','notifications-enable','team-access'].includes(kind)){
      status=message.replaced===true?'replaced':body.respondedValue!=null?'answered':body.widgetDismissed===true?'dismissed':'pending';
      if(id&&status==='pending'){
        actions=kind==='appearance-picker'?['appearanceSave','setupDismiss']:kind==='email-offer'?['emailUse','emailDecline']:kind==='team-access'?['teamShare','teamCopy','setupDismiss']:['notificationSetup','setupDismiss'];
      }
      if(typeof message.email==='string')details.email=text(message.email,1000);
      if(typeof message.reason==='string')details.reason=text(message.reason,5000);
    }
    if(kind==='publish-approval'){
      for(const key of ['bcId','proposalId','slug','apex','visibility'])if(typeof detail[key]==='string')details[key]=text(detail[key],500);
      if(id&&status==='pending'&&details.bcId&&details.proposalId)actions=['publishConfirm','publishDismiss'];
    }
    if(['appearance-picker','email-offer','notifications-enable','team-access','publish-approval'].includes(kind))details.controlRevision=createHash('sha256').update(JSON.stringify([id,kind,status,details])).digest('hex').slice(0,32);
    if(kind==='mcp-app'&&id)actions=['openMcp'];
    if(nativeRequired)actions=['nativeSetup'];
    if(['connector','connectors','scm-connect','slack-connect','listener-connect','app-secrets-request'].includes(kind))actions=['manageConnections'];
    if(kind==='bot-resources')actions=['openKnowledge'];
    if(kind==='desktop-goal')actions=['openComputer'];
    cards.push({id:id||`seq:${seq}`,seq,kind,title:titles[kind]??kind.replaceAll('-',' '),text:['secret-request','credential-request','app-secrets-request'].includes(kind)?'Provide the requested credential through its secure authorization flow.':text(message.content)||text(message.draft?.subject)||text(message.draft?.body)||text(detail.summary)||text(detail.prompt)||text(detail.title)||text(detail.instruction)||text(message.file_name)||text(body.content),status,requestId,sessionId:text(body.sessionId,500),actions,options,fields,draft,details,links,multiSelect:detail.multiSelect===true,nativeRequired,allowCustom:detail.allowCustom===true});
  }
  cards.sort((a,b)=>b.seq-a.seq);
  return {cards,beforeSeq:cards.length?Math.min(...cards.map(c=>c.seq)):null};
}
