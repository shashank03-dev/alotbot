import assert from 'node:assert/strict';
import {test} from 'node:test';
import {WorkCardControls} from '../src/work-card-controls.ts';
import {workCards} from '../src/work-cards.ts';
import {BotRuntime} from '../src/bot-runtime.ts';
const bot={id:'roster',agentId:'uuid',name:'Research'};
const body=(type:string,extra:any={})=>({id:'entry',sessionId:'session',message:{type,...extra}});
const page=(entry:any)=>({entries:[{seq:1,body:Buffer.from(JSON.stringify(entry)).toString('base64')}]});
const card=(entry:any)=>workCards(page(entry)).cards[0];
function fixture(){
 const calls:any[]=[];let reply:any={accepted:true},agents:any={agents:[{id:'roster',avatarShape:'cloud',avatarColor:'blue'}]},gatewayReply:any={kind:'confirmed'};
 const controls=new WorkCardControls(async(method,data)=>{calls.push({method,data});return method==='ListGrokBotAgents'?agents:reply},async(target,method,data)=>{calls.push({target,method,data});return gatewayReply;});
 return {controls,calls,setReply:(v:any)=>{reply=v},setAgents:(v:any)=>{agents=v},setGateway:(v:any)=>{gatewayReply=v}};
}
const args=(current:any,control:string,more:any={})=>({control,sessionId:current.sessionId,controlRevision:current.details.controlRevision,...more});
test('setup cards keep actual offered values, proposal identity and explicit settled states',()=>{
 for(const type of ['appearance-picker','email-offer','notifications-enable','team-access']){
  const current=card(body(type,{email:'bot@example.test',reason:'Team invitation'}));assert.equal(current.status,'pending');assert.ok(current.actions.length);assert.equal(current.details.email,'bot@example.test');
  for(const settled of [{respondedValue:'used'},{widgetDismissed:true}])assert.deepEqual(card({...body(type),...settled}).actions,[]);
 }
 const replaced=card(body('email-offer',{replaced:true}));assert.equal(replaced.status,'replaced');assert.deepEqual(replaced.actions,[]);
 const published=card(body('publish-approval',{approval:{status:'pending',bcId:'task',proposalId:'proposal',slug:'site',apex:'apps.example.test',visibility:'private'}}));assert.deepEqual(published.actions,['publishConfirm','publishDismiss']);assert.equal(published.details.bcId,'task');
 assert.deepEqual(card(body('publish-approval',{approval:{status:'pending'}})).actions,[]);
 assert.notEqual(published.details.controlRevision,card(body('publish-approval',{approval:{status:'pending',bcId:'task',proposalId:'new-proposal'}})).details.controlRevision);
});
test('appearance reads the real roster and changes only that bot’s look before answering the exact card',async()=>{
 const f=fixture(),current=card(body('appearance-picker'));
 assert.equal((await f.controls.appearance(bot)).shape,'cloud');
 f.setAgents({agents:[{id:'roster'}]});assert.equal((await f.controls.appearance(bot)).color,'black');
 for(const invalid of [{},{agents:[]},{agents:[null,{id:'other'}]}]){f.setAgents(invalid);await assert.rejects(f.controls.appearance(bot),/no longer available/);}
 await f.controls.command(bot,args(current,'appearanceSave',{shape:'cloud',color:'blue'}),current);
 assert.deepEqual(f.calls.at(-2),{method:'UpdateGrokBotAgent',data:{id:'roster',avatarShape:'cloud',avatarColor:'blue',partialUpdate:true}});
 assert.deepEqual(f.calls.at(-1).data,{agentId:'uuid',entryId:'entry',sessionId:'session',value:'{"avatarShape":"cloud","avatarColor":"blue"}'});
 for(const input of [{shape:'new',color:'blue'},{shape:'cloud',color:'new'},{shape:'',color:'blue'},{shape:'x'.repeat(501),color:'blue'}])await assert.rejects(f.controls.command(bot,args(current,'appearanceSave',input),current),/supported|valid/);
});
test('email choices and setup dismissal are scoped widget responses and cannot be replayed against changed cards',async()=>{
 const f=fixture(),current=card(body('email-offer',{email:'bot@example.test'}));
 await f.controls.command(bot,args(current,'emailUse'),current);assert.equal(f.calls.at(-1).data.value,'email-offer:use');
 await f.controls.command(bot,args(current,'emailDecline'),current);assert.equal(f.calls.at(-1).data.value,'email-offer:not-now');
 const notification=card(body('notifications-enable'));await f.controls.command(bot,args(notification,'setupDismiss'),notification);assert.equal(f.calls.at(-1).method,'DismissGrokBotWidget');
 const before=f.calls.length;
 for(const [selected,input]of [[undefined,args(current,'emailUse')],[current,args(current,'invented')],[notification,args(notification,'emailUse')],[current,args(current,'emailUse',{sessionId:'other'})],[current,args(current,'emailUse',{controlRevision:'stale'})],[current,args(current,'emailUse',{controlRevision:null})],[{...current,actions:[]},args(current,'emailUse')]]as any)await assert.rejects(f.controls.command(bot,input,selected),/changed/);
 await assert.rejects(f.controls.command(bot,{control:1},current),/valid/);assert.equal(f.calls.length,before);
});
test('setup widget receipts must explicitly confirm acceptance, including protobuf omitted false',async()=>{
 const f=fixture(),current=card(body('email-offer'));
 for(const reply of [{},null,{accepted:'false'},{accepted:false},{accepted:true,refusal:{reason:'denied'}}]){
  f.setReply(reply);await assert.rejects(f.controls.command(bot,args(current,'emailUse'),current),/did not confirm/);
 }
});
test('sharing requires explicit confirmation, never carries personal secrets and distinguishes started from finished',async()=>{
 const f=fixture(),current=card(body('team-access'));
 await assert.rejects(f.controls.command(bot,args(current,'teamShare'),current),/confirm/);
 for(const outcome of [1,'SHARE_GROK_BOT_AGENT_IN_PLACE_OUTCOME_STARTED']){f.setReply({outcome});assert.equal((await f.controls.command(bot,args(current,'teamShare',{userConfirmed:true}),current)).queued,true);}
 for(const outcome of [0,'SHARE_GROK_BOT_AGENT_IN_PLACE_OUTCOME_INELIGIBLE']){f.setReply({outcome});await assert.rejects(f.controls.command(bot,args(current,'teamShare',{userConfirmed:true}),current),/could not start/);}
 for(const outcome of [1,'CLONE_GROK_BOT_AGENT_TO_TEAM_OUTCOME_CLONED']){f.setReply({outcome,agent:{agentId:'copy'}});assert.equal((await f.controls.command(bot,args(current,'teamCopy',{userConfirmed:true}),current)).agentId,'copy');assert.deepEqual(f.calls.at(-1).data,{agentId:'uuid',personalSecretNames:[],offerEntryId:'entry',inPlace:false});}
 f.setReply({outcome:3});await assert.rejects(f.controls.command(bot,args(current,'teamCopy',{userConfirmed:true}),current),/could not create/);
 f.setReply({outcome:1});await assert.rejects(f.controls.command(bot,args(current,'teamCopy',{userConfirmed:true}),current),/Outcome unknown/);
});
test('publishing reviews the current exact proposal and audience and never treats a provider refusal as approval',async()=>{
 const f=fixture(),current=card(body('publish-approval',{approval:{status:'pending',bcId:'task',proposalId:'proposal'}}));
 const confirmed=args(current,'publishConfirm',{slug:'test-site',visibility:'private',userConfirmed:true});
 await f.controls.command(bot,confirmed,current);assert.deepEqual(f.calls.at(-1).data,{agentId:'uuid',bcId:'task',proposalId:'proposal',slug:'test-site',visibility:'private',requireConfirmationForUpdates:true});
 await f.controls.command(bot,args(current,'publishDismiss',{userConfirmed:true}),current);assert.equal(f.calls.at(-1).method,'dismissCloudAgentPublishProposal');
 for(const visibility of ['','everyone'])await assert.rejects(f.controls.command(bot,{...confirmed,visibility},current),/visibility/);
 for(const slug of ['UPPER','a--b','a/b','x'.repeat(64)])await assert.rejects(f.controls.command(bot,{...confirmed,slug},current),/site name|lowercase/);
 await assert.rejects(f.controls.command(bot,confirmed,{...current,details:{...current.details,bcId:''}}),/coding task/);
 f.setGateway({kind:'refused',reason:'not-owner'});await assert.rejects(f.controls.command(bot,confirmed,current),/refused/);
});
test('runtime setup commands re-read the exact bot card and expose only safe appearance/sharing metadata',async()=>{
 let entry:any=body('email-offer',{email:'bot@example.test'}),shared=false;const calls:any[]=[];
 const runtime=new BotRuntime({identity:async id=>({id,agentId:'uuid-'+id,name:id}),rpc:async(method,data:any)=>{calls.push({method,data});if(method==='ListGrokBotTranscriptEntries')return data.agentId==='uuid-a'?page(entry):{};if(method==='ListGrokBotAgents')return {agents:[{id:'a',avatarShape:'cloud',avatarColor:'blue'}]};if(method==='GetGrokBotAgentInPlaceShareStatus')return shared?{state:'DONE',shared:true,failureReason:''}:{};return {accepted:true};}});
 const current=card(entry);await runtime.command('a','cardControl',{id:'entry',...args(current,'emailUse')});assert.equal(calls.at(-1).data.agentId,'uuid-a');
 await assert.rejects(runtime.command('b','cardControl',{id:'entry',...args(current,'emailUse')}),/changed/);
 assert.equal((await runtime.command('a','appearanceOptions')).shape,'cloud');assert.equal((await runtime.command('a','sharingStatus')).shared,false);shared=true;assert.equal((await runtime.command('a','sharingStatus')).state,'DONE');runtime.close();
});
test('runtime publishing uses the authenticated gateway and exact reviewed proposal',async()=>{
 const entry=body('publish-approval',{approval:{status:'pending',bcId:'task',proposalId:'proposal'}}),requests:any[]=[];
 const runtime=new BotRuntime({identity:async id=>({id,agentId:'uuid',name:id}),accessToken:()=> 'account-token',rpc:async(method)=>method==='EnsureSandBox'?{gatewayUrl:'https://gateway.test',gatewayToken:'sandbox-token'}:page(entry),fetch:async(url,options)=>{requests.push({url,body:JSON.parse(String(options?.body)),headers:options?.headers});return Response.json({kind:'confirmed'});}});
 const current=card(entry);
 await runtime.command('a','cardControl',{id:'entry',...args(current,'publishConfirm',{slug:'test-site',visibility:'private',userConfirmed:true})});
 assert.equal(requests[0].url,'https://gateway.test/api/confirmCloudAgentPublishProposal');
 assert.deepEqual(requests[0].body,{agentId:'uuid',id:'uuid',bcId:'task',proposalId:'proposal',slug:'test-site',visibility:'private',requireConfirmationForUpdates:true});
 assert.equal(requests[0].headers.authorization,'Bearer account-token');runtime.close();
});
test('older activity actions fetch the exact position afresh without trusting a cached card',async()=>{
 const older=body('email-offer'),calls:any[]=[];
 let changed=false,latest=false;
 const runtime=new BotRuntime({identity:async id=>({id,agentId:'uuid-'+id,name:id}),rpc:async(method,data:any)=>{
  calls.push({method,data});
  if(method==='ListGrokBotTranscriptEntries')return data.agentId==='uuid-a'&&(latest||data.beforeSeq==='51')?page(changed?{...older,widgetDismissed:true}:older):{};
  return {accepted:true};
 }});
 const current=card(older),input={id:'entry',seq:50,...args(current,'emailUse')};
 await runtime.command('a','cardControl',input);
 assert.equal(calls.at(-1).method,'RespondGrokBotWidget');
 assert.equal(calls.at(-2).data.beforeSeq,'51');
 changed=true;await assert.rejects(runtime.command('a','cardControl',input),/changed/);
 await assert.rejects(runtime.command('b','cardControl',input),/changed/);
 for(const seq of [undefined,-1,Number.MAX_SAFE_INTEGER,1.5,'50'])await assert.rejects(runtime.command('a','cardControl',{...input,seq}),/changed/);
 latest=true;const before=calls.length;await assert.rejects(runtime.command('a','cardControl',input),/changed/);assert.equal(calls.length,before+1);
 runtime.close();
});
