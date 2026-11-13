import type {RuntimeIdentity} from './bot-runtime.ts';
import type {WorkCard} from './work-cards.ts';
import {COLORS,SHAPES} from './appearance.ts';

type Rpc=(method:string,body:object)=>Promise<any>;
type Gateway=(bot:RuntimeIdentity,method:string,body:Record<string,unknown>)=>Promise<any>;
const field=(value:unknown,label:string,max=500)=>{
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`Choose a valid ${label}.`);
  return value;
};
/** Controls whose native contracts are distinct from ordinary question/approval cards. */
export class WorkCardControls {
  private rpc:Rpc;
  private gateway:Gateway;
  constructor(rpc:Rpc,gateway:Gateway){this.rpc=rpc;this.gateway=gateway;}
  async appearance(bot:RuntimeIdentity){
    const result=await this.rpc('ListGrokBotAgents',{});
    const agent=(Array.isArray(result.agents)?result.agents:[]).find((a:any)=>a?.id===bot.id);
    if(!agent)throw new Error('This bot is no longer available. Refresh the roster.');
    return {shape:agent.avatarShape??'blob',color:agent.avatarColor??'black',shapes:SHAPES,colors:COLORS};
  }
  async command(bot:RuntimeIdentity,args:Record<string,unknown>,card:WorkCard|undefined){
    const control=field(args.control,'card control');
    const kinds:Record<string,string[]>={appearanceSave:['appearance-picker'],emailUse:['email-offer'],emailDecline:['email-offer'],setupDismiss:['appearance-picker','email-offer','notifications-enable','team-access'],teamCopy:['team-access'],teamShare:['team-access'],publishConfirm:['publish-approval'],publishDismiss:['publish-approval']};
    if(!card||!kinds[control]?.includes(card.kind)||card.sessionId!==args.sessionId||!card.actions.includes(control)||typeof args.controlRevision!=='string'||args.controlRevision!==card.details.controlRevision)throw new Error('This card changed or no longer permits that action. Refresh Activity.');
    const identity={agentId:bot.agentId,entryId:card.id,sessionId:card.sessionId};
    if(control==='appearanceSave'){
      const shape=field(args.shape,'shape'),color=field(args.color,'color');
      if(!(SHAPES as readonly string[]).includes(shape)||!Object.hasOwn(COLORS,color))throw new Error('Choose a supported bot shape and color.');
      await this.rpc('UpdateGrokBotAgent',{id:bot.id,avatarShape:shape,avatarColor:color,partialUpdate:true});
      return this.widget('RespondGrokBotWidget',{...identity,value:JSON.stringify({avatarShape:shape,avatarColor:color})});
    }
    if(control==='emailUse'||control==='emailDecline')return this.widget('RespondGrokBotWidget',{...identity,value:control==='emailUse'?'email-offer:use':'email-offer:not-now'});
    if(control==='setupDismiss')return this.widget('DismissGrokBotWidget',identity);
    if(args.userConfirmed!==true)throw new Error('Review and confirm this scoped action before continuing.');
    if(control==='teamCopy'){
      const result=await this.rpc('CloneGrokBotAgentToTeam',{agentId:bot.agentId,personalSecretNames:[],offerEntryId:card.id,inPlace:false});
      if(!['1','CLONE_GROK_BOT_AGENT_TO_TEAM_OUTCOME_CLONED'].includes(String(result.outcome)))throw new Error('Grok could not create the team copy. Check your team membership and sharing permissions.');
      const id=result.agent?.agentId;
      if(typeof id!=='string'||!id.trim()||id.length>500)throw new Error('The team copy identity could not be confirmed. Outcome unknown: inspect the roster before retrying.');
      return {accepted:true,agentId:id};
    }
    if(control==='teamShare'){
      const result=await this.rpc('ShareGrokBotAgentInPlace',{agentId:bot.agentId});
      if(!['1','SHARE_GROK_BOT_AGENT_IN_PLACE_OUTCOME_STARTED'].includes(String(result.outcome)))throw new Error('Grok could not start sharing this bot. Check your team membership and sharing permissions.');
      return {accepted:true,queued:true};
    }
    const body={agentId:bot.agentId,bcId:field(card.details.bcId,'coding task'),proposalId:field(card.details.proposalId,'publish proposal')};
    if(control==='publishDismiss')return this.publish(bot,'dismissCloudAgentPublishProposal',body);
    const visibility=field(args.visibility,'visibility');
    if(!['private','team','public'].includes(visibility))throw new Error('Choose private, team or public visibility.');
    const slug=field(args.slug,'site name',63);
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))throw new Error('Use lowercase letters, numbers and single hyphens for the site name.');
    return this.publish(bot,'confirmCloudAgentPublishProposal',{...body,slug,visibility,requireConfirmationForUpdates:true});
  }
  private async publish(bot:RuntimeIdentity,method:string,body:Record<string,unknown>){
    const result=await this.gateway(bot,method,body);
    if(result?.kind==='refused')throw new Error('Grok refused this publishing decision. Refresh the proposal and check its permissions.');
    return result;
  }
  private async widget(method:string,body:Record<string,unknown>){
    const result=await this.rpc(method,body);
    if(result?.accepted!==true||result.refusal)throw new Error('Grok did not confirm this card response. Refresh Activity before retrying.');
    return result;
  }
}
