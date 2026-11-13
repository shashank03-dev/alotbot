import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BotRuntime} from '../src/bot-runtime.ts';
function fixture(){const calls:any[]=[];let teaching:any={state:'idle'};const runtime=new BotRuntime({identity:async id=>({id,agentId:'uuid-'+id,name:id}),rpc:async(method,body)=>{calls.push({method,body});if(method==='GetSandBoxRunState')return {state:'SAND_BOX_RUN_STATE_RUNNING'};if(method==='EnsureSandBox')return {gatewayUrl:'https://gateway.test',gatewayToken:'secret'};if(method==='ListGrokBotUserSkills')return {skills:[{id:'available',name:'Research',description:'Sources',body:'Find reliable sources',source:'recipe'}]};if(method==='ListGrokBotUserBotMemories')return {memories:[{factId:'fact',text:'Project preference'}]};if(method==='ListGrokBotLibraryDocs')return {docs:[{key:'doc',url:'https://docs.test/result',title:'Report'}]};return {};},fetch:async(url,options)=>{const method=String(url).split('/').pop();calls.push({method,body:JSON.parse(String(options?.body))});if(method==='getTeachRecordingStatus')return Response.json(teaching);if(method==='startTeachRecording')teaching={state:'recording',agentId:'uuid-a',startedAtMs:1000};if(method==='stopTeachRecording')teaching={state:'idle'};return Response.json(teaching);}});return {runtime,calls,setTeaching:(value:any)=>{teaching=value}};}
test('available skills, memory promotion and library pins use fresh accessible records',async()=>{
 const {runtime,calls}=fixture();
 await runtime.command('a','skillEnable',{id:'available'});assert.deepEqual(calls.at(-1),{method:'AddGrokBotAgentSkill',body:{agentId:'uuid-a',name:'Research',description:'Sources',content:'Find reliable sources'}});
 await assert.rejects(runtime.command('a','skillEnable',{id:'missing'}),/available/);
 await runtime.command('a','memoryShare',{id:'fact'});assert.deepEqual(calls.at(-1).body,{agentId:'uuid-a',factIds:['fact']});
 await assert.rejects(runtime.command('a','memoryShare',{id:'other'}),/available/);
 await runtime.command('a','libraryPin',{id:'doc',enabled:true});assert.deepEqual(calls.at(-1).body,{agentId:'uuid-a',pin:{externalDocKey:'doc'},isPinned:true});
 await assert.rejects(runtime.command('a','libraryPin',{id:'other',enabled:true}),/available/);runtime.close();
});
test('teaching cannot stop another bot’s recording and reads do not wake a computer',async()=>{
 const {runtime,calls,setTeaching}=fixture();
 const status=await runtime.command('a','teachStatus');assert.equal(status.state,'idle');assert.equal(calls.find(c=>c.method==='EnsureSandBox').body.wake,false);
 await runtime.command('a','teachStart');assert.equal((await runtime.command('a','teachStatus')).owned,true);
 await assert.rejects(runtime.command('b','teachStop',{save:true}),/another bot/);
 await runtime.command('a','teachStop',{save:true});assert.equal(calls.at(-1).body.save,true);
 setTeaching({state:'recording',agentId:'uuid-b'});await assert.rejects(runtime.command('a','teachStart'),/already recording/);runtime.close();
});

test('account routine changes use the bot’s durable routine tool and retain the canonical specification',async()=>{
 const requests:any[]=[];
 const runtime=new BotRuntime({identity:async id=>({id,agentId:'uuid-'+id,name:id}),submitRoutine:async(bot,operation,spec,id)=>{requests.push({bot,operation,spec,id});return {accepted:true,queued:true};},rpc:async(method)=>method==='ListGrokBotAgentAutomations'?{automations:[{automationId:'routine',recordJson:JSON.stringify({id:'slug',name:'Daily',prompt:'Report',trigger:{type:'cron',schedule:'0 9 * * *'}})}]}:{state:'SAND_BOX_RUN_STATE_HIBERNATED'}});
 const spec={name:'Test',prompt:'Write a temporary marker',trigger:{type:'cron',schedule:'0 0 1 1 *'},isEnabled:false};
 await runtime.command('a','routineCreate',{spec});assert.deepEqual(requests[0],{bot:{id:'a',agentId:'uuid-a',name:'a'},operation:'create',spec,id:undefined});
 await runtime.command('a','routineUpdate',{id:'routine',spec});assert.equal(requests[1].id,'slug');runtime.close();
});

test('partial resource outages preserve the last successful sections for that bot only',async()=>{
 let offline=false;
 const runtime=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),rpc:async(method,body:any)=>{if(method==='GetSandBoxRunState')return {state:'SAND_BOX_RUN_STATE_HIBERNATED'};if(method==='ListGrokBotAgentSkills'){if(offline)throw new Error('Offline');return {skills:[{id:'skill',name:'Research',body:'Instructions'}]};}return {};}});
 assert.equal((await runtime.command('a','resources')).skills.length,1);offline=true;
 const retained=await runtime.command('a','resources');assert.equal(retained.skills[0].name,'Research');assert.ok(retained.warnings.some((v:string)=>v.startsWith('skills:')));
 assert.deepEqual((await runtime.command('b','resources')).skills,[]);runtime.close();
});

test('available skills with name-only identity cannot be activated twice',async()=>{
 const runtime=new BotRuntime({identity:async id=>({id,agentId:id,name:id}),rpc:async method=>method==='ListGrokBotUserSkills'||method==='ListGrokBotAgentSkills'?{skills:[{name:'Skill',body:'Instructions'}]}:{}});
 await assert.rejects(runtime.command('a','skillEnable',{id:'Skill'}),/already enabled/);runtime.close();
});

test('computer-only routines use their own route for run, enable and delete',async()=>{
 const calls:string[]=[];
 const runtime=new BotRuntime({identity:async id=>({id,agentId:'uuid-'+id,name:id}),rpc:async method=>{calls.push(method);if(method==='EnsureSandBox')return {gatewayUrl:'https://gateway.test'};return method==='GetSandBoxRunState'?{state:'SAND_BOX_RUN_STATE_RUNNING'}:{};},fetch:async(url)=>{const method=String(url).split('/').pop()!;calls.push(method);return Response.json([{id:'legacy',name:'Legacy',prompt:'Task',isEnabled:false}]);}});
 await runtime.command('a','routineRun',{id:'legacy'});assert.equal(calls.at(-1),'runAgentAutomationNow');
 await runtime.command('a','routineEnable',{id:'legacy',enabled:false});assert.equal(calls.at(-1),'setAgentAutomationEnabled');
 await runtime.command('a','routineDelete',{id:'legacy'});assert.equal(calls.at(-1),'deleteAgentAutomation');
 assert.ok(!calls.some(m=>['RunGrokBotAgentAutomationNow','SetGrokBotAgentAutomationEnabled','DeleteGrokBotAgentAutomation'].includes(m)));runtime.close();
});
