// Explicitly authorized disposable acceptance: no external apps, messages, browsing or purchases.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {AuthStore} from '../src/auth.ts';import {GrokBotClient} from '../src/grokbot.ts';
const client=new GrokBotClient({store:new AuthStore(path.join(os.homedir(),'Library/Application Support/Alotbot'))}),runtime=client.createRuntime();
const proposal=JSON.parse(fs.readFileSync(new URL('../docs/verification/bot-workspaces/live-routine-proposal.json',import.meta.url),'utf8'));
const marker='/tmp/grok-call-verification-'+crypto.randomUUID()+'.txt';proposal.prompt+=` Use this exact temporary file path: ${marker}.`;
let botId='',createdId:string|null=null;
const report=(stage:string,data:object={})=>console.log(JSON.stringify({stage,...data}));
try {
 const bot=(await client.listBots())[0];if(!bot)throw new Error('No bot is available.');botId=bot.id;
 await runtime.computerConnection(botId,true);
 const before=(await runtime.command(botId,'resources')).routines;
 const existing=before.find((r:any)=>r.name===proposal.name&&r.source==='computer'&&r.spec.prompt?.includes('ALOTBOT_ROUTINE_VERIFIED')&&r.enabled===false);
 if(before.some((r:any)=>r.name===proposal.name)&&!existing)throw new Error('A routine with the verification name already exists. It was not changed.');
 if(existing)createdId=existing.id;else await runtime.command(botId,'routineCreate',{spec:proposal});
 for(let i=0;i<90;i++){const found=(await runtime.command(botId,'resources')).routines.find((r:any)=>r.name===proposal.name&&!before.some((b:any)=>b.id===r.id));if(existing||found){const owned=existing??found;createdId=owned.id;if(owned.enabled)throw new Error('The provider enabled the test unexpectedly.');break;}await new Promise(r=>setTimeout(r,1000));}
 if(!createdId)throw new Error('Creation receipt arrived but the new routine could not be reconciled. Do not retry creation automatically.');
 report('created',{disabled:true,hasDurableId:true});
 const editedPrompt=proposal.prompt+' This edited specification is the only task to perform.';
 await runtime.command(botId,'routineUpdate',{id:createdId,spec:{...proposal,prompt:editedPrompt}});
 let edited=false;for(let i=0;i<90;i++){const row=(await runtime.command(botId,'resources')).routines.find((r:any)=>r.id===createdId);if(row?.spec.prompt===editedPrompt){edited=true;break;}await new Promise(r=>setTimeout(r,1000));}
 if(!edited)throw new Error('The requested edit did not reconcile.');report('edited');
 await runtime.command(botId,'routineRun',{id:createdId});report('runAccepted');
 let verified=false;
 for(let i=0;i<45;i++){
  await new Promise(r=>setTimeout(r,1000));
  try {const identity=await runtime.identity(botId);const reply=await runtime.gateway(identity,'readAttachmentChunk',{agentId:identity.agentId,path:marker,offset:0,length:128},false);if(Buffer.from(reply.bytesBase64??'','base64').toString('utf8').trim()==='ALOTBOT_ROUTINE_VERIFIED'){verified=true;break;}}catch{}
 }
 report('fileVerification',{markerMatches:verified});if(!verified)throw new Error('The test file was not verified within the acceptance window.');
 const current=(await runtime.command(botId,'resources')).routines.find((r:any)=>r.id===createdId);report('history',{runRecords:Array.isArray(current?.spec.runs)?current.spec.runs.length:0});
} catch(error){report('failed',{message:(error as Error).message});process.exitCode=1;}
finally {
 if(createdId){try{await runtime.command(botId,'routineDelete',{id:createdId});const remains=(await runtime.command(botId,'resources')).routines.some((r:any)=>r.id===createdId);report('cleanup',{routineRemoved:!remains});if(remains)process.exitCode=1;}catch{report('cleanup',{routineRemoved:false});process.exitCode=1;}}
 runtime.close();
}
