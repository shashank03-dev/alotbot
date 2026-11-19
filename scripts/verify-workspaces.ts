// Read-only acceptance: prints counts and transport metadata, never private contents or viewer credentials.
import os from 'node:os';
import path from 'node:path';
import {AuthStore} from '../src/auth.ts';
import {GrokBotClient} from '../src/grokbot.ts';
const client=new GrokBotClient({store:new AuthStore(path.join(os.homedir(),'Library/Application Support/Alotbot'))});
const runtime=client.createRuntime();
try {
 const bots=await client.listBots();
 for(const [index,bot]of bots.entries()){
  const resources=await runtime.command(bot.id,'resources');
  const activity=await runtime.command(bot.id,'activity');
  const computer=await runtime.command(bot.id,'computerStatus');
  console.log(JSON.stringify({index,identityMatches:resources.bot.id===bot.id,skills:resources.skills.length,routines:resources.routines.length,files:resources.files.length,allRoutinesHaveIds:resources.routines.every((r:any)=>!!r.id),warnings:resources.warnings.length,activityCards:activity.cards.length,computer:computer.state,hasViewer:computer.hasViewer}));
 }
} finally {runtime.close();}
