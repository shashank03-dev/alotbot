import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {resolveViewer, RfbInputGate, ComputerViewer} from '../src/computer-viewer.ts';
const box={vncUrl:'https://main.provider.test/vnc.html?network_token=secret',forkVncBaseUrl:'https://fork.provider.test',networkToken:'secret'};
test('internal bot screens resolve only through the provider routes and retain display tokens server-side',()=>{
 const url=resolveViewer('http://127.0.0.1:6081/vnc.html?path=websockify%3Ftoken%3Dbot-screen',box);
 assert.equal(url.hostname,'fork.provider.test');assert.equal(url.searchParams.get('network_token'),'secret');assert.match(url.searchParams.get('path')!,/token=bot-screen/);
 assert.equal(resolveViewer('http://127.0.0.1:6080/vnc.html',box).hostname,'main.provider.test');
 assert.throws(()=>resolveViewer('https://evil.test/vnc.html',box),/untrusted/);
});
test('RFB input is blocked in view-only mode and fragmented held keys are released when control ends',()=>{
 const gate=new RfbInputGate();
 gate.ready();
 const key=Buffer.from([4,1,0,0,0,0,0,65]);
 assert.equal(gate.client(key,false).length,0);
 assert.equal(gate.client(key.subarray(0,3),true).length,0);
 assert.equal(gate.client(key.subarray(3),true).length,1);
 const release=gate.release();assert.equal(release[0][0],4);assert.equal(release[0][1],0);assert.equal(gate.release().length,0);
 const request=Buffer.from([3,0,0,0,0,0,0,10,0,10]);assert.deepEqual(gate.client(request,false),[request]);
});
test('viewer capabilities do not expose upstream credentials and expire on close',async()=>{
 const runtime:any={identity:async()=>({id:'b',agentId:'a',name:'Bot'}),computerConnection:async()=>({bot:{id:'b',agentId:'a',name:'Bot'},status:{state:'running',vncUrl:'http://127.0.0.1:6080/vnc.html',windows:[]},box})};
 const v=new ComputerViewer(runtime,{origin:()=> 'http://127.0.0.1:1234'});
 const opened=await v.open('b');assert.equal(new URL(new URL(opened.url).searchParams.get('path')!,opened.url).pathname,`/computer/${opened.id}/socket`);assert.doesNotMatch(opened.url,/secret|provider/);assert.ok(opened.authorization);
 await v.control(opened.id,false);v.close(opened.id);await assert.rejects(v.control(opened.id,true),/closed/);v.closeAll();
});

test('viewer state and disconnect reject other bots, and takeover waits for RFB initialization',async()=>{
 const runtime:any={identity:async()=>({id:'a'}),command:async()=>({}),computerConnection:async()=>({status:{state:'running',vncUrl:'http://127.0.0.1:6080/vnc.html'},box})};
 const viewer=new ComputerViewer(runtime,{origin:()=> 'http://127.0.0.1:1234'}),opened=await viewer.open('a');
 assert.throws(()=>viewer.state(opened.id,'b'),/another bot/);
 await assert.rejects(viewer.disconnect(opened.id,'b'),/another bot/);
 await assert.rejects(viewer.control(opened.id,true,'a'),/Wait/);
 assert.equal(viewer.state(opened.id,'a').hasControl,false);
 await viewer.disconnect(opened.id,'a');assert.throws(()=>viewer.state(opened.id,'a'),/closed/);
});
test('closing or disabling during access validation cannot grant stale control',async()=>{
 let release!:()=>void;
 const runtime:any={identity:async()=>await new Promise(resolve=>{release=()=>resolve({id:'a'})}),computerConnection:async()=>({status:{vncUrl:'http://127.0.0.1:6080/vnc.html'},box})};
 const viewer=new ComputerViewer(runtime,{origin:()=> 'http://127.0.0.1:1234'}),opened=await viewer.open('a');
 const pending=viewer.control(opened.id,true,'a');viewer.close(opened.id);release();assert.deepEqual(await pending,{hasControl:false});
 viewer.closeAll();
});
test('RFB handshake parses fragmented frames and rejects unsupported protocols and input',()=>{
 const gate=new RfbInputGate();
 const version=Buffer.from('RFB 003.008\n');gate.server(version.subarray(0,3));gate.server(version.subarray(3));
 assert.deepEqual(gate.client(version,false),[version]);gate.server(Buffer.from([1,1]));gate.client(Buffer.from([1]),false);
 gate.server(Buffer.alloc(4));gate.client(Buffer.from([1]),false);
 const init=Buffer.alloc(24);init.writeUInt16BE(1920,0);init.writeUInt16BE(1200,2);gate.server(init.subarray(0,20));assert.equal(gate.isReady(),false);gate.server(init.subarray(20));assert.equal(gate.isReady(),true);
 assert.throws(()=>gate.client(Buffer.from([100]),true),/Unsupported/);
 assert.throws(()=>new RfbInputGate().server(Buffer.from('RFB 003.003\n')),/Unsupported/);
 const pointer=new RfbInputGate();pointer.ready();assert.equal(pointer.client(Buffer.from([5,1,0,1,0,2]),false).length,0);pointer.client(Buffer.from([5,1,0,1,0,2]),true);assert.equal(pointer.release()[0][1],0);
});

test('desktop HTTP serves only authenticated same-viewer assets and rejects absolute URL escapes',async()=>{
 const http=await import('node:http');let origin='';const fetched:string[]=[];
 const runtime:any={identity:async()=>({id:'a'}),computerConnection:async()=>({status:{vncUrl:'http://127.0.0.1:6080/vnc.html'},box})};
 const manager=new ComputerViewer(runtime,{origin:()=>origin,fetch:async url=>{fetched.push(String(url));return new Response('<html>viewer</html>',{headers:{'content-type':'text/html'}});}});
 const server=http.createServer((req,res)=>{void manager.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}})});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(server.address() as any).port}`;
 try {
  const opened=await manager.open('a');const headers={authorization:opened.authorization};
  assert.equal((await fetch(opened.url)).status,403);
  const page=await fetch(opened.url,{headers});assert.equal(page.status,200);assert.equal(await page.text(),'<html>viewer</html>');assert.match(page.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
  const cookie=page.headers.get('set-cookie')!.split(';')[0];assert.equal((await fetch(`${origin}/computer/${opened.id}/app/ui.js`,{headers:{cookie}})).status,200);
  const count=fetched.length;
  for(const asset of ['http://evil.test/a','//evil.test/a','a%5Cb','a%2fb']) assert.equal((await fetch(`${origin}/computer/${opened.id}/${asset}`,{headers})).status,403);
  // URL parsers normalize encoded dot segments before sending; the resulting unknown capability still fails closed.
  assert.equal((await fetch(`${origin}/computer/${opened.id}/%2e%2e/a`,{headers})).status,502);
  assert.equal(fetched.length,count);
  assert.equal((await fetch(opened.url,{headers,method:'POST'})).status,403);
  assert.equal((await fetch(opened.url,{headers,method:'HEAD'})).status,200);
  manager.close(opened.id);assert.equal((await fetch(opened.url,{headers})).status,502);
 }finally{manager.closeAll();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('real WebSocket relay gates input and releases held keys on hand-back and disconnect',async()=>{
 const http=await import('node:http');const {WebSocket,WebSocketServer}=await import('ws');
 const remoteServer=http.createServer();const remoteWss=new WebSocketServer({server:remoteServer});const received:Buffer[]=[];
 remoteWss.on('connection',socket=>{
  let phase=0;socket.send(Buffer.from('RFB 003.008\n'));
  socket.on('message',data=>{const b=Buffer.from(data as any);
   if(phase===0){phase++;socket.send(Buffer.from([1,1]));}
   else if(phase===1){phase++;socket.send(Buffer.alloc(4));}
   else if(phase===2){phase++;const init=Buffer.alloc(24);init.writeUInt16BE(100,0);init.writeUInt16BE(100,2);socket.send(init);}
   else received.push(b);
  });
 });
 await new Promise<void>(r=>remoteServer.listen(0,'127.0.0.1',r));const remote=`ws://127.0.0.1:${(remoteServer.address() as any).port}`;
 let origin='',access=true;const runtime:any={identity:async()=>{if(!access)throw new Error('Access revoked');return {id:'a'}},computerConnection:async()=>({status:{vncUrl:'http://127.0.0.1:6080/vnc.html'},box})};
 const manager=new ComputerViewer(runtime,{origin:()=>origin,openSocket:()=>new WebSocket(remote,['binary'])});
 const server=http.createServer();server.on('upgrade',(req,socket,head)=>{if(!manager.upgrade(req,socket,head))socket.destroy()});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address() as any).port}`;
 let client:InstanceType<typeof WebSocket>|undefined;
 try {
  const opened=await manager.open('a');
  client=new WebSocket(`${origin.replace('http:','ws:')}/computer/${opened.id}/socket`,['binary'],{origin,headers:{authorization:opened.authorization}});
  await new Promise<void>((resolve,reject)=>{
   let phase=0;const timeout=setTimeout(()=>reject(new Error('Handshake timeout')),2000);
   client!.on('error',reject);client!.on('message',()=>{if(phase===0){phase++;client!.send(Buffer.from('RFB 003.008\n'));}else if(phase===1){phase++;client!.send(Buffer.from([1]));}else if(phase===2){phase++;client!.send(Buffer.from([1]));}else{clearTimeout(timeout);resolve();}});
  });
  assert.equal(manager.state(opened.id,'a').connected,true);
  const key=Buffer.from([4,1,0,0,0,0,0,65]);client.send(key);
  await new Promise(r=>setTimeout(r,20));assert.equal(received.length,0);
  await manager.control(opened.id,true,'a');client.send(key);await new Promise(r=>setTimeout(r,20));assert.equal(received.length,1);assert.equal(received[0][1],1);
  await manager.control(opened.id,false,'a');await new Promise(r=>setTimeout(r,20));assert.equal(received.length,2);assert.equal(received[1][1],0);
  await manager.control(opened.id,true,'a');client.send(key);await new Promise(r=>setTimeout(r,20));
  access=false;await assert.rejects(manager.validateState(opened.id,'a'),/revoked/);assert.throws(()=>manager.state(opened.id),/closed/);
 } finally {
  client?.terminate();manager.closeAll();for(const socket of remoteWss.clients)socket.terminate();remoteWss.close();
  server.closeAllConnections();remoteServer.closeAllConnections();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>remoteServer.close(()=>r()))]);
 }
});

test('desktop routes reject credentials, insecure providers, absent fork tokens and unowned monitors',async()=>{
 for(const bad of [{...box,vncUrl:'http://main.provider.test/vnc.html'},{...box,forkVncBaseUrl:'http://fork.provider.test'},{...box,vncUrl:'https://u:p@main.provider.test/vnc.html'},{...box,forkVncBaseUrl:'https://u:p@fork.provider.test'}])assert.throws(()=>resolveViewer('http://localhost:6080/vnc.html',bad),/untrusted/);
 assert.throws(()=>resolveViewer('http://u:p@localhost:6080/vnc.html',box),/untrusted/);
 assert.throws(()=>resolveViewer('http://localhost:6081/vnc.html',{...box,networkToken:''}),/credential/);
 const fork=resolveViewer('http://localhost:6081/vnc.html',{...box,forkVncPortToken:'port'});assert.equal(fork.searchParams.get('port_token'),'port');
 assert.equal(resolveViewer('https://main.provider.test/vnc.html',box).hostname,'main.provider.test');
 const runtime:any={computerConnection:async()=>({status:{vncUrl:'http://localhost:6080/vnc.html',windows:[{subagentId:'screen',vncUrl:'http://localhost:6081/vnc.html'}]},box}),identity:async()=>({id:'a'})};
 let now=0;const manager=new ComputerViewer(runtime,{origin:()=> 'http://localhost:1234',now:()=>now});
 await assert.rejects(manager.open('a','missing'),/no longer available/);
 const first=await manager.open('a','screen');const second=await manager.open('a');assert.throws(()=>manager.state(first.id),/closed/);
 now=30*60_000;assert.throws(()=>manager.state(second.id),/closed/);manager.closeAll();
 const unsafe=new ComputerViewer({computerConnection:async()=>({status:{vncUrl:'https://main.provider.test/vnc.html?path=https://evil.test/socket'},box})}as any,{origin:()=> 'http://localhost:1234'});
 await assert.rejects(unsafe.open('a'),/untrusted origin/);
});

test('RFB negotiation and every supported packet obey input boundaries and release state',()=>{
 const version=Buffer.from('RFB 003.008\n');
 const invalid=new RfbInputGate();assert.throws(()=>invalid.client(Buffer.from('RFB 003.003\n'),false),/handshake/);
 const security=new RfbInputGate();security.client(version,false);assert.throws(()=>security.client(Buffer.from([2]),false),/security/);
 const unsupported=new RfbInputGate();unsupported.server(version);assert.throws(()=>unsupported.server(Buffer.from([1,2])),/authentication mode/);
 const refused=new RfbInputGate();refused.server(version);refused.server(Buffer.from([1,1]));assert.throws(()=>refused.server(Buffer.from([0,0,0,1])),/refused/);
 const init=new RfbInputGate();init.server(version);init.server(Buffer.from([1,1]));init.server(Buffer.alloc(4));const huge=Buffer.alloc(24);huge.writeUInt32BE(1024*1024,20);assert.throws(()=>init.server(huge),/initialization/);
 const g=new RfbInputGate();g.client(version.subarray(0,3),false);g.client(version.subarray(3),false);g.client(Buffer.from([1,1]),false);
 assert.equal(g.client(Buffer.from([3,0,0,0,0,0,0,1,0,1]),false).length,0);g.ready();assert.equal(g.client(Buffer.alloc(0),false).length,1);
 const packets=[Buffer.alloc(20),Buffer.from([2,0,0,1,0,0,0,1]),Buffer.from([150,0,0,0,0,0,0,0,0,0]),Buffer.from([248,0,0,0,0,0,0,0,1,0])];
 for(const packet of packets){assert.equal(g.client(packet.subarray(0,1),false).length,0);assert.equal(g.client(packet.subarray(1),false).length,1);}
 for(const packet of [Buffer.from([6,0,0,0,0,0,0,1,65]),Buffer.from([251,0,0,0,0,0,1,0,...Buffer.alloc(16)]),Buffer.from([255,0,0,1,0,0,0,65,0,0,0,1])]){
  assert.equal(g.client(packet.subarray(0,1),false).length,0);assert.equal(g.client(packet.subarray(1),false).length,0);
  assert.equal(g.client(packet,true).length,1);
 }
 assert.equal(g.release()[0].readUInt16BE(2),0);
 const key=Buffer.from([4,1,0,0,0,0,0,65]);g.client(key,true);key[1]=0;g.client(key,true);assert.equal(g.release().length,0);
 const pointer=Buffer.from([5,0,0,1,0,2]);g.client(pointer,true);assert.equal(g.release().length,0);
 assert.throws(()=>g.client(Buffer.from([255,1]),true),/extended/);
 const large=Buffer.alloc(8);large[0]=6;large.writeInt32BE(2*1024*1024,4);const limited=new RfbInputGate();limited.ready();assert.throws(()=>limited.client(large,true),/limit/);
 assert.throws(()=>new RfbInputGate().client(Buffer.alloc(2*1024*1024+1),false),/limit/);
});

test('viewer expiry invalidates its capability even without a state poll',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const runtime:any={computerConnection:async()=>({status:{vncUrl:'http://localhost:6080/vnc.html'},box})};
 const manager=new ComputerViewer(runtime,{origin:()=> 'http://localhost:1234',now:()=>0});
 const opened=await manager.open('a');t.mock.timers.tick(30*60_000);
 assert.throws(()=>manager.state(opened.id),/closed/);manager.closeAll();
});

const ownBox={vncUrl:'https://main.provider.test/vnc.html?network_token=secret',networkToken:'secret'};
const rfbVersion=Buffer.from('RFB 003.008\n');
function fakeResponse(write:(this:any,data:Uint8Array)=>boolean){
 const res:any=Object.assign(new EventEmitter(),{destroyed:false,headersSent:false,status:0,body:[] as number[],ended:false,
  writeHead(code:number){this.status=code;this.headersSent=true;return this},write,end(){this.ended=true},destroy(this:any){this.destroyed=true;this.emit('close')}});
 return res;
}
async function fakeViewer(fetchImpl?:typeof fetch,status:any={vncUrl:'http://localhost:6080/vnc.html'}){
 const calls:any[]=[];
 const runtime:any={identity:async(id:string)=>({id}),command:async(...args:any[])=>{calls.push(args);return args[1]==='computerStatus'?status:{}},computerConnection:async()=>({status,box:ownBox})};
 const manager=new ComputerViewer(runtime,{origin:()=> 'http://localhost:1234',...(fetchImpl?{fetch:fetchImpl}:{})});
 return {manager,calls};
}
const request=(url:string|undefined,authorization:string,method:string|undefined)=>({url,method,headers:{host:'localhost:1234',authorization}}) as any;

test('RFB release keeps the parser aligned mid-packet and tracks QEMU keys by keycode',()=>{
 const g=new RfbInputGate();g.ready();
 const update=Buffer.from([3,0,0,0,0,0,0,10,0,10]);
 assert.equal(g.client(update.subarray(0,3),false).length,0);g.release();
 assert.deepEqual(g.client(update.subarray(3),false),[update]);
 const qemu=(keycode:number,down:number)=>{const b=Buffer.alloc(12);b[0]=255;b.writeUInt16BE(down,2);b.writeUInt32BE(keycode,8);return b};
 assert.equal(g.client(Buffer.concat([qemu(30,1),qemu(31,1)]),true).length,2);
 const released=g.release();assert.deepEqual(released.map(b=>[b.readUInt16BE(2),b.readUInt32BE(8)]),[[0,30],[0,31]]);
 g.client(qemu(30,1),true);g.client(qemu(30,0),true);assert.equal(g.release().length,0);
 // A partial key that completes after control ends is dropped, never forwarded.
 const key=Buffer.from([4,1,0,0,0,0,0,65]);g.client(key.subarray(0,4),true);g.release();assert.equal(g.client(key.subarray(4),false).length,0);assert.equal(g.release().length,0);
});

test('RFB server parsing waits for a fragmented desktop name and ignores frames after initialization',()=>{
 const g=new RfbInputGate();g.server(Buffer.concat([rfbVersion,Buffer.from([1,1]),Buffer.alloc(4)]));
 const init=Buffer.alloc(28);init.writeUInt32BE(4,20);init.write('desk',24);
 g.server(init.subarray(0,26));assert.equal(g.isReady(),false);g.server(init.subarray(26));assert.equal(g.isReady(),true);
 assert.doesNotThrow(()=>g.server(Buffer.from('not a handshake')));assert.equal(g.isReady(),true);
});

test('missing fork routes fail visibly instead of constructing a broken nested viewer URL',()=>{
 assert.throws(()=>resolveViewer('http://127.0.0.1:6081/vnc.html',{vncUrl:'https://main.provider.test/desk/vnc.html',networkToken:'n'}),/not supplied/);
});

test('viewer lifecycle: window index lookup, missing window lists, hand-back on disconnect, wrong-bot control and closeAll',async()=>{
 const {manager:noWindows}=await fakeViewer(undefined,{vncUrl:'http://localhost:6080/vnc.html'});
 await assert.rejects(noWindows.open('a','0'),/no longer available/);
 const {manager,calls}=await fakeViewer(undefined,{vncUrl:'http://localhost:6080/vnc.html',windows:[{windowIndex:2,vncUrl:'http://localhost:6080/vnc.html'}],handoff:{requestId:'req-1'}});
 const opened=await manager.open('a','2');
 await assert.rejects(manager.control(opened.id,false,'b'),/another bot/);
 assert.deepEqual(await manager.validateState(opened.id,'a'),{connected:false,hasControl:false,error:null});
 assert.deepEqual(await manager.disconnect(opened.id,'a'),{ok:true});
 assert.deepEqual(calls,[['a','computerStatus'],['a','handBack',{requestId:'req-1',trigger:'viewer-closed'}]]);
 const one=await manager.open('a'),two=await manager.open('b');manager.closeAll();
 for(const id of [one.id,two.id])assert.throws(()=>manager.state(id),/closed/);
});

test('desktop HTTP fails closed on non-viewer paths, missing methods, empty or unsafe assets',async()=>{
 const fetched:string[]=[];const {manager}=await fakeViewer(async url=>{fetched.push(String(url));return new Response('x')});
 const opened=await manager.open('a'),path=new URL(opened.url).pathname,res=()=>fakeResponse(function(){return true});
 assert.equal(await manager.handle(request(undefined,opened.authorization,'GET'),res()),false);
 assert.equal(await manager.handle(request('/other',opened.authorization,'GET'),res()),false);
 for(const [url,method] of [[path,undefined],[`/computer/${opened.id}/`,'GET'],[`/computer/${opened.id}/a:b`,'GET'],[`/computer/${opened.id}/a..b`,'GET']] as const){
  const r=res();assert.equal(await manager.handle(request(url,opened.authorization,method),r),true);assert.equal(r.status,403);
 }
 assert.deepEqual(fetched,[]);manager.closeAll();
});

test('desktop HTTP defaults content type, uses global fetch by default and keeps upstream credentials server-side',async t=>{
 const seen:string[]=[];t.mock.method(globalThis,'fetch',async(url:URL)=>{seen.push(String(url));return new Response(new Uint8Array([1,2]))});
 const {manager}=await fakeViewer();const opened=await manager.open('a');const headers:Record<string,string>={};
 const r=fakeResponse(function(data){this.body.push(...data);return true});r.writeHead=function(code:number,h:Record<string,string>){this.status=code;this.headersSent=true;Object.assign(headers,h);return this};
 await manager.handle(request(new URL(opened.url).pathname,opened.authorization,'GET'),r);
 assert.equal(r.status,200);assert.equal(headers['content-type'],'application/octet-stream');assert.deepEqual(r.body,[1,2]);assert.equal(r.ended,true);
 assert.equal(seen.length,1);assert.equal(new URL(seen[0]).searchParams.get('network_token'),'secret');assert.doesNotMatch(JSON.stringify(headers),/secret/);
 manager.closeAll();
});

test('desktop HTTP backpressure waits for drain without leaking listeners and stops when the client goes away',async()=>{
 let cancelled=false,pulled=0;
 const stream=()=>new ReadableStream<Uint8Array>({pull(c){pulled++;if(pulled>40)c.close();else c.enqueue(new Uint8Array([pulled]))},cancel(){cancelled=true}});
 const {manager}=await fakeViewer(async()=>new Response(stream()));const opened=await manager.open('a'),path=new URL(opened.url).pathname;
 const draining=fakeResponse(function(data){this.body.push(...data);queueMicrotask(()=>this.emit('drain'));return false});
 await manager.handle(request(path,opened.authorization,'GET'),draining);
 assert.equal(draining.body.length,40);assert.equal(draining.listenerCount('drain'),0);assert.equal(draining.listenerCount('close'),0);assert.equal(draining.ended,true);
 pulled=0;let writes=0;
 const leaving=fakeResponse(function(){writes++;queueMicrotask(()=>this.destroy());return false});
 await manager.handle(request(path,opened.authorization,'GET'),leaving);
 assert.equal(writes,1);assert.equal(cancelled,true);assert.equal(leaving.listenerCount('close'),0);
 manager.closeAll();
});

test('desktop HTTP destroys a response whose upstream body fails after headers were sent',async()=>{
 const body=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([1]));},pull(c){c.error(new Error('upstream reset'))}});
 const {manager}=await fakeViewer(async()=>new Response(body,{headers:{'content-type':'text/html'}}));const opened=await manager.open('a');
 const r=fakeResponse(function(){return true});await manager.handle(request(new URL(opened.url).pathname,opened.authorization,'GET'),r);
 assert.equal(r.status,200);assert.equal(r.destroyed,true);assert.equal(r.ended,false);manager.closeAll();
});

async function relayHarness(remoteSends:(socket:import('ws').WebSocket)=>void,options:{openSocket?:boolean,box?:any,vncUrl?:string}={}){
 const http=await import('node:http');const {WebSocket,WebSocketServer}=await import('ws');
 const remoteServer=http.createServer();const remoteWss=new WebSocketServer({server:remoteServer});const received:Buffer[]=[];
 remoteWss.on('connection',socket=>{remoteSends(socket);socket.on('message',data=>received.push(Buffer.from(data as any)))});
 await new Promise<void>(r=>remoteServer.listen(0,'127.0.0.1',r));const remote=`ws://127.0.0.1:${(remoteServer.address() as any).port}`;
 let origin='';const runtime:any={identity:async(id:string)=>({id}),computerConnection:async()=>({status:{vncUrl:options.vncUrl??'http://127.0.0.1:6080/vnc.html'},box:options.box??ownBox})};
 const manager=new ComputerViewer(runtime,{origin:()=>origin,...(options.openSocket===false?{}:{openSocket:()=>new WebSocket(remote,['binary'])})});
 const server=http.createServer();server.on('upgrade',(req,socket,head)=>{if(!manager.upgrade(req,socket,head))socket.destroy()});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const clients:InstanceType<typeof WebSocket>[]=[];
 const connect=(opened:{id:string,authorization:string},headers:Record<string,string>={},clientOrigin=origin)=>{const c=new WebSocket(`${origin.replace('http:','ws:')}/computer/${opened.id}/socket`,['binary'],{origin:clientOrigin,headers:{authorization:opened.authorization,...headers}});clients.push(c);return c};
 const closed=(c:InstanceType<typeof WebSocket>)=>new Promise<void>(r=>{if(c.readyState===WebSocket.CLOSED)r();else c.once('close',()=>r())});
 const shutdown=async()=>{for(const c of clients)c.terminate();manager.closeAll();for(const s of remoteWss.clients)s.terminate();remoteWss.close();server.closeAllConnections();remoteServer.closeAllConnections();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>remoteServer.close(()=>r()))]);};
 return {manager,received,connect,closed,shutdown,origin:()=>origin};
}
const rfbServer=(socket:import('ws').WebSocket)=>{let phase=0;socket.send(rfbVersion);socket.on('message',()=>{if(phase===0)socket.send(Buffer.from([1,1]));else if(phase===1)socket.send(Buffer.alloc(4));else if(phase===2)socket.send(Buffer.alloc(24));phase++;});};
const handshake=(c:import('ws').WebSocket)=>new Promise<void>((resolve,reject)=>{let phase=0;c.on('error',reject);c.on('message',()=>{if(phase===0)c.send(rfbVersion);else if(phase<3)c.send(Buffer.from([1]));else resolve();phase++;});});
const settle=()=>new Promise(r=>setTimeout(r,30));

test('desktop sockets reject non-socket paths, missing URLs, other origins and wrong capabilities',async()=>{
 const h=await relayHarness(rfbServer);
 try{
  const opened=await h.manager.open('a');
  assert.equal(h.manager.upgrade({url:undefined,headers:{}} as any,null as any,Buffer.alloc(0)),false);
  assert.equal(h.manager.upgrade({url:`/computer/${opened.id}/other`,headers:{}} as any,null as any,Buffer.alloc(0)),false);
  for(const c of [h.connect(opened,{},'http://evil.test'),h.connect({...opened,authorization:'Bearer wrong'}),h.connect({...opened,id:'ab'})]){
   const status=await new Promise<number>(r=>{c.on('unexpected-response',(_q,res)=>r(res.statusCode!));c.on('error',()=>r(-1))});assert.ok(status===403||status===-1,`status ${status}`);
  }
  assert.equal(h.received.length,0);assert.equal(h.manager.state(opened.id).connected,false);
 }finally{await h.shutdown();}
});

test('desktop sockets stop and report provider protocol errors and invalid client handshakes',async()=>{
 const bad=await relayHarness(socket=>socket.send(Buffer.from('RFB 003.003\n')));
 try{const opened=await bad.manager.open('a');const c=bad.connect(opened);await bad.closed(c);
  assert.deepEqual(bad.manager.state(opened.id),{connected:false,hasControl:false,error:'Unsupported remote desktop protocol.'});
 }finally{await bad.shutdown();}
 const h=await relayHarness(rfbServer);
 try{const opened=await h.manager.open('a');const c=h.connect(opened);
  await new Promise<void>(r=>c.once('message',()=>r()));c.send(Buffer.from('XXX 000.000\n'));await h.closed(c);
  assert.equal(h.manager.state(opened.id).error,'Invalid desktop handshake.');assert.equal(h.received.length,0);
 }finally{await h.shutdown();}
});

test('desktop sockets use a TLS upstream by default, drop input before it opens and report its failure',async()=>{
 const net=await import('node:net');const sockets:import('node:net').Socket[]=[];
 const tcp=net.createServer(s=>{sockets.push(s);s.on('data',()=>{})});await new Promise<void>(r=>tcp.listen(0,'127.0.0.1',r));
 const port=(tcp.address() as any).port,base=`https://127.0.0.1:${port}/vnc.html`;
 const h=await relayHarness(()=>{},{openSocket:false,box:{vncUrl:base,networkToken:'n'},vncUrl:base});
 try{
  const opened=await h.manager.open('a');const c=h.connect(opened);
  await new Promise<void>(r=>c.once('open',()=>r()));
  while(!sockets.length)await settle();
  c.send(rfbVersion);await settle();
  assert.equal(h.manager.state(opened.id).connected,false);
  sockets[0].destroy();await h.closed(c);
  assert.equal(h.manager.state(opened.id).error,'The desktop connection failed. Reconnect to continue.');
 }finally{await h.shutdown();for(const s of sockets)s.destroy();await new Promise<void>(r=>tcp.close(()=>r()));}
});

test('taking control on one viewer releases held keys and control on every other viewer',async()=>{
 const h=await relayHarness(rfbServer);
 try{
  const first=await h.manager.open('a'),second=await h.manager.open('z');
  const a=h.connect(first),z=h.connect(second);await Promise.all([handshake(a),handshake(z)]);
  await h.manager.control(first.id,true,'a');const before=h.received.length;
  a.send(Buffer.from([4,1,0,0,0,0,0,65]));await settle();
  assert.deepEqual(await h.manager.control(second.id,true,'z'),{hasControl:true});await settle();
  const after=h.received.slice(before);assert.deepEqual(after.map(b=>[b[0],b[1]]),[[4,1],[4,0]]);
  assert.equal(h.manager.state(first.id).hasControl,false);assert.equal(h.manager.state(second.id).hasControl,true);
  a.send(Buffer.from([4,1,0,0,0,0,0,66]));await settle();assert.equal(h.received.length,before+2);
 }finally{await h.shutdown();}
});

test('a packet started before release cannot become input after control is reacquired',()=>{
 const gate=new RfbInputGate();gate.ready();const key=Buffer.from([4,1,0,0,0,0,0,65]);
 assert.deepEqual(gate.client(key.subarray(0,3),true),[]);gate.release();
 assert.deepEqual(gate.client(key.subarray(3),true),[],'The old partial press must stay revoked');
 assert.deepEqual(gate.client(key,true),[key],'A fresh complete press uses the new control grant');
 const released=gate.release();assert.equal(released.length,1);assert.equal(released[0][1],0);
});

test('closing a viewer hands back a request that started after the viewer opened',async()=>{
 const calls:any[]=[];
 const runtime:any={computerConnection:async()=>({status:{vncUrl:'http://localhost:6080/vnc.html'},box}),command:async(botId:string,action:string,args:any)=>{calls.push({botId,action,args});return action==='computerStatus'?{handoff:{requestId:'new-handoff'}}:{};}};
 const manager=new ComputerViewer(runtime,{origin:()=> 'http://localhost:1234'}),opened=await manager.open('a');
 await manager.disconnect(opened.id,'a');assert.deepEqual(calls.map(c=>c.action),['computerStatus','handBack']);assert.equal(calls[1].args.requestId,'new-handoff');assert.throws(()=>manager.state(opened.id),/closed/);
});

test('an open desktop socket that never initializes fails within the connection deadline',async t=>{
 const http=await import('node:http');const {WebSocket,WebSocketServer}=await import('ws');
 const remoteServer=http.createServer(),remoteWss=new WebSocketServer({server:remoteServer});
 const remoteReady=new Promise<void>(r=>remoteWss.once('connection',()=>r()));
 await new Promise<void>(r=>remoteServer.listen(0,'127.0.0.1',r));
 const remote=`ws://127.0.0.1:${(remoteServer.address()as any).port}`;
 let origin='';const runtime:any={computerConnection:async()=>({status:{vncUrl:'http://localhost:6080/vnc.html'},box})};
 const manager=new ComputerViewer(runtime,{origin:()=>origin,openSocket:()=>new WebSocket(remote)});
 const local=http.createServer();local.on('upgrade',(req,socket,head)=>{if(!manager.upgrade(req,socket,head))socket.destroy()});
 await new Promise<void>(r=>local.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(local.address()as any).port}`;
 let client:InstanceType<typeof WebSocket>|undefined;
 try {
  t.mock.timers.enable({apis:['setTimeout']});const viewer=await manager.open('a');
  client=new WebSocket(`${origin.replace('http:','ws:')}/computer/${viewer.id}/socket`,{origin,headers:{authorization:viewer.authorization}});await remoteReady;
  t.mock.timers.tick(30000);
  const state=manager.state(viewer.id,'a');assert.equal(state.connected,false);assert.equal(state.hasControl,false);assert.match(state.error!,/did not initialize/);
 } finally {
  client?.terminate();manager.closeAll();for(const socket of remoteWss.clients)socket.terminate();remoteWss.close();
  local.closeAllConnections();remoteServer.closeAllConnections();await Promise.all([new Promise<void>(r=>local.close(()=>r())),new Promise<void>(r=>remoteServer.close(()=>r()))]);
 }
});
