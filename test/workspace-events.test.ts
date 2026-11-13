import assert from 'node:assert/strict';import {test} from 'node:test';import {BotRuntime} from '../src/bot-runtime.ts';import {until} from './helpers.ts';
const body=Buffer.from(JSON.stringify({id:'entry',kind:'send-message',message:{type:'text',content:'Result'}})).toString('base64');
test('activity invalidation uses one authenticated account stream and never wakes an asleep computer',async()=>{
 let notices=0,streams=0;const calls:any[]=[];
 const runtime=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),now:()=>5000,accessToken:()=> 'account-token',onChanged:()=>{notices++},rpc:async(method,args)=>{calls.push({method,args});if(method==='GetSandBoxRunState')return {state:'SAND_BOX_RUN_STATE_RUNNING'};if(method==='EnsureSandBox')return {gatewayUrl:'https://gateway.test',gatewayToken:'gateway-token',gatewayPortToken:'port-token'};return {entries:[{seq:1,body}]};},fetch:async(_url,options)=>{
  streams++;assert.equal((options!.headers as any).authorization,'Bearer account-token');assert.equal((options!.headers as any)['x-sand-gateway-token'],'gateway-token');
  return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: {"changed":true}\r\n\r\n'));options!.signal!.addEventListener('abort',()=>controller.close(),{once:true});}}));
 }});
 await runtime.command('a','activity');await runtime.command('b','activity');await until(()=>notices===1);assert.equal(streams,1);assert.equal(calls.find(c=>c.method==='EnsureSandBox').args.wake,false);runtime.close();
 let ensured=false;
 const asleep=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),onChanged:()=>{throw new Error('should not notify')},rpc:async(method)=>{if(method==='GetSandBoxRunState')return {state:'SAND_BOX_RUN_STATE_HIBERNATED'};if(method==='EnsureSandBox')ensured=true;return {entries:[]};}});
 await asleep.command('a','activity');await new Promise(r=>setImmediate(r));assert.equal(ensured,false);asleep.close();
});
test('offline activity restores only saved read-only metadata and never hides signed-out status',async()=>{
 let fail=false;const saved:any[]=[];
 const runtime=new BotRuntime({identity:async id=>({id,agentId:'uuid-'+id,name:id}),rpc:async()=>{if(fail)throw new Error('Offline');return {entries:[{seq:1,body}]};},saveActivity:(id,cards)=>saved.push({id,cards}),loadActivity:(_id,before)=>{assert.equal(before,2);return saved[0].cards.map((c:any)=>({...c,text:'',actions:[]}));}});
 await runtime.command('a','activity');assert.equal(saved[0].id,'uuid-a');fail=true;
 const offline=await runtime.command('a','activity',{beforeSeq:2});assert.equal(offline.stale,true);assert.deepEqual(offline.cards[0].actions,[]);assert.equal(offline.cards[0].text,'');runtime.close();
});

test('oversized event streams back off without blocking reads or exposing their payloads',async()=>{
 let now=5000,streams=0,notices=0;
 const runtime=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),now:()=>now,onChanged:()=>{notices++},rpc:async method=>method==='EnsureSandBox'?{gatewayUrl:'https://gateway.test'}:method==='GetSandBoxRunState'?{state:'SAND_BOX_RUN_STATE_RUNNING'}:{entries:[]},fetch:async()=>{streams++;return new Response('data: '+'x'.repeat(1024*1024+1));}});
 await runtime.command('a','activity');await new Promise(r=>setImmediate(r));
 await runtime.command('a','activity');assert.equal(streams,1);assert.equal(notices,0);
 now+=31000;await runtime.command('a','activity');await new Promise(r=>setImmediate(r));assert.equal(streams,2);runtime.close();
});
