import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {ConnectionAuth,type ConnectionRpc} from '../src/connection-auth.ts';
import {until} from './helpers.ts';
const open:ConnectionAuth[]=[];
afterEach(()=>{for(const a of open.splice(0))a.close()});
function make(rpc:ConnectionRpc,options:any={ports:[0]}){const a=new ConnectionAuth(rpc,options);open.push(a);return a}
function deferred(){let resolve:(v?:any)=>void=()=>{};const promise=new Promise<any>(r=>resolve=r);return {promise,resolve}}
function callback(flow:any){const auth=new URL(flow.authorizationUrl),u=new URL(auth.searchParams.get('redirect_uri')!);u.hostname='127.0.0.1';u.searchParams.set('state',auth.searchParams.get('state')!);u.searchParams.set('code','code');return u}
function authorize(body:any){const u=new URL('https://provider.test/auth');u.searchParams.set('state','s');u.searchParams.set('redirect_uri',body.oauthRedirectUri);return {statuses:[{serverIdentifier:'s',requiresAuth:true,authUrl:u.href}]}}

test('default options, port fallback, token and signed-in status variants',async()=>{
 for(const status of [{hasValidToken:true},{signedIn:true},{}]){
  const a=make(async()=>({statuses:[{serverIdentifier:'s',...status}]}),{ports:[-1,0]});
  if(status.hasValidToken||status.signedIn)assert.equal((await a.start('s','default',false)).flow?.status,'connected');
  else await assert.rejects(a.start('s','default',false),/setup/);
 }
 const defaultPorts=make(async()=>({statuses:[{serverIdentifier:'s',hasValidToken:true}]}),{});
 assert.equal((await defaultPorts.start('s','default',false)).flow?.status,'connected');
 const busy=make(async()=>({}),{ports:[-1]});await assert.rejects(busy.start('s','default',false),/ports are busy/);
});

test('closing during bind or initiation cannot resurrect a sign-in',async()=>{
 const a=make(async()=>({}));const binding=a.start('s','default',false);a.close();await assert.rejects(binding,/closed/);assert.equal(a.status().flow,null);
 const entered=deferred(),done=deferred();
 const b=make(async()=>{entered.resolve();return done.promise});
 const starting=b.start('s','default',false);await entered.promise;
 await assert.rejects(b.start('s','default',false),/Finish/);
 b.close();done.resolve({});await assert.rejects(starting,/closed/);assert.equal(b.status().flow,null);
});

test('callback completion validates the returned account and handles unverified status',async()=>{
 for(const verified of [undefined,{requiresAuth:true},{isAvailable:false},{hasValidToken:true},{signedIn:true}]){
  let count=0;const a=make(async(_s,m,b:any)=>{
   if(m==='CompleteMcpOAuth')return {accountKey:'actual'};
   if(++count===1)return authorize(b);
   assert.equal(b.accountKey,'actual');return {statuses:verified?[{serverIdentifier:'s',...verified}]:[]};
  });
  const {flow}=await a.start('s','requested',false);const res=await fetch(callback(flow));
  assert.equal(res.status,verified?.hasValidToken||verified?.signedIn?200:400);
 }
});

test('cancel cannot race a code exchange, and closing during either completion stage discards its result',async()=>{
 for(const phase of ['exchange','verify']){
  const entered=deferred(),done=deferred();let checks=0;
  const a=make(async(_s,m,b)=>{
   if(m==='CheckHttpMcpStatus'&&++checks===1)return authorize(b);
   if((phase==='exchange'&&m==='CompleteMcpOAuth')||(phase==='verify'&&m==='CheckHttpMcpStatus')){entered.resolve();await done.promise}
   return m==='CompleteMcpOAuth'?{}:{statuses:[{serverIdentifier:'s',isAvailable:true}]};
  });
  const {flow}=await a.start('s','default',false);const response=fetch(callback(flow)).catch(()=>null);await entered.promise;
  assert.throws(()=>a.cancel(),/finishing/);await assert.rejects(a.start('s','default',false),/Finish/);
  a.close();done.resolve();await response;await until(()=>a.status().flow===null);
 }
});

test('only loopback HTTP authorization is permitted, missing statuses fail visibly',async()=>{
 for(const url of ['http://localhost/auth?state=s','http://127.0.0.1/auth?state=s','http://[::1]/auth?state=s']){
  const a=make(async()=>({statuses:[{serverIdentifier:'s',requiresAuth:true,authUrl:url}]}));assert.equal((await a.start('s','d',false)).flow?.status,'waiting');a.cancel();
 }
 const a=make(async()=>({}));assert.equal(a.cancel().flow,null);await assert.rejects(a.start('s','d',false),/status/);
});

test('a closed initiation cannot clear the starting lock of its replacement',async()=>{
 const old=deferred(),replacement=deferred(),entered=deferred();let calls=0;
 const a=make(async()=>{if(++calls===1){entered.resolve();return old.promise}return replacement.promise});
 const first=a.start('s','d',false);await entered.promise;a.close();
 const second=a.start('s','d',false);await until(()=>calls===2);
 old.resolve({});await assert.rejects(first,/closed/);
 await assert.rejects(a.start('s','d',false),/Finish/);
 replacement.resolve({statuses:[{serverIdentifier:'s',isAvailable:true}]});await second;
});

test('the IPv6 loopback callback completes the same state-bound sign-in',async()=>{
 let checks=0;
 const a=make(async(_service,method,body)=>{
  if(method==='CompleteMcpOAuth')return {};
  return ++checks===1?authorize(body):{statuses:[{serverIdentifier:'s',signedIn:true}]};
 });
 const {flow}=await a.start('s','default',false),url=callback(flow);url.hostname='[::1]';
 assert.equal((await fetch(url)).status,200);assert.equal(a.status().flow?.status,'connected');
});
