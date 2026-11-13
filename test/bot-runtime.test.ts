import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BotRuntime} from '../src/bot-runtime.ts';
import {workCards} from '../src/work-cards.ts';

function fixture(){
 const calls:{method:string,body:any}[]=[];
 const rpc=async(method:string,body:any)=>{calls.push({method,body});if(method==='GetSandBoxRunState')return {state:'SAND_BOX_RUN_STATE_HIBERNATED'};if(method==='ListGrokBotAgentAutomations')return {automations:[{automationId:'routine-1',recordJson:JSON.stringify({name:'Daily',prompt:'Report',trigger:{type:'schedule',schedule:'0 9 * * *',timeZone:'Asia/Kolkata'}})}]};if(method==='ListGrokBotAgentSkills')return {skills:[{id:'skill-1',name:'Research',description:'Find sources'}]};return {}};
 const runtime=new BotRuntime({rpc,identity:async(id:string)=>{if(id!=='bot-1')throw new Error('Unknown bot');return {id,name:'Same name',agentId:'uuid-1'};}});
 return {runtime,calls};
}
test('resources keep real routine and skill identities and do not wake a cloud computer',async()=>{
 const {runtime,calls}=fixture();
 const out=await runtime.command('bot-1','resources');
 assert.equal(out.bot.agentId,'uuid-1');assert.equal(out.routines[0].id,'routine-1');assert.equal(out.routines[0].spec.trigger.timeZone,'Asia/Kolkata');assert.equal(out.skills[0].id,'skill-1');
 assert.ok(calls.every(c=>c.method!=='EnsureSandBox'));assert.ok(calls.filter(c=>c.method.includes('Agent')).every(c=>c.body.agentId==='uuid-1'));
 runtime.close();
});
test('unknown identities/actions never reach a provider and sleeping computers remain asleep',async()=>{
 const {runtime,calls}=fixture();
 await assert.rejects(runtime.command('other','resources'),/Unknown bot/);assert.equal(calls.length,0);
 await assert.rejects(runtime.command('bot-1','arbitraryRPC'),/Unknown/);
 const result=await runtime.command('bot-1','computerStatus');assert.equal(result.state,'asleep');assert.equal(calls.filter(c=>c.method==='EnsureSandBox').length,0);
 runtime.close();await assert.rejects(runtime.command('bot-1','resources'),/closed/);
});

test('file reads require a scoped download and upload tokens cannot cross bot boundaries',async()=>{
 const calls:any[]=[];
 const runtime=new BotRuntime({identity:async(id)=>({id,agentId:'uuid-'+id,name:id}),rpc:async(method,body:any)=>{calls.push({method,body});if(method==='ListGrokBotAgentFiles')return {files:[{name:'proof.txt',path:'/workspace/proof.txt',sizeBytes:5}]};if(method==='ReadGrokBotAgentAttachmentChunk')return {data:Buffer.from('proof').toString('base64'),totalSize:'5'};if(method==='BeginGrokBotAgentFileUpload')return {uploadToken:'provider-secret',url:'https://upload.invalid/file',headers:{},finalName:'proof.txt'};return {}}});
 await assert.rejects(runtime.command('a','fileDownloadBegin',{path:'/outside'}),/not available/);
 const download=await runtime.command('a','fileDownloadBegin',{path:'/workspace/proof.txt'});
 await assert.rejects(runtime.command('b','fileChunk',{id:download.id,offset:0}),/another bot|expired/);
 const data=await runtime.command('a','fileChunk',{id:download.id,offset:0});assert.equal(Buffer.from(data.data,'base64').toString(),'proof');
 const upload=await runtime.command('a','fileUploadBegin',{name:'proof.txt',sizeBytes:5,sha256:'a'.repeat(64)});assert.doesNotMatch(JSON.stringify(upload),/provider-secret/);
 await assert.rejects(runtime.command('b','fileUploadFinish',{id:upload.id}),/another bot|expired/);
 await runtime.command('a','fileUploadFinish',{id:upload.id});assert.equal(calls.at(-1).body.uploadToken,'provider-secret');runtime.close();
});

test('approval commands recheck the exact pending card on the selected bot',async()=>{
 let status='pending'; const calls:any[]=[];
 const runtime=new BotRuntime({identity:async id=>({id,agentId:'uuid-'+id,name:id}),rpc:async(method,body:any)=>{
  calls.push({method,body});
  if(method==='ListGrokBotTranscriptEntries')return {entries:body.agentId==='uuid-a'?[{seq:'1',body:Buffer.from(JSON.stringify({id:'entry',sessionId:'session',message:{type:'auto-review-approval',approval:{status,requestId:'request',summary:'Deploy'}}})).toString('base64')}]:[]};
  return {};
 }});
 await assert.rejects(runtime.command('b','cardDecision',{id:'entry',requestId:'request',decision:'approve'}),/stale/);
 await assert.rejects(runtime.command('a','cardDecision',{id:'entry',requestId:'wrong',decision:'approve'}),/stale/);
 await runtime.command('a','cardDecision',{id:'entry',requestId:'request',decision:'deny'});
 assert.equal(calls.at(-1).method,'ResolveGrokBotAutoReviewApproval');assert.equal(calls.at(-1).body.resolution,2);assert.equal(calls.at(-1).body.sessionId,'session');
 status='approved';await assert.rejects(runtime.command('a','cardDecision',{id:'entry',requestId:'request',decision:'approve'}),/stale/);
 runtime.close();
});
test('mutations lock the bot before asynchronous ownership checks and release after failure',async()=>{
 let release!:()=>void;let reading=false;
 const runtime=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),rpc:async(method)=>{
  if(method==='ListGrokBotAgentSkills'){reading=true;await new Promise<void>(resolve=>{release=resolve});return {skills:[]};}return {};
 }});
 const pending=runtime.command('a','skillDelete',{name:'Missing'});
 while(!reading)await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(runtime.command('a','skillCreate',{name:'New',content:'Body'}),/already running/);
 release();await assert.rejects(pending,/unavailable/);
 await runtime.command('a','skillCreate',{name:'New',content:'Body'});runtime.close();
});
test('downloads discover later pages and refuse cursor loops and changed files',async()=>{
 let loop=false,changed=false;
 const runtime=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),rpc:async(method,body:any)=>{
  if(method==='ListGrokBotAgentFiles')return body.pageToken&& !loop?{files:[{name:'later',path:'/later',sizeBytes:'2'}]}:{files:[],nextPageToken:'next'};
  if(method==='ReadGrokBotAgentAttachmentChunk')return {data:Buffer.from('ok').toString('base64'),totalSize:changed?'3':'2'};
  return {};
 }});
 const download=await runtime.command('a','fileDownloadBegin',{path:'/later'});
 await assert.rejects(runtime.command('a','fileChunk',{id:download.id,offset:3}),/offset/);
 changed=true;await assert.rejects(runtime.command('a','fileChunk',{id:download.id,offset:0}),/changed/);
 loop=true;await assert.rejects(runtime.command('a','fileDownloadBegin',{path:'/later'}),/cursor/);runtime.close();
});

function providerFixture(){
 const calls:any[]=[];let teaching=false;let state:any={state:'running',vncUrl:'http://127.0.0.1:6080/vnc.html',handoff:{requestId:'handoff'},windows:[{windowIndex:0,title:'Main'}]};let failure:Response|Error|null=null;
 const runtime=new BotRuntime({identity:async id=>({id,agentId:'uuid-'+id,name:id}),rpc:async(method,body:any)=>{
  calls.push({method,body});
  if(method==='EnsureSandBox')return {gatewayUrl:'https://gateway.test',gatewayToken:'gateway-secret',networkToken:'network-secret'};
  if(method==='GetSandBoxRunState')return {state:'SAND_BOX_RUN_STATE_RUNNING'};
  if(method==='ListGrokBotAgentAutomations')return {automations:[{automationId:'routine',recordJson:JSON.stringify({id:'routine',name:'Daily',prompt:'Report',trigger:{type:'cron',schedule:'0 9 * * *'}}),viewerPermissions:{allowedActions:['GROK_BOT_AUTOMATION_ACTION_EDIT','GROK_BOT_AUTOMATION_ACTION_DELETE','GROK_BOT_AUTOMATION_ACTION_TOGGLE','GROK_BOT_AUTOMATION_ACTION_OPEN']}}]};
  if(method==='GetGrokBotAgentPlugins')return {plugins:[{pluginId:'1',displayName:'App'}]};
  if(method==='ListGrokBotAgentSkills')return {skills:[{name:'Skill',body:'Instructions',source:'recipe'}]};
  return {};
 },fetch:async(url,options)=>{
  calls.push({method:String(url).split('/').pop(),body:JSON.parse(String(options?.body)),headers:options?.headers});
  if(failure instanceof Error)throw failure;
  if(failure)return failure;
  const method=String(url).split('/').pop();
  if(method==='getTeachRecordingStatus')return Response.json(teaching?{state:'recording',agentId:'uuid-a'}:{state:'idle'});
  if(method==='startTeachRecording')teaching=true;if(method==='stopTeachRecording')teaching=false;
  return Response.json(state);
 }});
 return {runtime,calls,setFailure:(value:Response|Error|null)=>{failure=value},setState:(value:any)=>{state=value}};
}
test('gateway operations force durable bot identity and keep credentials out of computer DTOs',async()=>{
 const {runtime,calls}=providerFixture();
 const status=await runtime.command('a','computerStatus');assert.equal(status.monitors[0].id,'0');assert.doesNotMatch(JSON.stringify(status),/secret|vnc\.html|gateway/);
 assert.equal(calls.at(-1).body.id,'uuid-a');assert.equal(calls.at(-1).headers['x-anyrun-network-token'],'network-secret');
 await runtime.command('a','computerConnect');assert.equal(calls.at(-1).method,'ensureForeverBox');assert.equal(calls.filter(c=>c.method==='EnsureSandBox').length,1);
 await assert.rejects(runtime.command('a','handBack',{requestId:'stale'}),/stale/);
 await runtime.command('a','handBack',{requestId:'handoff'});assert.equal(calls.at(-1).body.trigger,'button');
 await runtime.command('a','teachStart');assert.equal(calls.at(-1).body.entryPoint,'fullscreen_title_bar');
 await runtime.command('a','teachStop',{save:false});assert.equal(calls.at(-1).body.save,false);runtime.close();
});
test('routine controls preserve event specs, use exact ids and report uncertain writes without retry',async()=>{
 const {runtime,calls,setFailure}=providerFixture();
 const spec={name:'New',prompt:'Report',trigger:{type:'github',repo:'owner/repo',events:['pull_request']}};
 await runtime.command('a','routineCreate',{spec});assert.deepEqual(calls.at(-1).body.spec,spec);
 await runtime.command('a','routineUpdate',{id:'routine',spec});assert.equal(calls.at(-1).body.automationId,'routine');
 await runtime.command('a','routineEnable',{id:'routine',enabled:false});assert.equal(calls.at(-1).body.isEnabled,false);
 await runtime.command('a','routineRun',{id:'routine'});assert.equal(calls.at(-1).method,'RunGrokBotAgentAutomationNow');
 await runtime.command('a','routineDelete',{id:'routine'});assert.equal(calls.at(-1).method,'DeleteGrokBotAgentAutomation');
 await assert.rejects(runtime.command('a','routineDelete',{id:'other'}),/no longer/);
 await assert.rejects(runtime.command('a','routineEnable',{id:'routine',enabled:'false'}),/enabled state/);
 await assert.rejects(runtime.command('a','routineCreate',{spec:{...spec,trigger:{type:'cron'}}}),/schedule/);
 await assert.rejects(runtime.command('a','routineCreate',{spec:{...spec,trigger:{type:'cron',schedule:'0 0 * * *',timeZone:'UTC'}}}),/account timezone/);
 await assert.rejects(runtime.command('a','routineCreate',{spec:{...spec,trigger:{type:'invented'}}}),/supported/);
 setFailure(new Error('network-secret'));const before=calls.length;
 await assert.rejects(runtime.command('a','routineCreate',{spec}),/Outcome unknown/);
 assert.equal(calls.slice(before).filter(c=>c.method==='createAgentAutomation').length,1);
 setFailure(new Response('provider-secret',{status:403}));await assert.rejects(runtime.command('a','computerStatus'),/permissions/);
 setFailure(new Response('invalid-json'));await assert.rejects(runtime.command('a','computerStatus'),/unreadable/);runtime.close();
});
test('skills check current scope and plugin selections preserve other installed ids',async()=>{
 const {runtime,calls}=providerFixture();
 await runtime.command('a','skillUpdate',{name:'Skill',description:'Updated',content:'New instructions'});assert.equal(calls.at(-1).body.content,'New instructions');
 await runtime.command('a','skillDelete',{name:'Skill'});assert.equal(calls.at(-1).method,'RemoveGrokBotAgentSkill');
 await runtime.command('a','pluginEnable',{id:'2',enabled:true});assert.deepEqual(calls.at(-1).body.plugins,[{pluginId:'1'},{pluginId:'2'}]);
 await runtime.command('a','pluginEnable',{id:'1',enabled:false});assert.deepEqual(calls.at(-1).body.plugins,[]);
 await assert.rejects(runtime.command('a','pluginEnable',{id:'2',enabled:'true'}),/enabled state/);runtime.close();
});

test('forms and widgets submit only current fields and secure values never enter activity DTOs',async()=>{
 let card:any={id:'entry',sessionId:'s',message:{type:'user-form',formRequest:{title:'Details',fields:[{id:'email',label:'Email',type:'email',required:true}]}}};const calls:any[]=[];
 const runtime=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),rpc:async(method,body:any)=>{
  calls.push({method,body});if(method==='ListGrokBotTranscriptEntries')return {entries:[{seq:1,body:Buffer.from(JSON.stringify(card)).toString('base64')}]};return {accepted:true};
 }});
 await assert.rejects(runtime.command('a','cardRespond',{id:'entry',sessionId:'other',values:{email:'a@test.invalid'}}),/stale/);
 await assert.rejects(runtime.command('a','cardRespond',{id:'entry',sessionId:'s',values:{}}),/required/);
 await assert.rejects(runtime.command('a','cardRespond',{id:'entry',sessionId:'s',values:{email:'a@test.invalid',extra:'bad'}}),/fields changed/);
 await runtime.command('a','cardRespond',{id:'entry',sessionId:'s',values:{email:'a@test.invalid'}});assert.equal(calls.at(-1).method,'SubmitGrokBotUserForm');assert.equal(calls.at(-1).body.saveToVault,false);
 card.formResolution='submitted';await assert.rejects(runtime.command('a','cardRespond',{id:'entry',sessionId:'s',values:{email:'a@test.invalid'}}),/stale/);
 card={id:'entry',sessionId:'s',message:{type:'widget',widget:{prompt:'Choose',options:[{label:'First',value:'one'}]}}};
 await assert.rejects(runtime.command('a','cardRespond',{id:'entry',sessionId:'s',value:'other'}),/current options/);
 await runtime.command('a','cardRespond',{id:'entry',sessionId:'s',value:'one'});assert.equal(calls.at(-1).method,'RespondGrokBotWidget');
 await runtime.command('a','cardRespond',{id:'entry',sessionId:'s',dismiss:true});assert.equal(calls.at(-1).method,'DismissGrokBotWidget');
 card.respondedValue='one';await assert.rejects(runtime.command('a','cardRespond',{id:'entry',sessionId:'s',value:'one'}),/stale/);
 card={id:'entry',sessionId:'s',message:{type:'secret-request',secretRequest:{label:'API key'},content:'hidden-value'}};
 const activity=await runtime.command('a','activity');assert.doesNotMatch(JSON.stringify(activity),/hidden-value/);
 await runtime.command('a','cardRespond',{id:'entry',sessionId:'s',value:'test-secret'});assert.equal(calls.at(-1).method,'SubmitGrokBotSecret');assert.equal(calls.at(-1).body.value,'test-secret');
 card.secretProvided=true;await assert.rejects(runtime.command('a','cardRespond',{id:'entry',sessionId:'s',value:'test-secret'}),/stale/);runtime.close();
});

test('draft editing keeps recipients and account routing fixed and refuses settled drafts',async()=>{
 let draft:any={id:'draft',sessionId:'s',message:{type:'email-draft',draft:{from:'sender@test.invalid',to:['recipient@test.invalid'],cc:[],subject:'Review',body:'Original'}}};const sent:any[]=[];
 const runtime=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),rpc:async(method,body)=>{
  if(method==='ListGrokBotTranscriptEntries')return {entries:[{seq:1,body:Buffer.from(JSON.stringify(draft)).toString('base64')}]};sent.push({method,body});return {accepted:true};
 }});
 const revision=()=>workCards({entries:[{seq:1,body:Buffer.from(JSON.stringify(draft)).toString('base64')}]}).cards[0].draft?.revision;
 await runtime.command('a','draftSend',{id:'draft',sessionId:'s',body:'Edited',revision:revision(),to:['attacker@test.invalid']});
 assert.deepEqual(sent[0],{method:'SendGrokBotDraft',body:{agentId:'a',entryId:'draft',sessionId:'s',email:{from:'sender@test.invalid',to:['recipient@test.invalid'],cc:[],subject:'Review',body:'Edited'}}});
 draft.draftSendState='sent';await assert.rejects(runtime.command('a','draftSend',{id:'draft',sessionId:'s',body:'Again',revision:revision()}),/no longer editable/);
 draft.draftSendState='editable';await runtime.command('a','draftDiscard',{id:'draft',sessionId:'s',revision:revision()});assert.equal(sent.at(-1).method,'DiscardGrokBotDraft');runtime.close();
});

test('authentication loss during a partial resource refresh cannot become an empty successful workspace',async()=>{
 const signedOut=new Error('Sign in again');signedOut.name='SignedOutError';
 const runtime=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),rpc:async method=>{if(method==='ListGrokBotAgentSkills')throw signedOut;return {};}});
 await assert.rejects(runtime.command('a','resources'),error=>error===signedOut);runtime.close();
});

test('resources reconcile canonical and computer routines, app choices and files without leaking inline configuration',async()=>{
 const runtime=new BotRuntime({identity:async id=>({id,agentId:'uuid-'+id,name:id}),rpc:async method=>{
  const replies:any={GetSandBoxRunState:{state:'SAND_BOX_RUN_STATE_RUNNING'},EnsureSandBox:{gatewayUrl:'https://gateway.test'},ListGrokBotAgentAutomations:{automations:[{automationId:'account',recordJson:JSON.stringify({id:'slug',name:'Canonical'})}]},ListGrokBotAgentSkills:{skills:[]},ListGrokBotAgentFiles:{files:[{name:'Empty',path:'/empty',sizeBytes:0}],nextPageToken:'next'},ListGrokBotUserStoreFiles:{files:[{path:'/large',sizeBytes:-1}]},GetEffectiveUserPlugins:{plugins:[{plugin:{id:'2',name:'Calendar'}},{plugin:{id:'3',displayName:'Mail'}},{}]},GetGrokBotAgentPlugins:{plugins:[{pluginId:'2',plugin:{displayName:'Calendar'},isEnabled:false},{id:'4',name:'Managed',ownedByMarketplace:true},{name:'Inline',mcpConfigJson:'PRIVATE'}]},GetGrokBotUserMcpSettings:{settings:{userTimeZone:'UTC'}},ListGrokBotUserSkills:{skills:[{name:'Skill',body:'Instructions'}]}};return replies[method]??{};
 },fetch:async()=>Response.json([{id:'slug',name:'duplicate'},{id:'legacy',name:'Legacy',isEnabled:false}])});
 const out=await runtime.command('a','resources');assert.deepEqual(out.routines.map((r:any)=>r.id),['account','legacy']);assert.equal(out.routines[1].enabled,false);assert.equal(out.plugins.plugins.length,4);assert.equal(out.timeZone,'UTC');assert.equal(out.files[1].sizeBytes,0);assert.doesNotMatch(JSON.stringify(out),/PRIVATE/);assert.equal((await runtime.command('a','routines')).length,2);runtime.close();
});

test('plugin changes preserve inline definitions and refuse marketplace or incomplete selections',async()=>{
 let selected:any[]=[{pluginId:'1'},{name:'Inline',mcpConfigJson:'{"server":"private"}'}];let sent:any;
 const runtime=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),rpc:async(method,body)=>{if(method==='GetGrokBotAgentPlugins')return {plugins:selected};sent=body;return {};}});
 await runtime.command('a','pluginEnable',{id:'2',enabled:true});assert.deepEqual(sent.plugins,[{pluginId:'1'},{inline:{name:'Inline',displayName:'',description:'',mcpConfigJson:'{"server":"private"}'}},{pluginId:'2'}]);
 selected=[{pluginId:'2',ownedByMarketplace:true}];await assert.rejects(runtime.command('a','pluginEnable',{id:'2',enabled:false}),/marketplace/);
 selected=[{name:'Inline'}];await assert.rejects(runtime.command('a','pluginEnable',{id:'2',enabled:true}),/configuration/);runtime.close();
});

test('computer connections single-flight, reject unsafe destinations and retain honest unavailable states',async()=>{
 let box:any={},release!:()=>void;let blocked=true,calls=0;
 const runtime=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),rpc:async()=>{calls++;if(blocked)await new Promise<void>(r=>{release=r});return box;},fetch:async()=>Response.json({})});
 const bot=await runtime.identity('a');const one=runtime.gateway(bot,'getForeverBoxStatus',{},false),two=runtime.gateway(bot,'getForeverBoxStatus',{},false);await new Promise(r=>setImmediate(r));release();await assert.rejects(one,/asleep/);await assert.rejects(two,/asleep/);assert.equal(calls,1);blocked=false;
 for(const gatewayUrl of ['http://gateway.test','https://u:p@gateway.test','https://gateway.test/?token=s','https://gateway.test/#s']){box={gatewayUrl};await assert.rejects(runtime.gateway(bot,'getForeverBoxStatus',{},false),/unsafe/);}
 box={gatewayUrl:'https://gateway.test'};await assert.rejects(runtime.computerConnection('a',false),/not ready/);runtime.close();
});

test('malformed resource lists and routine records fail visibly before any mutation',async()=>{
 let answer:any={automations:'invalid'};
 const runtime=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),rpc:async method=>method==='ListGrokBotAgentAutomations'?answer:{state:'SAND_BOX_RUN_STATE_HIBERNATED'}});
 await assert.rejects(runtime.command('a','resources'),/invalid automations/);
 answer={automations:[{recordJson:'broken'}]};await assert.rejects(runtime.command('a','resources'),/malformed routine/);
 answer={automations:[{id:'direct-record',name:'Direct'},{recordJson:'[]'},{recordJson:null}]};const out=await runtime.command('a','resources');assert.equal(out.routines[0].id,'direct-record');assert.equal(out.routines[1].name,'Routine');
 for(const botId of ['', 'x'.repeat(501),null])await assert.rejects(runtime.command(botId as any,'resources'),/required/);
 const cursor=await runtime.command('a','filesPage',{pageToken:'next'});assert.ok(cursor);await assert.rejects(runtime.command('a','filesPage',{pageToken:''}),/required/);runtime.close();
});

test('sparse computer status remains honest and routine permissions and cron input are checked',async()=>{
 const {runtime,setState}=providerFixture();setState({windows:[{id:'screen'},{subagentId:'helper'},{}]});const sparse=await runtime.command('a','computerStatus');assert.equal(sparse.state,'unknown');assert.equal(sparse.handoff,null);assert.deepEqual(sparse.monitors.map((m:any)=>m.id),['screen','helper','']);setState({});assert.deepEqual((await runtime.command('a','computerStatus')).monitors,[]);
 const invalid={name:'Name',prompt:'Task',trigger:{type:'cron',schedule:' '}};await assert.rejects(runtime.command('a','routineCreate',{spec:invalid}),/schedule/);await assert.rejects(runtime.command('a','routineCreate',{spec:[]}),/object/);runtime.close();
 const readOnly=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),rpc:async method=>method==='ListGrokBotAgentAutomations'?{automations:[{automationId:'r',recordJson:'{}',viewerPermissions:{allowedActions:[]}}]}:{state:'SAND_BOX_RUN_STATE_HIBERNATED'}});
 await assert.rejects(readOnly.command('a','routineDelete',{id:'r'}),/permission/);readOnly.close();
});

test('provider refusals are scrubbed and legacy routine results keep their IDs without speculative retries',async()=>{
 let response:any={error:'private token'};
 const runtime=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),rpc:async method=>{
  if(method==='EnsureSandBox')return {gatewayUrl:'https://gateway.test'};
  if(method==='ListGrokBotAgentAutomations')return {automations:[{automationId:'routine',recordJson:'{}'}]};
  if(method==='GetSandBoxRunState')return {state:'SAND_BOX_RUN_STATE_HIBERNATED'};
  return null;
 },fetch:async()=>Response.json(response)});
 const identity=await runtime.identity('a');for(const value of [{error:'private token'},{refusal:{reason:'private'}},{status:'refused'}]){response=value;await assert.rejects(runtime.gateway(identity,'getForeverBoxStatus',{},false),/refused/);}
 response=[];await runtime.command('a','routineUpdate',{id:'routine',spec:{name:'Name',prompt:'Task',trigger:{type:'cron',schedule:'0 9 * * *'}}});
 const resources=await runtime.command('a','resources');assert.deepEqual(resources.memory,{});assert.deepEqual(resources.library.pins,[]);
 response={};assert.deepEqual((await runtime.command('a','computerStatus')).monitors,[]);runtime.close();
});
