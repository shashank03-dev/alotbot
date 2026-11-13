import crypto from 'node:crypto';
import type {RuntimeIdentity} from './bot-runtime.ts';
interface Options {rpc:(method:string,body:object)=>Promise<any>;now?:()=>number;}
interface Transfer {bot:RuntimeIdentity;path?:string;size:number;until:number;token?:string;}
const MAX=1024*1024*1024,CHUNK=128*1024;
export class BotFiles {
  private o:Options;private uploads=new Map<string,Transfer>();private downloads=new Map<string,Transfer>();
  constructor(options:Options){this.o=options;}
  private now(){return(this.o.now??Date.now)();}
  private transfer(map:Map<string,Transfer>,botId:string,id:unknown){const value=typeof id==='string'?map.get(id):undefined;if(!value||value.bot.id!==botId||value.until<this.now())throw new Error('This transfer belongs to another bot or has expired.');return value;}
  async beginDownload(bot:RuntimeIdentity,path:unknown){
    if(typeof path!=='string'||!path||path.includes('\0'))throw new Error('Choose a file path.');
    const store=await this.o.rpc('ListGrokBotUserStoreFiles',{agentId:bot.agentId});
    let file=(Array.isArray(store.files)?store.files:[]).find((f:any)=>f.path===path);
    let cursor='',pages=0;const seen=new Set<string>();
    while(!file){
      if(++pages>1000)throw new Error('File discovery exceeded its limit. Narrow the file selection.');
      const page=await this.o.rpc('ListGrokBotAgentFiles',{agentId:bot.agentId,pageToken:cursor});
      file=(Array.isArray(page.files)?page.files:[]).find((f:any)=>f.path===path);
      const next=typeof page.nextPageToken==='string'?page.nextPageToken:'';
      if(!next)break;
      if(seen.has(next))throw new Error('The file list repeated its cursor. Refresh before downloading.');
      seen.add(next);cursor=next;
    }
    if(!file)throw new Error('This file is not available to this bot. Refresh the file list.');
    const size=Number(file.sizeBytes??0);if(!Number.isSafeInteger(size)||size<0||size>MAX)throw new Error('Files up to 1 GiB can be downloaded here.');
    const id=crypto.randomUUID();this.downloads.set(id,{bot,path,size,until:this.now()+30*60_000});return {id,size,name:file.name};
  }
  async chunk(botId:string,args:Record<string,unknown>){
    const transfer=this.transfer(this.downloads,botId,args.id),offset=args.offset;
    if(!Number.isSafeInteger(offset)||(offset as number)<0||(offset as number)>transfer.size)throw new Error('Choose a valid file offset.');
    const result=await this.o.rpc('ReadGrokBotAgentAttachmentChunk',{path:transfer.path,offset:String(offset),length:CHUNK});
    const data=typeof result.data==='string'?result.data:'',size=Number(result.totalSize);
    if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))throw new Error('The file response contained invalid data.');
    if(!Number.isSafeInteger(size)||size<0||size>MAX||Buffer.from(data,'base64').length>CHUNK)throw new Error('The file response exceeded its limits.');
    if(transfer.size!==size)throw new Error('The file changed during download. Start again.');transfer.size=size;
    return {data,totalSize:size};
  }
  async beginUpload(bot:RuntimeIdentity,args:Record<string,unknown>){
    const name=args.name,hash=args.sha256,size=args.sizeBytes;
    if(typeof name!=='string'||!name.trim()||name==='.'||name==='..'||name.length>255||/[\/\\\0]/.test(name))throw new Error('Choose a valid file name.');
    if(!Number.isSafeInteger(size)||(size as number)<0||(size as number)>MAX)throw new Error('Choose a file up to 1 GiB.');
    if(typeof hash!=='string'||!/^[a-f\d]{64}$/i.test(hash))throw new Error('A SHA-256 file checksum is required.');
    const reply=await this.o.rpc('BeginGrokBotAgentFileUpload',{agentId:bot.agentId,fileName:name,sizeBytes:String(size),sha256Hex:hash,contentType:typeof args.contentType==='string'?args.contentType:'application/octet-stream'});
    const url=new URL(reply.url);if(url.protocol!=='https:'||url.username||url.password||typeof reply.uploadToken!=='string'||!reply.uploadToken)throw new Error('Grok returned an unsafe upload destination.');
    const headers:Record<string,string>={};for(const [key,value]of Object.entries(reply.headers??{})){if(typeof value!=='string'||/^(host|cookie|authorization|proxy-authorization)$/i.test(key))throw new Error('Grok returned unsupported upload headers.');headers[key]=value;}
    const id=crypto.randomUUID();this.uploads.set(id,{bot,size:size as number,until:this.now()+15*60_000,token:reply.uploadToken});return {id,url:url.href,headers,name:reply.finalName||name};
  }
  async finishUpload(bot:RuntimeIdentity,id:unknown){const value=this.transfer(this.uploads,bot.id,id);const result=await this.o.rpc('FinishGrokBotAgentFileUpload',{agentId:bot.agentId,uploadToken:value.token});this.uploads.delete(id as string);return result;}
  close(){this.uploads.clear();this.downloads.clear();}
}
