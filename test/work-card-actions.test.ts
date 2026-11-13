import assert from 'node:assert/strict';import {test} from 'node:test';
import {BotRuntime} from '../src/bot-runtime.ts';
function fixture(){let entry:any={id:'entry',sessionId:'session',message:{type:'widget',widget:{multiSelect:true,options:[{label:'A'},{label:'B'}]}}};const calls:any[]=[];const runtime=new BotRuntime({identity:async id=>({id,agentId:'uuid-'+id,name:id}),rpc:async(method,body:any)=>{calls.push({method,body});if(method==='ListGrokBotTranscriptEntries')return {entries:body.agentId==='uuid-a'?[{seq:1,body:Buffer.from(JSON.stringify(entry)).toString('base64')}]:[]};if(method==='ReadGrokBotMcpAppDocument')return {html:'<p>App</p>',metaJson:'{}'};if(method==='CallGrokBotMcpAppTool')return {resultJson:'{"content":[]}'};return {accepted:true};}});return {runtime,calls,setEntry:(e:any)=>{entry=e}};}
test('multi-select answers follow provider newline format and validate every current option',async()=>{const {runtime,calls}=fixture();await assert.rejects(runtime.command('a','cardRespond',{id:'entry',sessionId:'session',values:['A','other']}),/current options/);await runtime.command('a','cardRespond',{id:'entry',sessionId:'session',values:['A','B','A']});assert.equal(calls.at(-1).body.value,'A\nB');runtime.close();});
test('connector and credential decisions retain their exact scope and site consent',async()=>{const {runtime,calls,setEntry}=fixture();setEntry({id:'entry',message:{type:'connector-grant',ask:{requestId:'request',status:'pending',serverName:'GitHub'}}});await runtime.command('a','cardDecision',{id:'entry',requestId:'request',decision:'approve'});assert.equal(calls.at(-1).method,'ResolveGrokBotConnectorGrant');assert.equal(calls.at(-1).body.resolution,1);setEntry({id:'entry',message:{type:'credential-request',credentialRequest:{targetSite:'https://example.test',addSite:{registrableDomain:'example.test'}}}});await assert.rejects(runtime.command('a','cardDecision',{id:'entry',requestId:'',decision:'approve'}),/exact site/);await runtime.command('a','cardDecision',{id:'entry',requestId:'',decision:'approve',confirmedAddSite:'example.test'});assert.equal(calls.at(-1).method,'ResolveGrokBotCredentialRequest');assert.equal(calls.at(-1).body.confirmedAddSite,'example.test');runtime.close();});
test('phone controls bind call IDs to the visible bot card and refuse terminal controls',async()=>{const {runtime,calls,setEntry}=fixture();setEntry({id:'entry',message:{type:'phone-call',call:{callId:'call',status:'active',toDisplay:'Verification'}}});await assert.rejects(runtime.command('b','phoneControl',{id:'entry',control:'hangUp'}),/no longer/);await runtime.command('a','phoneControl',{id:'entry',control:'hangUp'});assert.deepEqual(calls.at(-1),{method:'HangUpGrokBotOutboundCall',body:{outboundCallId:'call'}});setEntry({id:'entry',message:{type:'phone-call',call:{callId:'call',status:'ended'}}});await assert.rejects(runtime.command('a','phoneControl',{id:'entry',control:'transfer'}),/no longer/);await runtime.command('a','phoneControl',{id:'entry',control:'retryRecording'});assert.equal(calls.at(-1).method,'RetryGrokBotOutboundCallRecording');runtime.close();});
test('MCP documents have bounded reads and no tool execution without native user confirmation',async()=>{const {runtime,calls,setEntry}=fixture();setEntry({id:'entry',kind:'mcp-app',sessionId:'session',resourceUri:'ui://app'});assert.equal((await runtime.command('a','mcpOpen',{id:'entry'})).html,'<p>App</p>');await assert.rejects(runtime.command('b','mcpOpen',{id:'entry'}),/no longer/);await assert.rejects(runtime.command('a','mcpCall',{id:'entry',toolName:'search',arguments:{q:'test'}}),/Confirm/);await runtime.command('a','mcpCall',{id:'entry',toolName:'search',arguments:{q:'test'},userConfirmed:true});assert.equal(calls.at(-1).body.agentId,'uuid-a');assert.equal(calls.at(-1).body.sessionId,'session');assert.equal(calls.at(-1).body.userActivated,true);runtime.close();});

test('MCP reads preserve exact original inputs and reject oversized, refused and malformed tool results',async()=>{
 let document:any={html:'<p>App</p>',metaJson:'{}'},result:any={resultJson:'{}'};
 const source={id:'entry',kind:'mcp-app',sessionId:'s',toolArgumentsJson:'{"q":"original"}',toolResultJson:'{"content":[]}'};
 const runtime=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),rpc:async method=>{if(method==='ListGrokBotTranscriptEntries')return {entries:[{seq:2,body:Buffer.from(JSON.stringify(source)).toString('base64')}]};return method==='ReadGrokBotMcpAppDocument'?document:result;}});
 const open=await runtime.command('a','mcpOpen',{id:'entry'});assert.equal(open.toolArgumentsJson,source.toolArgumentsJson);assert.equal(open.toolResultJson,source.toolResultJson);
 document={html:'x'.repeat(4*1024*1024+1)};await assert.rejects(runtime.command('a','mcpOpen',{id:'entry'}),/size limit/);
 document={html:null};await assert.rejects(runtime.command('a','mcpOpen',{id:'entry'}),/unavailable/);
 const args={id:'entry',toolName:'search',arguments:{},userConfirmed:true};
 await assert.rejects(runtime.command('a','mcpCall',{...args,arguments:{q:'x'.repeat(500001)}}),/size limit/);
 result={failure:{reason:'denied'}};await assert.rejects(runtime.command('a','mcpCall',args),/refused/);
 for(const value of [null,'x'.repeat(4*1024*1024+1)]){result={resultJson:value};await assert.rejects(runtime.command('a','mcpCall',args),/invalid tool result/);}runtime.close();
});

test('payment commands use the current bot card and preserve provider authentication decisions',async()=>{
 let status='pending';const calls:any[]=[];
 const runtime=new BotRuntime({identity:async id=>({id,agentId:'uuid-'+id,name:id}),rpc:async(method,body)=>{calls.push({method,body});if(method==='ListGrokBotTranscriptEntries')return {entries:[{seq:1,body:Buffer.from(JSON.stringify({id:'entry',message:{type:'virtual-card-approval',approval:{requestId:'request',status}}})).toString('base64')}]};if(method==='ListGrokBotStripeLinkPaymentMethods')return {outcome:'OK',paymentMethods:[{id:'method'}]};if(method==='BeginGrokBotSpendApproval')return {};if(method==='ResolveGrokBotVirtualCardApproval')return {outcome:'APPROVED'};return {};}});
 assert.equal((await runtime.command('a','paymentMethods',{id:'entry'})).methods.length,1);
 const ceremony=await runtime.command('a','paymentBegin',{id:'entry',paymentMethodId:'method'});
 await runtime.command('a','paymentFinish',{id:'entry',ceremonyId:ceremony.id});assert.equal(calls.at(-1).body.agentId,'uuid-a');
 await assert.rejects(runtime.command('a','cardDecision',{id:'entry',requestId:'request',decision:'approve'}),/secure verification/);
 await runtime.command('a','cardDecision',{id:'entry',requestId:'request',decision:'deny'});assert.equal(calls.at(-1).body.resolution,2);
 status='approved';await assert.rejects(runtime.command('a','paymentMethods',{id:'entry'}),/pending/);runtime.close();
});

test('forms require valid typed values and exact options, while dismissal and unknown dispatch remain distinct',async()=>{
 let response:any={},fail:Error|undefined;let card:any={id:'entry',sessionId:'s',message:{type:'user-form',formRequest:{fields:[{id:'yes',type:'checkbox',required:true},{id:'option',type:'select',options:[{label:'One',value:'1'}]}]}}};const calls:any[]=[];
 const runtime=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),rpc:async(method,body)=>{calls.push({method,body});if(method==='ListGrokBotTranscriptEntries')return {entries:[{seq:1,body:Buffer.from(JSON.stringify(card)).toString('base64')}]};if(fail)throw fail;return response;}});
 for(const values of [{yes:1},{yes:'false'},{yes:'true',option:'2'},{yes:'true',option:'x'.repeat(100001)}])await assert.rejects(runtime.command('a','cardRespond',{id:'entry',sessionId:'s',values}),/form|required|option/);
 await runtime.command('a','cardRespond',{id:'entry',sessionId:'s',values:{yes:'true',option:'1'}});assert.deepEqual(calls.at(-1).body.values,{yes:'true',option:'1'});
 await runtime.command('a','cardRespond',{id:'entry',sessionId:'s',dismiss:true});assert.equal(calls.at(-1).method,'DismissGrokBotUserForm');
 fail=new Error('Provider secret');await assert.rejects(runtime.command('a','cardRespond',{id:'entry',sessionId:'s',dismiss:true}),/Outcome unknown/);
 fail.name='SignedOutError';await assert.rejects(runtime.command('a','cardRespond',{id:'entry',sessionId:'s',dismiss:true}),e=>e===fail);
 fail=undefined;response={refusal:{reason:'permission'}};await assert.rejects(runtime.command('a','cardRespond',{id:'entry',sessionId:'s',dismiss:true}),/refused/);
 card={id:'entry',sessionId:'s',message:{type:'widget',widget:{multiSelect:true,allowCustom:true}}};for(const values of [null,[],Array(101).fill('A')])await assert.rejects(runtime.command('a','cardRespond',{id:'entry',sessionId:'s',values}),/at least/);
 runtime.close();
});

test('an ambiguous approval value cannot authorize any request',async()=>{
 const {runtime}=fixture();await assert.rejects(runtime.command('a','cardDecision',{id:'entry',decision:'yes'}),/approve or deny/);runtime.close();
});
