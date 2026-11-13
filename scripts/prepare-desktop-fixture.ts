// Opt-in disposable cloud page preparation. No connected apps, external sites or real documents.
import fs from 'node:fs';import crypto from 'node:crypto';import os from 'node:os';import path from 'node:path';
import {AuthStore} from '../src/auth.ts';import {GrokBotClient} from '../src/grokbot.ts';
class Client extends GrokBotClient {verifyRpc(method:string,body:object){return this.rpc(method,body,120000)}}
const client=new Client({store:new AuthStore(path.join(os.homedir(),'Library/Application Support/GrokCall'))});
const bot=(await client.listBots())[0];if(!bot)throw new Error('No accessible bot.');
const agentId=client.botMeta(bot.id).uuid;if(!agentId)throw new Error('Missing bot identity.');
const marker='GROKCALL'+crypto.randomBytes(5).toString('hex').toUpperCase();const file='/tmp/grok-call-desktop-'+crypto.randomUUID()+'.html';
const context={botId:bot.id,agentId,marker,file};fs.writeFileSync('/tmp/grok-desktop-fixture.json',JSON.stringify(context),{mode:0o600});
const html=`<!doctype html><meta charset="utf-8"><title>Grok Call disposable check</title><style>body{margin:0;background:#fff;color:#111;font-family:sans-serif}button{position:fixed;inset:0;width:100vw;height:100vh;border:0;background:#fff;color:#111;font-size:48px}h1{font-size:36px}</style><button onclick="this.innerHTML='<h1>GROK CALL DISPOSABLE CHECK</h1>${marker}';document.title='${marker}'"><h1>GROK CALL DISPOSABLE CHECK</h1>CLICK TO VERIFY</button>`;
const before=await client.verifyRpc('ListGrokBotTranscriptEntries',{agentId,limit:1});const newest=Math.max(0,...(before.entries??[]).map((e:any)=>Number(e.seq)));
const reply=await client.verifyRpc('SendGrokBotUserMessage',{agentId,messageId:crypto.randomUUID(),text:`Authorized disposable Grok Call Linux desktop test. On your OWN Linux screen, create only ${file} by decoding this exact base64 HTML: ${Buffer.from(html).toString('base64')}. Open that local file in a new temporary browser tab and maximize the browser on YOUR screen so the page is visible. Do not click the button. Do not use connected apps, external sites, personal documents, other tabs, messages, purchases or other computers. Stop once the page is visible and reply READY:${marker}. The user will click only this disposable page from Grok Call.`,sentAtMs:String(Date.now()),sessionId:''});
if(reply.dispatched!==true||reply.refusal)throw new Error('The bot did not accept the disposable page test.');
let ready=false;
for(let i=0;i<90;i++){
 await new Promise(r=>setTimeout(r,1000));const page=await client.verifyRpc('ListGrokBotTranscriptEntries',{agentId,limit:30});
 for(const entry of page.entries??[]){if(Number(entry.seq)<=newest)continue;try{const body=JSON.parse(Buffer.from(entry.body,'base64').toString());if(body.kind==='send-message'&&body.message?.type==='text'&&body.message.content?.includes('READY:'+marker))ready=true;}catch{}}
 if(ready)break;
}
if(!ready)throw new Error('The bot did not confirm fixture preparation. No desktop input was sent.');
console.log(JSON.stringify({ready:true,contextPath:'/tmp/grok-desktop-fixture.json',scope:'One disposable local HTML page; no external service or document actions'}));
