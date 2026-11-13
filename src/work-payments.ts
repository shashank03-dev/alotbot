import crypto from 'node:crypto';
import type {WorkCard} from './work-cards.ts';
import type {RuntimeIdentity} from './bot-runtime.ts';
type Rpc=(method:string,body:object)=>Promise<any>;
interface Ceremony {botId:string;entryId:string;requestId:string;paymentMethodId:string;challengeId:string;expires:number;}
/** The provider hosts passkey authentication. We retain only its challenge binding, never a passkey. */
export class WorkPayments {
  private pending=new Map<string,Ceremony>();
  private rpc:Rpc;private siteOrigin:string;private now:()=>number;
  constructor(rpc:Rpc,siteOrigin:string,now:()=>number=Date.now){this.rpc=rpc;this.siteOrigin=siteOrigin;this.now=now;}
  private card(card:WorkCard|undefined){if(!card||card.kind!=='virtual-card-approval'||card.status!=='pending'||!card.requestId)throw new Error('This payment request is no longer pending. Refresh activity.');return card;}
  async methods(card:WorkCard|undefined){
    this.card(card);
    const result=await this.rpc('ListGrokBotStripeLinkPaymentMethods',{});
    return {status:result.outcome??'unavailable',methods:(Array.isArray(result.paymentMethods)?result.paymentMethods:[]).map((m:any)=>({id:String(m.id),name:typeof m.name==='string'?m.name:'Payment method',last4:typeof m.last4==='string'?m.last4:'',ineligibleReason:typeof m.ineligibleReason==='string'?m.ineligibleReason:null}))};
  }
  async begin(bot:RuntimeIdentity,card:WorkCard|undefined,paymentMethodId:unknown){
    const current=this.card(card);
    if(typeof paymentMethodId!=='string'||!paymentMethodId||paymentMethodId.length>500)throw new Error('Choose a payment method.');
    const methods=await this.methods(current);
    if(!methods.methods.some((m:any)=>m.id===paymentMethodId&&!m.ineligibleReason))throw new Error('This payment method is unavailable. Refresh payment methods.');
    const reply=await this.rpc('BeginGrokBotSpendApproval',{agentId:bot.agentId,requestId:current.requestId,paymentMethodId});
    let url:string|null=null;
    if(reply.challengeId&&reply.ceremonyToken){
      const origin=new URL(this.siteOrigin),path=reply.ceremonyPath;
      if(origin.protocol!=='https:'||origin.username||origin.password||typeof path!=='string'||!path.startsWith('/grok-bot/passkey/')||path.split('/').some(p=>p==='.'||p==='..')||!/^[A-Za-z0-9/_.-]+$/.test(path))throw new Error('The provider returned an invalid verification page.');
      const target=new URL(path,origin);
      if(target.origin!==origin.origin||target.pathname!==path)throw new Error('The verification page has an invalid origin.');
      target.hash=new URLSearchParams({token:String(reply.ceremonyToken),challenge_id:String(reply.challengeId)}).toString();url=target.href;
    }
    const id=crypto.randomUUID();
    this.pending.set(id,{botId:bot.id,entryId:current.id,requestId:current.requestId,paymentMethodId,challengeId:typeof reply.challengeId==='string'?reply.challengeId:'',expires:this.now()+5*60_000});
    return {id,url,requiresVerification:!!url};
  }
  async finish(bot:RuntimeIdentity,card:WorkCard|undefined,id:unknown){
    const current=this.card(card),pending=typeof id==='string'?this.pending.get(id):undefined;
    if(!pending||pending.botId!==bot.id||pending.entryId!==current.id||pending.requestId!==current.requestId||pending.expires<=this.now())throw new Error('This verification expired or belongs to another request. Start verification again.');
    const result=await this.rpc('ResolveGrokBotVirtualCardApproval',{agentId:bot.agentId,entryId:current.id,requestId:current.requestId,resolution:1,paymentMethodId:pending.paymentMethodId,...(pending.challengeId?{attestation:{challengeId:pending.challengeId}}:{})});
    const outcome=String(result.outcome);
    if(result.refusal||!(outcome==='1'||outcome==='APPROVED'||outcome.endsWith('_APPROVED')))throw new Error('The provider has not approved this payment. Complete its authentication or check its account restrictions.');
    this.pending.delete(id as string);return {accepted:true};
  }
  close(){this.pending.clear();}
}
