// Opt-in live acceptance: two real bots, voice, workspace operations and the native Linux viewer.
// No microphone capture, speaker playback, connected-app work, purchases or desktop input.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import WebSocket from 'ws';
import {AuthStore} from '../src/auth.ts';
import {createOverlayServer} from '../src/overlay/server.ts';
const realStore=new AuthStore(path.join(os.homedir(),'Library/Application Support/GrokCall'));
const initial=realStore.read();assert.ok(initial);
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'grok-workspace-call-'));fs.chmodSync(temporary,0o700);
const store=new AuthStore(temporary);store.write(initial);
const token=crypto.randomBytes(32).toString('hex');
const server=createOverlayServer({dataDir:temporary,token,fetch:async(url,options)=>{
 if(String(url).endsWith('/VoiceCallHarnessTool')){
  const body=JSON.parse(String(options?.body));
  if(body.name==='send_task'&&!body.input?.request?.includes('The call ended'))return Response.json({message:'This verification does not authorize agent work.'},{status:403});
 }
 return fetch(url,options);
}});
await new Promise<void>(r=>server.server.listen(0,'127.0.0.1',r));
const ws=new WebSocket(`ws://127.0.0.1:${(server.server.address()as any).port}/ws`,{headers:{authorization:`Bearer ${token}`}});
let seq=0,audio=0,view:any;const lines:any[]=[];
const requests=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
ws.on('message',(data,binary)=>{if(binary){audio++;return;}const m=JSON.parse(data.toString());if(m.t==='view')view=m.view??m;if(m.t==='lines')lines.push(...m.lines);if(m.t==='reply'){const r=requests.get(m.req);if(r){clearTimeout(r.timer);requests.delete(m.req);m.ok?r.resolve(m.result):r.reject(new Error(m.error));}}});
function op(op:string,args:object={}){const req=++seq;return new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{requests.delete(req);reject(new Error(`${op} did not finish`));},120000);requests.set(req,{resolve,reject,timer});ws.send(JSON.stringify({op,req,...args}));});}
async function until(check:()=>boolean,ms=60000){const deadline=Date.now()+ms;while(!check()){if(Date.now()>deadline)throw new Error('Live workspace-call check timed out.');await new Promise(r=>setTimeout(r,100));}}
let child:ReturnType<typeof spawn>|undefined;
try {
 await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
 const {bots}=await op('bots');assert.ok(bots.length>=2);
 const selected=bots.slice(0,2);await op('join',{botIds:selected.map((b:any)=>b.id)});
 await until(()=>view?.bots?.length===2&&view.bots.every((b:any)=>!['connecting','reconnecting'].includes(b.status)));
 const bot=selected[0];const resources=await op('workspace',{botId:bot.id,action:'resources'});assert.equal(resources.bot.id,bot.id);
 const viewer=await op('workspace',{botId:bot.id,action:'computerOpen'}),info=path.join(temporary,'viewer.json'),signal=path.join(temporary,'control');
 fs.writeFileSync(info,JSON.stringify(viewer),{mode:0o600});
 const output=fs.openSync('docs/verification/bot-workspaces/call-native-webkit.txt','w');
 child=spawn('swift',['test','--package-path','mac','--filter','LiveWorkspaceDesktopTests','-Xswiftc','-load-plugin-library','-Xswiftc','/Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing/libTestingMacros.dylib'],{env:{...process.env,WORKSPACE_VIEWER_INFO:info,WORKSPACE_CONTROL_SIGNAL:signal},stdio:['ignore',output,output]});fs.closeSync(output);
 const completed=new Promise<number|null>((resolve,reject)=>{child!.once('exit',resolve);child!.once('error',reject)});
 await until(()=>fs.existsSync(signal+'.ready')||child!.exitCode!==null);assert.ok(fs.existsSync(signal+'.ready'));
 assert.equal((await op('workspace',{botId:bot.id,action:'computerControl',viewerId:viewer.id,enabled:true})).hasControl,true);
 assert.equal((await op('workspace',{botId:bot.id,action:'computerControl',viewerId:viewer.id,enabled:false})).hasControl,false);
 fs.writeFileSync(signal+'.released','',{mode:0o600});assert.equal(await completed,0);
 await op('workspace',{botId:bot.id,action:'computerClose',viewerId:viewer.id});
 const beforeAudio=audio,beforeLines=lines.length;
 await op('say',{text:'Verification only. Reply with the exact words WORKSPACE_CALL_CONTINUES. Do not use tools or do any other work.'});
 await until(()=>audio>beforeAudio&&lines.slice(beforeLines).some(l=>l.text?.includes('WORKSPACE_CALL_CONTINUES')));
 assert.equal(view.phase,'in-call');assert.equal(view.bots.length,2);
 await op('leave');
 console.log(JSON.stringify({passed:true,bots:2,nativeWebKit:true,realLinuxScreen:true,controlEnabledAndReleased:true,voiceAfterWorkspace:true,audioFrames:audio,desktopInputSent:false,manualDisposablePageInputVerified:false}));
} finally {
 if(child&&child.exitCode===null)child.kill('SIGTERM');
 ws.terminate();server.close();server.server.closeAllConnections();await new Promise<void>(r=>server.server.close(()=>r()));
 for(const r of requests.values()){clearTimeout(r.timer);r.reject(new Error('Verification ended'));}
 const refreshed=store.read();if(refreshed&&JSON.stringify(realStore.read())===JSON.stringify(initial)&&refreshed.accessToken!==initial.accessToken)realStore.write(refreshed);
 store.clear();fs.rmSync(temporary,{recursive:true,force:true});
}
