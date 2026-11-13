// Opt-in real WebKit/RFB/control acceptance. Sends no keyboard, mouse or clipboard input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {AuthStore} from '../src/auth.ts';
import {GrokBotClient} from '../src/grokbot.ts';
import {ComputerViewer} from '../src/computer-viewer.ts';
const client=new GrokBotClient({store:new AuthStore(path.join(os.homedir(),'Library/Application Support/GrokCall'))});
const runtime=client.createRuntime();
let origin='';
const manager=new ComputerViewer(runtime,{origin:()=>origin});
const server=http.createServer((req,res)=>{void manager.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}})});
server.on('upgrade',(req,socket,head)=>{if(!manager.upgrade(req,socket,head))socket.destroy();});
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'grok-workspace-live-'));
fs.chmodSync(temporary,0o700);
let child:ReturnType<typeof spawn>|undefined;
try {
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address()as any).port}`;
 const bot=(await client.listBots())[0];assert.ok(bot);
 const viewer=await manager.open(bot.id),info=path.join(temporary,'viewer.json'),signal=path.join(temporary,'control');
 fs.writeFileSync(info,JSON.stringify(viewer),{mode:0o600});
 const args=['test','--package-path','mac','--filter','LiveWorkspaceDesktopTests','-Xswiftc','-load-plugin-library','-Xswiftc','/Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing/libTestingMacros.dylib'];
 const log=fs.openSync('docs/verification/bot-workspaces/native-webkit.txt','w');
 child=spawn('swift',args,{env:{...process.env,WORKSPACE_VIEWER_INFO:info,WORKSPACE_CONTROL_SIGNAL:signal},stdio:['ignore',log,log]});fs.closeSync(log);
 const completed=new Promise<number|null>((resolve,reject)=>{child!.once('exit',resolve);child!.once('error',reject)});
 for(let i=0;i<240&&!fs.existsSync(signal+'.ready');i++){if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,250));}
 assert.ok(fs.existsSync(signal+'.ready'),'Native WKWebView must complete the real RFB handshake');
 assert.equal((await manager.validateState(viewer.id,bot.id)).connected,true);
 assert.equal((await manager.control(viewer.id,true,bot.id)).hasControl,true);
 if(process.env.WORKSPACE_DESKTOP_INPUT_MARKER){
  fs.writeFileSync(signal+'.enabled','',{mode:0o600});
  for(let i=0;i<80&&!fs.existsSync(signal+'.clicked');i++){if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,250));}
  assert.ok(fs.existsSync(signal+'.clicked'),'The native desktop interaction did not complete; inspect native-webkit.txt');
  assert.equal(fs.readFileSync(signal+'.clicked','utf8'),'passed','The native viewer must verify the real disposable page changed');
 }
 assert.equal((await manager.control(viewer.id,false,bot.id)).hasControl,false);
 fs.writeFileSync(signal+'.released','',{mode:0o600});
 assert.equal(await completed,0);
 await manager.disconnect(viewer.id,bot.id);
 assert.throws(()=>manager.state(viewer.id),/closed/);
 console.log(JSON.stringify({passed:true,nativeWebKit:true,realRfb:true,controlEnabledAndReleased:true,inputSent:!!process.env.WORKSPACE_DESKTOP_INPUT_MARKER,viewerClosed:true,manualDisposablePageInputVerified:!!process.env.WORKSPACE_DESKTOP_INPUT_MARKER}));
} finally {
 if(child&&child.exitCode===null)child.kill('SIGTERM');
 manager.closeAll();runtime.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
 fs.rmSync(temporary,{recursive:true,force:true});
}
