import crypto from 'node:crypto';
import type http from 'node:http';
import type {Duplex} from 'node:stream';
import {WebSocket, WebSocketServer} from 'ws';
import type {BotRuntime} from './bot-runtime.ts';

const loopback = new Set(['127.0.0.1','localhost','[::1]']);
export function resolveViewer(raw: string, box: any): URL {
  const source = new URL(raw), primary = new URL(box.vncUrl), fork = new URL(box.forkVncBaseUrl || box.vncUrl);
  if (primary.protocol !== 'https:' || fork.protocol !== 'https:' || primary.username || primary.password || fork.username || fork.password || source.username || source.password) throw new Error('Grok returned an untrusted desktop route.');
  if (loopback.has(source.hostname) && source.port === '6080') return primary;
  if (loopback.has(source.hostname) && source.port === '6081') {
    if(!box.forkVncBaseUrl)throw new Error('The provider has not supplied this bot screen route. Reconnect when it is available.');
    const url = new URL('vnc.html', fork.href.replace(/\/$/,'')+'/');
    const rawPath = source.searchParams.get('path') ?? '', split = rawPath.indexOf('?');
    const token = split < 0 ? null : new URLSearchParams(rawPath.slice(split+1)).get('token');
    const key = box.forkVncPortToken ? 'port_token' : 'network_token', value = box.forkVncPortToken || box.networkToken;
    if(typeof value!=='string'||!value)throw new Error('The desktop route has no valid network credential. Reconnect.');
    const path = new URLSearchParams({[key]:value}); if(token)path.set('token',token);
    url.searchParams.set(key,value); url.searchParams.set('path',`websockify?${path}`); return url;
  }
  if (source.protocol === 'https:' && [primary.origin,fork.origin].includes(source.origin) && source.pathname.endsWith('/vnc.html')) return source;
  throw new Error('Grok returned an untrusted desktop route.');
}

/** Parses client RFB messages, rather than trusting a view-only checkbox in remote HTML. */
export class RfbInputGate {
  private pending=Buffer.alloc(0); private serverPending=Buffer.alloc(0);
  private clientPhase=0; private serverPhase=0; private initialized=false;
  private revokedPartial=false;
  private keys=new Map<string,Buffer>(); private pointer:Buffer|null=null;
  isReady(){return this.initialized;}
  ready(){this.initialized=true;this.clientPhase=3;this.serverPhase=4;}
  server(chunk:Buffer){
    if(this.initialized)return;
    this.serverPending=Buffer.concat([this.serverPending,chunk]);
    while(true){
      const b=this.serverPending;
      if(this.serverPhase===0){if(b.length<12)return;if(!b.subarray(0,12).toString().startsWith('RFB 003.008'))throw new Error('Unsupported remote desktop protocol.');this.serverPending=b.subarray(12);this.serverPhase=1;}
      else if(this.serverPhase===1){if(b.length<1||b.length<1+b[0])return;if(!b.subarray(1,1+b[0]).includes(1))throw new Error('The provider requires an unsupported desktop authentication mode.');this.serverPending=b.subarray(1+b[0]);this.serverPhase=2;}
      else if(this.serverPhase===2){if(b.length<4)return;if(b.readUInt32BE(0)!==0)throw new Error('Desktop authentication was refused.');this.serverPending=b.subarray(4);this.serverPhase=3;}
      else {if(b.length<24)return;const length=24+b.readUInt32BE(20);if(length>1024*1024)throw new Error('Invalid desktop initialization.');if(b.length<length)return;this.serverPending=Buffer.alloc(0);this.initialized=true;return;}
    }
  }
  client(chunk:Buffer,controlled:boolean):Buffer[]{
    this.pending=Buffer.concat([this.pending,chunk]); if(this.pending.length>2*1024*1024)throw new Error('Desktop input exceeds its limit.');
    const out:Buffer[]=[];
    while(this.pending.length){
      const b=this.pending;let size=0,input=false;
      if(this.clientPhase===0){if(b.length<12)break;if(b.subarray(0,12).toString()!=='RFB 003.008\n')throw new Error('Invalid desktop handshake.');size=12;this.clientPhase=1;}
      else if(this.clientPhase===1){if(b[0]!==1)throw new Error('Unsupported desktop security selection.');size=1;this.clientPhase=2;}
      else if(this.clientPhase===2){size=1;this.clientPhase=3;}
      else {
        if(!this.initialized)break;
        switch(b[0]){
          case 0:size=20;break;
          case 2:if(b.length<4)return out;size=4+b.readUInt16BE(2)*4;break;
          case 3:size=10;break;
          case 4:size=8;input=true;break;
          case 5:size=6;input=true;break;
          case 6:if(b.length<8)return out;size=8+Math.abs(b.readInt32BE(4));input=true;break;
          case 150:size=10;break;
          case 248:if(b.length<9)return out;size=9+b[8];break;
          case 251:if(b.length<8)return out;size=8+b[6]*16;input=true;break;
          case 255:if(b.length<2)return out;if(b[1]!==0)throw new Error('Unsupported extended key message.');size=12;input=true;break;
          default:throw new Error('Unsupported desktop input message.');
        }
      }
      if(size>2*1024*1024)throw new Error('Desktop input exceeds its limit.');if(b.length<size)break;
      const packet=Buffer.from(b.subarray(0,size));this.pending=b.subarray(size);
      const revoked=this.revokedPartial;this.revokedPartial=false;
      if(input&&(revoked||!controlled))continue;
      if(input&&(packet[0]===4||packet[0]===255)){const key=packet[0]===4?`k${packet.readUInt32BE(4)}`:`q${packet.readUInt32BE(4)}:${packet.readUInt32BE(8)}`,down=packet[0]===4?packet[1]:packet.readUInt16BE(2);if(down)this.keys.set(key,packet);else this.keys.delete(key);}
      if(input&&packet[0]===5)this.pointer=packet[1]?packet:null;
      out.push(packet);
    }
    return out;
  }
  release(){
    if(this.initialized&&this.pending.length)this.revokedPartial=true;
    const messages=[...this.keys.values()].map(packet=>{const b=Buffer.from(packet);if(b[0]===4)b[1]=0;else b.writeUInt16BE(0,2);return b});this.keys.clear();
    if(this.pointer){const p=Buffer.from(this.pointer);p[1]=0;messages.push(p);this.pointer=null;}
    return messages;
  }
}
interface Viewer {id:string;botId:string;token:string;url:URL;socketURL:URL;until:number;controlled:boolean;error:string|null;controlGeneration:number;clients:Set<{client:WebSocket;upstream:WebSocket;gate:RfbInputGate}>;timer:ReturnType<typeof setTimeout>;}
interface Options {origin:()=>string;fetch?:typeof fetch;now?:()=>number;openSocket?:(url:URL,origin:string)=>WebSocket;}
export class ComputerViewer {
  private views=new Map<string,Viewer>(); private runtime:BotRuntime;private o:Options;
  constructor(runtime:BotRuntime,options:Options){this.runtime=runtime;this.o=options;}
  private now(){return(this.o.now??Date.now)();}
  async open(botId:string,monitorId?:string){
    const {status,box}=await this.runtime.computerConnection(botId,true);
    const monitor=monitorId?(status.windows??[]).find((w:any)=>String(w.subagentId??w.windowIndex)===monitorId):null;
    if(monitorId&&!monitor)throw new Error('This bot screen is no longer available.');
    const url=resolveViewer(monitor?.vncUrl??status.vncUrl,box);
    for(const v of this.views.values())if(v.botId===botId)this.close(v.id);
    const id=crypto.randomBytes(24).toString('hex'),token=crypto.randomBytes(32).toString('hex');
    const socketURL=new URL(url.searchParams.get('path')??'websockify',url);socketURL.protocol='wss:';
    if(socketURL.host!==url.host)throw new Error('The desktop socket has an untrusted origin.');
    const timer=setTimeout(()=>this.close(id),30*60_000);timer.unref();
    this.views.set(id,{id,botId,token,url,socketURL,until:this.now()+30*60_000,controlled:false,error:null,controlGeneration:0,clients:new Set(),timer});
    const local=new URL(`/computer/${id}/vnc.html`,this.o.origin());local.searchParams.set('autoconnect','true');local.searchParams.set('resize','scale');local.searchParams.set('view_only','true');local.searchParams.set('path',`/computer/${id}/socket`);
    return {id,url:local.href,authorization:`Bearer ${token}`,state:'connecting',hasControl:false};
  }
  private get(id:string){const v=this.views.get(id);if(!v||v.until<=this.now()){this.close(id);throw new Error('This computer viewer is closed. Connect again.');}return v;}
  private authenticate(req:http.IncomingMessage,v:Viewer){
    const bearer=req.headers.authorization===`Bearer ${v.token}`;
    const cookie=(req.headers.cookie??'').split(';').map(s=>s.trim()).includes(`gc_view_${v.id}=${v.token}`);
    return req.headers.host===new URL(this.o.origin()).host&&(bearer||cookie);
  }
  async control(id:string,enabled:boolean,botId?:string){
    const view=this.get(id);if(botId!==undefined&&botId!==view.botId)throw new Error('This viewer belongs to another bot.');
    const generation=++view.controlGeneration;
    if(!enabled)this.release(view);
    await this.runtime.identity(view.botId);
    if(this.views.get(id)!==view||generation!==view.controlGeneration)return {hasControl:false};
    if(enabled&&![...view.clients].some(c=>c.upstream.readyState===WebSocket.OPEN&&c.gate.isReady()))throw new Error('Wait for the computer screen to connect before taking control.');
    if(enabled)for(const v of this.views.values())if(v!==view){v.controlGeneration++;this.release(v);}
    view.controlled=enabled;
    return {hasControl:view.controlled};
  }
  state(id:string,botId?:string){const v=this.get(id);if(botId!==undefined&&v.botId!==botId)throw new Error('This viewer belongs to another bot.');return {connected:[...v.clients].some(c=>c.upstream.readyState===WebSocket.OPEN&&c.gate.isReady()),hasControl:v.controlled,error:v.error};}
  async disconnect(id:string,botId:string){const v=this.get(id);if(v.botId!==botId)throw new Error('This viewer belongs to another bot.');this.close(id);const status=await this.runtime.command(botId,'computerStatus');const requestId=status.handoff?.requestId;if(requestId)await this.runtime.command(botId,'handBack',{requestId,trigger:'viewer-closed'});return {ok:true};}
  async validateState(id:string,botId:string){
    this.state(id,botId);
    try {await this.runtime.identity(botId);return this.state(id,botId);}catch(error){this.close(id);throw error;}
  }
  private release(v:Viewer){for(const c of v.clients)for(const packet of c.gate.release())if(c.upstream.readyState===WebSocket.OPEN)c.upstream.send(packet);v.controlled=false;}
  async handle(req:http.IncomingMessage,res:http.ServerResponse):Promise<boolean>{
    const raw=req.url??'/',local=new URL(raw,this.o.origin()),parts=local.pathname.split('/');if(parts[1]!=='computer')return false;
    const fail=(code:number)=>{res.writeHead(code,{'content-type':'text/plain','cache-control':'no-store'});res.end('This computer viewer is unavailable. Reconnect from Grok Call.');};
    try{
      if (/%2e|%2f|%5c/i.test(raw.split('?')[0])) {fail(403);return true;}
      const v=this.get(parts[2]);
      if(!this.authenticate(req,v)||!['GET','HEAD'].includes(req.method??'')){fail(403);return true;}
      const asset=parts.slice(3).join('/');
      // The allowlist already confines the asset; the resolved-URL check stays as defense in depth on the same rejection path.
      const target=/^[A-Za-z0-9_.@/-]+$/.test(asset)&&!asset.startsWith('/')&&!asset.includes('..')?new URL(asset,v.url):null;
      if(!target||target.origin!==v.url.origin||!target.pathname.startsWith(new URL('.',v.url).pathname)){fail(403);return true;}target.search=v.url.search;
      const upstream=await(this.o.fetch??fetch)(target,{redirect:'error',signal:AbortSignal.timeout(20000)});
      const headers:Record<string,string>={'content-type':upstream.headers.get('content-type')??'application/octet-stream','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff', 'set-cookie':`gc_view_${v.id}=${v.token}; HttpOnly; SameSite=Strict; Path=/computer/${v.id}/`, 'content-security-policy':`default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${this.o.origin().replace('http:','ws:')}; frame-ancestors 'none'; base-uri 'self'; form-action 'none'`};
      res.writeHead(upstream.status,headers);
      if(req.method==='HEAD'){res.end();await upstream.body?.cancel();return true;}
      if(upstream.body)for await(const data of upstream.body){if(res.destroyed)break;if(!res.write(data))await new Promise<void>(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.on('drain',done);res.on('close',done);});}
      res.end();
    }catch{if(!res.headersSent)fail(502);else res.destroy();}
    return true;
  }
  upgrade(req:http.IncomingMessage,socket:Duplex,head:Buffer):boolean{
    const path=new URL(req.url??'/',this.o.origin()).pathname,match=path.match(/^\/computer\/([a-f\d]+)\/socket$/);if(!match)return false;
    try{
      const v=this.get(match[1]);if(!this.authenticate(req,v)||req.headers.origin!==this.o.origin())throw new Error('Unauthorized viewer');
      const wss=new WebSocketServer({noServer:true,maxPayload:2*1024*1024});
      wss.handleUpgrade(req,socket,head,client=>{
        const upstream=this.o.openSocket?this.o.openSocket(v.socketURL,v.url.origin):new WebSocket(v.socketURL,['binary'],{origin:v.url.origin,handshakeTimeout:20000});const pair={client,upstream,gate:new RfbInputGate()};v.clients.add(pair);
        let stopped=false;const stop=(reason?:string)=>{if(stopped)return;if(reason)v.error=reason;stopped=true;clearTimeout(initializing);this.release(v);v.clients.delete(pair);client.close();upstream.close();};
        const initializing=setTimeout(()=>stop('The desktop did not initialize in time. Reconnect to try again.'),30000);initializing.unref();
        upstream.on('message',data=>{try{const b=Buffer.from(data as any);pair.gate.server(b);if(pair.gate.isReady()){clearTimeout(initializing);v.error=null;}if(client.readyState===WebSocket.OPEN)client.send(b);}catch(error){stop((error as Error).message);}});
        client.on('message',data=>{try{if(upstream.readyState!==WebSocket.OPEN)return;for(const packet of pair.gate.client(Buffer.from(data as any),v.controlled))upstream.send(packet);}catch(error){stop((error as Error).message);}});
        for(const ws of [client,upstream]){ws.on('error',()=>stop('The desktop connection failed. Reconnect to continue.'));ws.on('close',()=>stop());}
      });
    }catch{socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');}
    return true;
  }
  close(id:string){const v=this.views.get(id);if(!v)return;clearTimeout(v.timer);v.controlGeneration++;this.release(v);this.views.delete(id);for(const c of v.clients){c.client.terminate();c.upstream.terminate();}v.clients.clear();}
  closeAll(){for(const id of [...this.views.keys()])this.close(id);}
}
