import assert from 'node:assert/strict';
import {test} from 'node:test';
import {workCards} from '../src/work-cards.ts';
const entry=(seq:number,body:any)=>({seq,body:Buffer.from(JSON.stringify(body)).toString('base64')});
test('activity retains exact request identity, sorts cards and fails closed for unknown kinds',()=>{
 const result=workCards({entries:[entry(2,{id:'card',sessionId:'s',message:{type:'auto-review-approval',approval:{requestId:'request',status:'pending',summary:'Deploy'}}}),entry(3,{message:{type:'new-provider-card',content:'Result'}}),{seq:4,body:'malformed'}]});
 assert.equal(result.beforeSeq,2);assert.equal(result.cards[0].kind,'new-provider-card');assert.deepEqual(result.cards[0].actions,[]);
 assert.deepEqual(result.cards[1].actions,['approve','deny']);assert.equal(result.cards[1].requestId,'request');assert.equal(result.cards[1].sessionId,'s');
});
test('resolved, anonymous and secret cards never expose actions or credential bodies',()=>{
 for(const status of ['approved','denied','expired','unknown']) {
  const card=workCards({entries:[entry(1,{id:'i',message:{type:'local-tool-permission',ask:{status,requestId:'r'}}})]}).cards[0];assert.deepEqual(card.actions,[]);
 }
 const cards=workCards({entries:[entry(1,{message:{type:'secret-request',content:'SECRET'}}),entry(2,{message:{type:'auto-review-approval',approval:{status:'pending',requestId:'r'}}})]}).cards;
 assert.doesNotMatch(JSON.stringify(cards),/SECRET/);assert.ok(cards.every(c=>!c.actions.length));
 assert.deepEqual(workCards(null),{cards:[],beforeSeq:null});
});

test('malformed entries and unsupported payment forms never enable submissions',()=>{
 const result=workCards({entries:[null,{},entry(1,null),entry(2,[]),entry(3,{id:'form',message:{type:'user-form',formRequest:{fields:[null]}}}),entry(4,{id:'payment',message:{type:'user-form',formRequest:{fields:[{id:'cc_number',label:'Card',type:'text'}]}}}),entry(5,{id:'widget',message:{type:'widget',widget:{options:[null,{label:'A'}]}}})]});
 assert.deepEqual(result.cards.find(c=>c.id==='form')!.actions,[]);assert.deepEqual(result.cards.find(c=>c.id==='payment')!.actions,[]);
 assert.deepEqual(result.cards.find(c=>c.id==='widget')!.options,[{label:'A',value:'A'}]);
});

test('native setup, connections, resources and result cards retain useful recovery controls',()=>{
 for(const kind of ['cookie-origin-approval','mobile-tool-permission','onepassword-connect']){
  const card=workCards({entries:[entry(1,{id:'e',message:{type:kind}})]}).cards[0];assert.deepEqual(card.actions,['nativeSetup']);
 }
 for(const kind of ['connector','connectors','scm-connect','slack-connect','listener-connect','app-secrets-request'])assert.deepEqual(workCards({entries:[entry(1,{id:'e',message:{type:kind}})]}).cards[0].actions,['manageConnections']);
 assert.deepEqual(workCards({entries:[entry(1,{id:'e',message:{type:'bot-resources'}})]}).cards[0].actions,['openKnowledge']);
 const payment=workCards({entries:[entry(1,{id:'e',message:{type:'virtual-card-approval',approval:{requestId:'r',amountCents:1234,networkId:'network',merchantName:'Merchant'}}})]}).cards[0];assert.equal(payment.details.amountCents,'1234');assert.equal(payment.details.networkId,'network');
 for(const url of ['https://results.example.com/page','http://localhost/file','https://u:p@results.example.com','not a URL']){
  const card=workCards({entries:[entry(1,{id:'e',message:{type:'visualization',url,resultUrl:url,recording:{url}}})]}).cards[0];assert.equal(card.links.length,url.startsWith('https://results.')?3:0);
 }
 const native=workCards({entries:[entry(1,{id:'e',message:{type:'credential-request',credentialRequest:{appLink:'onepassword://request'}}})]}).cards[0];assert.equal(native.nativeRequired,true);assert.deepEqual(native.actions,['nativeSetup']);
 const event=workCards({entries:[entry(1,{id:'e',kind:'event',event:{type:'automation-changed'}})]}).cards[0];assert.equal(event.kind,'automation-changed');
});

test('form options, draft variants and resolved widgets are projected without executable payloads',()=>{
 const form=workCards({entries:[entry(1,{id:'e',message:{type:'user-form',formRequest:{fields:[{id:'option',type:'select',options:[null,{label:'One',value:'1'}]}]}}})]}).cards[0];assert.deepEqual(form.fields[0].options,[{label:'One',value:'1'}]);
 for(const kind of ['email-draft','slack-draft','meeting-chat-draft','imessage-draft']){
  const draft={from:'sender',to:kind==='email-draft'?['recipient',null]:'recipient',cc:['copy',false],subject:'Subject',workspace:'workspace',target:'target',thread:'thread',meetingId:'meeting',chatId:'chat',recipientName:'Name',body:'Draft'};
  const card=workCards({entries:[entry(1,{id:'e',message:{type:kind,draft}})]}).cards[0];assert.equal(card.draft?.body,'Draft');assert.deepEqual(card.actions,kind==='imessage-draft'?['discardDraft']:['sendDraft','discardDraft']);
 }
 for(const body of [{widgetDismissed:true},{respondedValue:'One'}])assert.deepEqual(workCards({entries:[entry(1,{id:'e',...body,message:{type:'widget',widget:{options:[{label:'One'}]}}})]}).cards[0].actions,[]);
});

test('oversized entries, invalid sequence numbers and unlabeled widget options are not actionable',()=>{
 const cards=workCards({entries:[{seq:'bad',body:'e30='},{seq:1,body:'x'.repeat(4*1024*1024+1)},entry(2,{content:'Event summary',kind:'event'}),entry(3,{id:'e',message:{type:'widget',widget:{options:[{value:'no label'}]}}})]}).cards;
 assert.equal(cards.length,2);assert.equal(cards[1].text,'Event summary');assert.deepEqual(cards[0].options,[]);
});

test('instructions and attachment names are retained as readable fallback text',()=>{
 for(const body of [{id:'e',message:{type:'widget',widget:{instruction:'Instruction'}}},{id:'e',message:{type:'attachment',file_name:'report.pdf'}},{id:'e',message:{type:'slack-draft',draft:{body:'Body only'}}}]){
  const card=workCards({entries:[entry(1,body)]}).cards[0];assert.equal(card.text,body.message.type==='widget'?'Instruction':body.message.type==='slack-draft'?'Body only':'report.pdf');
 }
});

test('informational events show their own metadata and computer goals open the correct workspace tab',()=>{
 const cards=workCards({entries:[entry(1,{id:'event',kind:'event',event:{type:'automation-changed',name:'Routine',summary:'Updated'}}),entry(2,{id:'goal',kind:'event',event:{type:'desktop-goal',summary:'Review browser'}})]}).cards;
 assert.equal(cards[0].status,'info');assert.deepEqual(cards[0].actions,['openComputer']);assert.equal(cards[1].text,'Updated');assert.equal(cards[1].details.name,'Routine');
});
