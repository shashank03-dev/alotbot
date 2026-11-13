import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BotRuntime, emailAddress} from '../src/bot-runtime.ts';
import {workCards, DRAFT_ATTACHMENT_MAX} from '../src/work-cards.ts';

const encode=(body:any)=>Buffer.from(JSON.stringify(body)).toString('base64');
const entry=(body:any,seq=1)=>({seq,body:encode(body)});
const project=(body:any)=>workCards({entries:[entry(body)]}).cards[0];
const email=(extra:any={},draft:any={})=>({id:'d',sessionId:'s',...extra,message:{type:'email-draft',draft:{from:'Bot@Example.com',to:['ana@example.com'],cc:[],subject:'Plan',body:'Hello',...draft}}});
const rev=(body:any)=>(project(body).draft as any).revision;
const signedOut=()=>Object.assign(new Error('signed out'),{name:'SignedOutError'});

/** Provider simulation: transcripts are per agent, sends are recorded, nothing leaves the process. */
function harness(entries:Record<string,any[]>,reply:(method:string,body:any)=>any=()=>({accepted:true})){
  const calls:{method:string;body:any}[]=[];
  const runtime=new BotRuntime({identity:async id=>({id,agentId:'agent-'+id,name:id}),rpc:async(method,body:any)=>{
    calls.push({method,body});
    if(method==='ListGrokBotTranscriptEntries')return {entries:(entries[body.agentId]??[]).map((b,i)=>entry(b,i+1))};
    return reply(method,body);
  }});
  const sent=()=>calls.filter(c=>c.method==='SendGrokBotDraft'||c.method==='DiscardGrokBotDraft');
  return {runtime,calls,sent};
}

test('email projection uses the verified sending route and exposes only display-safe attachment facts',()=>{
  const card=project(email({draftRouteVerified:{platform:'email',sendingAddresses:['bot@example.com',7,'alt@example.com'],sendingAddress:'bot@example.com',replyTo:'thread@example.com',replyToUrl:'https://mail.example.com/t/1',forwarding:'fwd'},
    draftRoute:{platform:'email',signatureHtml:'<p>Ana&nbsp;&amp; Co</p><br>&lt;ok&gt; &quot;q&quot; &#39;s&#39;\n\n\n\nend',replyTo:'unverified@example.com',forwarding:'unverified',attachments:[{path:'/files/a.pdf',filename:'A.pdf',sizeBytes:5},{path:'/files/b.txt',sizeBytes:0},{path:'/files/',sizeBytes:1}]}}));
  assert.deepEqual(card.actions,['sendDraft','discardDraft']);
  const d=card.draft as any;
  assert.equal(d.from,'bot@example.com');assert.deepEqual(d.sendingAddresses,['bot@example.com','alt@example.com']);
  assert.deepEqual(d.attachments.map((a:any)=>a.filename),['A.pdf','b.txt','Attachment']);
  assert.equal(d.signature,'Ana & Co\n\n<ok> "q" \'s\'\n\nend');assert.equal(d.replyTo,'thread@example.com');assert.equal(d.forwarding,'fwd');assert.equal(d.replyToUrl,'https://mail.example.com/t/1');
  assert.match(d.revision,/^[0-9a-f]{32}$/);assert.equal(d.blockedReason,undefined);
  const changed=project(email({draftRoute:{platform:'email',attachments:[{path:'/files/a.pdf',filename:'A.pdf',sizeBytes:6}]}}));
  assert.notEqual((changed.draft as any).revision,d.revision);
  const fallback=project(email({draftRouteVerified:{platform:'email',sendingAddress:'owner@example.com',replyTo:{},replyToUrl:'http://mail.example.com'},draftRoute:{platform:'email',signatureHtml:'x'.repeat(200001)}}));
  assert.equal((fallback.draft as any).from,'owner@example.com');assert.equal((fallback.draft as any).replyTo,undefined);assert.equal((fallback.draft as any).replyToUrl,undefined);
  for(const replyToUrl of ['https://u:p@mail.example.com','not a url',7,'https://x.example/'+'a'.repeat(2000)])assert.equal((project(email({draftRouteVerified:{platform:'email',sendingAddress:'o@example.com',replyToUrl}})).draft as any).replyToUrl,undefined);assert.equal((fallback.draft as any).signatureHtml,undefined);
  const otherPlatform=project(email({draftRoute:{platform:'slack',macMail:{},attachments:'bad'},draftRouteVerified:{platform:'slack'}},{to:'not-a-list',cc:['c@example.com',1]}));
  assert.deepEqual(otherPlatform.actions,['sendDraft','discardDraft']);assert.deepEqual((otherPlatform.draft as any).to,[]);assert.deepEqual((otherPlatform.draft as any).cc,['c@example.com']);
  assert.equal(project(email({draftRoute:'x',draftRouteVerified:7})).actions.length,2);
});

test('drafts Grok Call cannot send faithfully stay discard-only with an honest reason',()=>{
  const bad=[[{path:'',sizeBytes:1}],[{path:'/a\0b',sizeBytes:1}],[{path:'/a',sizeBytes:-1}],[{path:'/a',sizeBytes:1.5}],[null],{},Array.from({length:26},(_,i)=>({path:'/f'+i,sizeBytes:1})),[{path:'x'.repeat(4097),sizeBytes:1}],[{path:7,sizeBytes:1}]];
  for(const attachments of bad){const card=project(email({draftRoute:{platform:'email',attachments}}));assert.deepEqual(card.actions,['discardDraft']);assert.match((card.draft as any).blockedReason,/can’t verify/);}
  const big=project(email({draftRoute:{platform:'email',attachments:[{path:'/big',sizeBytes:DRAFT_ATTACHMENT_MAX+1}]}}));assert.match((big.draft as any).blockedReason,/larger than 10 MB/);
  assert.equal(project(email({draftRoute:{platform:'email',attachments:[{path:'/edge',sizeBytes:DRAFT_ATTACHMENT_MAX}]}})).actions.length,2);
  assert.match((project(email({draftRoute:{platform:'email',macMail:{machineId:'m'}}})).draft as any).blockedReason,/Mail on a specific Mac/);
  assert.match((project(email({draftRouteVerified:{platform:'email',sendingAddresses:['x@example.com']}})).draft as any).blockedReason,/couldn’t be verified/);
  const imessage=project({id:'i',sessionId:'s',machineId:'m',message:{type:'imessage-draft',machineId:'m',approvalId:'old',draft:{to:'+15550100',chatId:'c',recipientName:'Ana',body:'Hi'}}});
  assert.deepEqual(imessage.actions,['discardDraft']);assert.match((imessage.draft as any).blockedReason,/fresh Messages approval/);
  assert.equal((imessage.draft as any).approvalId,undefined);assert.equal((imessage.draft as any).machineId,undefined);
  assert.deepEqual(project({...email(),draftSendState:'sent'}).actions,[]);assert.deepEqual(project({...email(),id:''}).actions,[]);
});

test('slack and meeting projections pin verified destinations and meeting visibility rules',()=>{
  const verified=project({id:'s',sessionId:'s',draftRouteVerified:{platform:'slack',workspace:'Team',channelName:'#ops',thread:'t1'},message:{type:'slack-draft',draft:{workspace:'Other',target:'#evil',body:'Hi'}}});
  assert.deepEqual([(verified.draft as any).workspace,(verified.draft as any).target,(verified.draft as any).thread,(verified.draft as any).verifiedRoute],['Team','#ops','t1',true]);
  const plain=project({id:'s',sessionId:'s',message:{type:'slack-draft',draft:{target:'#general',body:'Hi'}}});
  assert.equal((plain.draft as any).target,'#general');assert.equal((plain.draft as any).verifiedRoute,false);
  assert.deepEqual(project({id:'s',sessionId:'s',draftRouteVerified:{platform:'slack'},message:{type:'slack-draft',draft:{target:'#x',body:'Hi'}}}).actions,['discardDraft']);
  const open=project({id:'m',sessionId:'s',message:{type:'meeting-chat-draft',draft:{meetingId:'meet',meetingTitle:'Standup',body:'Hi'}}});
  assert.equal((open.draft as any).canMarkInternal,true);assert.equal((open.draft as any).privateTo,'');
  const priv=project({id:'m',sessionId:'s',message:{type:'meeting-chat-draft',draft:{meetingId:'meet',privateTo:{id:'p'},body:'Hi'}}});
  assert.equal((priv.draft as any).privateTo,'a private recipient');assert.equal((priv.draft as any).canMarkInternal,false);
  assert.equal((project({id:'m',sessionId:'s',message:{type:'meeting-chat-draft',draft:{meetingId:'meet',privateTo:'Ana',body:'Hi'}}}).draft as any).privateTo,'Ana');
  const internal=project({id:'m',sessionId:'s',message:{type:'meeting-chat-draft',meetingInternal:true,draft:{meetingId:'meet',body:'Hi'}}});
  assert.deepEqual([(internal.draft as any).markInternal,(internal.draft as any).canMarkInternal],[true,false]);
  assert.deepEqual(project({id:'m',sessionId:'s',message:{type:'meeting-chat-draft',draft:{body:'Hi'}}}).actions,['discardDraft']);
});

test('the body-only path keeps sender, recipients, subject and session fixed even when a caller passes them',async()=>{
  const {runtime,sent}=harness({'agent-a':[email({draftRouteVerified:{platform:'email',sendingAddresses:['bot@example.com']}})]});
  await runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'Edited',revision:rev(email({draftRouteVerified:{platform:'email',sendingAddresses:['bot@example.com']}})),to:['attacker@example.com'],from:'attacker@example.com',subject:'Owned',agentId:'x',entryId:'y'});
  assert.deepEqual(sent()[0].body,{agentId:'agent-a',entryId:'d',sessionId:'s',email:{from:'bot@example.com',to:['ana@example.com'],cc:[],subject:'Plan',body:'Edited'}});
  runtime.close();
});

test('reviewed email edits change recipients, subject and only a verified sender',async()=>{
  const card=email({draftRouteVerified:{platform:'email',sendingAddresses:['bot@example.com','alt@example.com']},draftRoute:{platform:'email',signatureHtml:'<b>Sig</b>'}});
  const {runtime,sent}=harness({'agent-a':[card]});
  const revision=(project(card).draft as any).revision;
  await runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'Hi',revision,reviewed:true,review:{from:'ALT@example.com',to:[' ben@example.com ',''],cc:['cy@example.xn--p1ai','zoë@exämple.de'],subject:'New\r\nBcc: x@example.com'}});
  assert.deepEqual(sent()[0].body,{agentId:'agent-a',entryId:'d',sessionId:'s',email:{from:'alt@example.com',to:['ben@example.com'],cc:['cy@example.xn--p1ai','zoë@exämple.de'],subject:'New Bcc: x@example.com',body:'Hi'},shownSignatureHtml:'<b>Sig</b>'});
  const refusals:[any,RegExp][]=[
    [{review:{to:['b@example.com']}},/confirmed in the draft editor/],
    [{reviewed:true,revision:undefined,review:{to:['b@example.com']}},/changed since you reviewed/],
    [{reviewed:true,revision,review:{}},/confirmed in the draft editor/],
    [{reviewed:true,revision,review:'to=b@example.com'},/confirmed in the draft editor/],
    [{reviewed:true,revision,review:{bcc:['b@example.com']}},/can’t be changed here/],
    [{reviewed:true,revision,review:{from:'other@example.com'}},/verified sending addresses/],
    [{reviewed:true,revision,review:{to:'b@example.com'}},/list of up to 100/],
    [{reviewed:true,revision,review:{cc:[1]}},/list of up to 100/],
    [{reviewed:true,revision,review:{to:Array(101).fill('b@example.com')}},/list of up to 100/],
    [{reviewed:true,revision,review:{to:[]}},/at least one valid recipient/],
    [{reviewed:true,revision,review:{to:['not an address']}},/valid email/],
    [{reviewed:true,revision,review:{cc:['b@localhost']}},/valid email/],
    [{reviewed:true,revision,review:{subject:7}},/Subject must be text/],
    [{reviewed:true,revision,review:{subject:'x'.repeat(2001)}},/Subject must be text/],
    [{revision:'stale'},/changed since you reviewed/],
    [{body:'   '},/Message body is required/],
  ];
  for(const [args,error] of refusals)await assert.rejects(runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'Hi',revision,...args}),error);
  assert.equal(sent().length,1);
  runtime.close();
});

test('unverified email senders cannot be swapped and invalid drafted recipients block sending',async()=>{
  const card=email({}, {to:['broken']});
  const {runtime,sent}=harness({'agent-a':[card]});
  const revision=(project(card).draft as any).revision;
  await assert.rejects(runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'Hi',revision,reviewed:true,review:{from:'Bot@Example.com'}}),/verified sending addresses/);
  await assert.rejects(runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'Hi',revision}),/valid email/);
  await runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'Hi',revision,reviewed:true,review:{to:['fixed@example.com']}});
  assert.deepEqual(sent()[0].body.email.to,['fixed@example.com']);assert.equal(sent()[0].body.email.from,'Bot@Example.com');
  runtime.close();
});

test('the native email address rule accepts real addresses and rejects malformed ones',()=>{
  for(const ok of ['a@example.com','a.b+c@sub.example.co','ü@bücher.de','x@example.xn--80ak6aa92e'])assert.equal(emailAddress(ok),true,ok);
  for(const bad of ['','a','a@b@example.com','a b@example.com','@example.com','a@example','a@-bad.com','a@example.c','a@example.123','x@xn--p1ai','a@exa_mple.com','‮a@example.com','a@'+'x'.repeat(250)+'.com'])assert.equal(emailAddress(bad),false,bad);
});

test('route-held attachments are kept by entry identity and verified against the bot’s own files before sending',async()=>{
  const card=email({draftRoute:{platform:'email',attachments:[{path:'/files/a.pdf',filename:'a.pdf',sizeBytes:5}]}});
  const revision=(project(card).draft as any).revision;
  let size:any=5,fail:Error|null=null;
  const {runtime,calls,sent}=harness({'agent-a':[card]},(method)=>{if(method==='ReadGrokBotAgentAttachmentChunk'){if(fail)throw fail;return {data:'c2VjcmV0',totalSize:size};}return {accepted:true};});
  await assert.rejects(runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'Hi'}),/changed since you reviewed/);
  const result=await runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'Hi',revision});
  assert.deepEqual(result,{accepted:true});
  assert.deepEqual(calls.find(c=>c.method==='ReadGrokBotAgentAttachmentChunk')?.body,{path:'/files/a.pdf',offset:'0',length:1,sessionId:'s'});
  assert.equal(sent()[0].body.email.attachments,undefined);assert.equal(JSON.stringify(sent()[0].body).includes('/files/a.pdf'),false);
  for(const next of ['4',6,undefined]){size=next;await assert.rejects(runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'Hi',revision}),/missing or changed/);}
  size=5;let raw:any=null;const {runtime:r2,sent:s2}=harness({'agent-a':[card]},m=>m==='ReadGrokBotAgentAttachmentChunk'?raw:{accepted:true});
  await assert.rejects(r2.command('a','draftSend',{id:'d',sessionId:'s',body:'Hi',revision}),/missing or changed/);assert.equal(s2().length,0);r2.close();
  fail=new Error('not found');await assert.rejects(runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'Hi',revision}),/missing or changed/);
  fail=signedOut();await assert.rejects(runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'Hi',revision}),/signed out/);
  assert.equal(sent().length,1);
  runtime.close();
});

test('slack and meeting sends use the pinned destination and native meeting limits',async()=>{
  const slack={id:'sl',sessionId:'s',draftRouteVerified:{platform:'slack',workspace:'Team',channelName:'#ops',thread:'t1'},message:{type:'slack-draft',draft:{target:'#evil',body:'Hi'}}};
  const bare={id:'sb',sessionId:'s',message:{type:'slack-draft',draft:{target:'#general',body:'Hi'}}};
  const meet={id:'m',sessionId:'s',message:{type:'meeting-chat-draft',draft:{meetingId:'meet',meetingTitle:'Standup',body:'Hi'}}};
  const priv={id:'p',sessionId:'s',message:{type:'meeting-chat-draft',draft:{meetingId:'meet',privateTo:'Ana',body:'Hi'}}};
  const {runtime,sent}=harness({'agent-a':[slack,bare,meet,priv]});
  const rev=(b:any)=>(project(b).draft as any).revision;
  await runtime.command('a','draftSend',{id:'sl',sessionId:'s',body:'Edited',revision:rev(slack)});
  await runtime.command('a','draftSend',{id:'sb',sessionId:'s',body:'Edited',revision:rev(bare)});
  await assert.rejects(runtime.command('a','draftSend',{id:'sl',sessionId:'s',body:'x',revision:rev(slack),reviewed:true,review:{target:'#evil'}}),/can’t be changed here/);
  await runtime.command('a','draftSend',{id:'m',sessionId:'s',body:'Edited',revision:rev(meet),reviewed:true,review:{markInternal:true}});
  await runtime.command('a','draftSend',{id:'p',sessionId:'s',body:'Edited',revision:rev(priv),reviewed:true,review:{markInternal:false}});
  await assert.rejects(runtime.command('a','draftSend',{id:'p',sessionId:'s',body:'x',revision:rev(priv),reviewed:true,review:{markInternal:true}}),/can’t be marked internal/);
  await assert.rejects(runtime.command('a','draftSend',{id:'m',sessionId:'s',body:'x',revision:rev(meet),reviewed:true,review:{markInternal:'yes'}}),/can’t be marked internal/);
  await assert.rejects(runtime.command('a','draftSend',{id:'m',sessionId:'s',body:'x'.repeat(4097),revision:rev(meet)}),/up to 4096/);
  assert.deepEqual(sent().map(c=>Object.keys(c.body).at(-1)==='slack'?c.body.slack:c.body.meetingChat),[
    {workspace:'Team',target:'#ops',thread:'t1',body:'Edited'},{target:'#general',body:'Edited'},
    {meetingId:'meet',meetingTitle:'Standup',body:'Edited',markInternal:true},{meetingId:'meet',body:'Edited'}]);
  runtime.close();
});

test('stale, cross-bot, cross-session, unsupported and unknown draft requests never reach the provider',async()=>{
  const imessage={id:'i',sessionId:'s',message:{type:'imessage-draft',draft:{to:'+15550100',body:'Hi'}}};
  const {runtime,sent}=harness({'agent-a':[email(),imessage],'agent-b':[]});
  await assert.rejects(runtime.command('b','draftSend',{id:'d',sessionId:'s',body:'Hi'}),/no longer editable/);
  await assert.rejects(runtime.command('a','draftSend',{id:'d',sessionId:'other',body:'Hi'}),/no longer editable/);
  await assert.rejects(runtime.command('a','draftSend',{id:'missing',sessionId:'s',body:'Hi'}),/no longer editable/);
  await assert.rejects(runtime.command('a','draftSend',{id:'i',sessionId:'s',body:'Hi'}),/no longer editable/);
  await assert.rejects(runtime.command('a','draftSend',{sessionId:'s',body:'Hi'}),/Draft is required/);
  await assert.rejects(runtime.command('a','draftDiscard',{id:'d',sessionId:'s',revision:'old'}),/changed since you reviewed/);
  await assert.rejects(runtime.command('a','draftSave',{id:'d',sessionId:'s'}),/Unknown/);
  assert.equal(sent().length,0);
  await assert.rejects(runtime.command('a','draftDiscard',{id:'i',sessionId:'s'}),/changed since you reviewed/);
  await runtime.command('a','draftDiscard',{id:'i',sessionId:'s',revision:rev(imessage)});
  await runtime.command('a','draftDiscard',{id:'d',sessionId:'s',revision:(project(email()).draft as any).revision});
  assert.deepEqual(sent().map(c=>[c.method,c.body]),[['DiscardGrokBotDraft',{agentId:'agent-a',entryId:'i',sessionId:'s'}],['DiscardGrokBotDraft',{agentId:'agent-a',entryId:'d',sessionId:'s'}]]);
  runtime.close();
});

test('live transcript drafts without a session omit it, exactly like the native app',async()=>{
  const live={kind:'send-message',id:'live',message:{type:'email-draft',draft:{from:'me@example.com',to:['t@example.com'],subject:'S',body:'B'}},
    draftRoute:{platform:'email',providerIdentifier:'user-Gmail',mailbox:'gmail',restMcp:true,attachments:[{path:'/a',filename:'a',sizeBytes:1}]},draftRouteVerified:{platform:'email',sendingAddress:'me@example.com',senderSource:'list_send_as'}};
  const {runtime,calls,sent}=harness({'agent-a':[live]},m=>m==='ReadGrokBotAgentAttachmentChunk'?{totalSize:1}:{accepted:true});
  const card=project(live);assert.equal(card.sessionId,'');assert.deepEqual((card.draft as any).sendingAddresses,['me@example.com']);
  await runtime.command('a','draftSend',{id:'live',sessionId:'',body:'B',revision:(card.draft as any).revision});
  assert.deepEqual(calls.find(c=>c.method==='ReadGrokBotAgentAttachmentChunk')?.body,{path:'/a',offset:'0',length:1});
  assert.equal('sessionId' in sent()[0].body,false);
  runtime.close();
});

test('provider denial, unknown outcomes and sign-out are reported without logging draft content',async()=>{
  let reply:any={accepted:false};
  const {runtime}=harness({'agent-a':[email({}, {body:'TOP-SECRET-BODY'})]},()=>{if(reply instanceof Error)throw reply;return reply;});
  const logged:string[]=[];const originals:any={};
  for(const k of ['log','info','warn','error','debug'] as const){originals[k]=console[k];console[k]=(...a:any[])=>{logged.push(a.map(String).join(' '));};}
  try {
    await assert.rejects(runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'TOP-SECRET-BODY',revision:rev(email({}, {body:'TOP-SECRET-BODY'}))}),/provider refused/);
    reply={accepted:true,refusal:{failureCode:'PERMISSION_DENIED',message:'denied'}};
    await assert.rejects(runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'TOP-SECRET-BODY',revision:rev(email({}, {body:'TOP-SECRET-BODY'}))}),/provider refused/);
    reply=new Error('socket hang up TOP-SECRET-BODY');
    await assert.rejects(runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'TOP-SECRET-BODY',revision:rev(email({}, {body:'TOP-SECRET-BODY'}))}),(e:Error)=>/Outcome unknown/.test(e.message)&&!e.message.includes('TOP-SECRET'));
    reply=signedOut();
    await assert.rejects(runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'TOP-SECRET-BODY',revision:rev(email({}, {body:'TOP-SECRET-BODY'}))}),/signed out/);
  } finally {for(const k of Object.keys(originals))(console as any)[k]=originals[k];}
  assert.deepEqual(logged,[]);
  runtime.close();
});

test('review findings: revision is mandatory and session-bound, save states and truncated fields block sending',async()=>{
  const moved=email({}, {to:['new-recipient@example.com']});
  const {runtime,sent}=harness({'agent-a':[moved]});
  await assert.rejects(runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'Old reviewed text'}),/changed since you reviewed/);
  await assert.rejects(runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'Old reviewed text',revision:rev(email())}),/changed since you reviewed/);
  await assert.rejects(runtime.command('a','draftDiscard',{id:'d',sessionId:'s'}),/changed since you reviewed/);
  assert.equal(sent().length,0);runtime.close();
  assert.notEqual(rev(email()),rev({...email(),sessionId:'other'}));
  for(const draftSaveState of ['saving','saved'])assert.deepEqual(project({...email(),draftSaveState}).actions,[]);
  assert.equal(project({...email(),draftSaveState:'saved'}).status,'saved');
  assert.equal(project({...email(),draftSendState:'sent',draftSaveState:'saved'}).status,'sent');
  assert.deepEqual(project({id:'s',sessionId:'s',draftSaveState:'saved',message:{type:'slack-draft',draft:{target:'#g',body:'Hi'}}}).actions,['sendDraft','discardDraft']);
  const limited=[email({}, {to:Array(101).fill('a@example.com')}),email({}, {cc:['x'.repeat(1001)]}),email({}, {subject:'s'.repeat(2001)}),email({}, {from:'f'.repeat(1001)}),
    {id:'s',sessionId:'s',message:{type:'slack-draft',draft:{target:'t'.repeat(501),body:'Hi'}}},{id:'s',sessionId:'s',draftRouteVerified:{platform:'slack',channelName:'#ok',thread:'t'.repeat(501)},message:{type:'slack-draft',draft:{body:'Hi'}}},
    {id:'m',sessionId:'s',message:{type:'meeting-chat-draft',draft:{meetingId:'m'.repeat(501),body:'Hi'}}},{id:'m',sessionId:'s',message:{type:'meeting-chat-draft',draft:{meetingId:'m',meetingTitle:'t'.repeat(501),body:'Hi'}}}];
  for(const body of limited){const card=project(body);assert.deepEqual(card.actions,['discardDraft'],JSON.stringify(body).slice(0,80));assert.match((card.draft as any).blockedReason,/send unchanged/);}
  assert.equal(project(email({draftRouteVerified:{platform:'email',sendingAddress:'bot@example.com'}},{from:'f'.repeat(1001)})).actions.length,2);
  assert.equal(project(email({}, {to:Array(100).fill('a@example.com'),subject:'s'.repeat(2000)})).actions.length,2);
});

test('review findings: only an explicit acceptance succeeds, zero-byte attachments verify, and lookup errors are scrubbed',async()=>{
  for(const [reply,error] of [[{},/provider refused/],[{accepted:'false'},/provider refused/],[{accepted:false},/provider refused/],[null,/Outcome unknown/],['ok',/Outcome unknown/]] as [any,RegExp][]){
    const {runtime}=harness({'agent-a':[email()]},()=>reply);
    await assert.rejects(runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'Hi',revision:rev(email())}),error);
    await assert.rejects(runtime.command('a','draftDiscard',{id:'d',sessionId:'s',revision:rev(email())}),error);
    runtime.close();
  }
  const empty=email({draftRoute:{platform:'email',attachments:[{path:'/files/empty.txt',filename:'empty.txt',sizeBytes:0}]}});
  const {runtime,sent}=harness({'agent-a':[empty]},m=>m==='ReadGrokBotAgentAttachmentChunk'?{}:{accepted:true});
  assert.deepEqual(await runtime.command('a','draftSend',{id:'d',sessionId:'s',body:'Hi',revision:rev(empty)}),{accepted:true});assert.equal(sent().length,1);runtime.close();
  let failure:Error=new Error('upstream echoed SECRET-DRAFT-BODY');
  const broken=new BotRuntime({identity:async id=>({id,agentId:'agent-'+id,name:id}),rpc:async()=>{throw failure;}});
  await assert.rejects(broken.command('a','draftSend',{id:'d',sessionId:'s',body:'SECRET-DRAFT-BODY',revision:'r'}),(e:Error)=>/could not be loaded/.test(e.message)&&!e.message.includes('SECRET'));
  failure=signedOut();await assert.rejects(broken.command('a','draftDiscard',{id:'d',sessionId:'s',revision:'r'}),/signed out/);
  broken.close();
});
