import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ConnectionsManager } from '../src/connections.ts';
import { mock, sendJson, type Mock } from './helpers.ts';

const plugin = (id = '1', extra = {}) => ({ id, name: `app-${id}`, displayName: `App ${id}`, description: 'A useful connection', mcpServers: [{ name: `App ${id}` }], skills: [], variables: { type: 'object', properties: {} }, ...extra });
const open: { manager: ConnectionsManager; up: Mock }[] = [];
afterEach(async () => { for (const h of open.splice(0)) { h.manager.close(); await h.up.close(); } });
async function setup() {
  const state: any = {
    plugins: [plugin('1'), plugin('2', { skills: [{ name: 'A skill' }], mcpServers: [] })],
    installed: [{ plugin: plugin('1'), isEnabled: true, configuredVariables: { SECRET: 'never-return' }, configuredVariableKeys: ['SECRET'] }],
    servers: [{ id: 10, name: 'App 1', serverIdentifier: 'user-App 1', enabled: true, type: 'HTTP', pluginId: '1', userHasAccessToken: false, url: 'https://app.invalid/mcp', accounts: [] }],
    permissions: { servers: [] }, settings: { settings: { servers: [], userTimeZone: 'Keep/me' } },
    ready: false, continuation: '', completeFail: false, onePassword: { connections: [] }, time: 100,
  };
  let seq = 0;
  const up = await mock((req, res) => {
    const method = req.url.split('/').pop();
    if (state.override?.(method, req, res)) return;
    if (method === 'ListMarketplacePlugins') return sendJson(res, 200, { plugins: state.plugins });
    if (method === 'ListMarketplaces') return sendJson(res, 200, { marketplaces: [] });
    if (method === 'GetEffectiveUserPlugins') return sendJson(res, 200, { plugins: state.installed });
    if (method === 'GetAvailableMcpServers') return sendJson(res, 200, { servers: state.servers });
    if (method === 'GetOnePasswordState') return sendJson(res, 200, state.onePassword);
    if (method === 'GetGrokBotMcpToolPermissions') return sendJson(res, 200, state.permissions);
    if (method === 'GetGrokBotUserMcpSettings') return sendJson(res, 200, state.settings);
    if (method === 'ListSandMcpTools') return sendJson(res, 200, { servers: [{ serverIdentifier: 'user-App 1', status: 'connected', tools: [{ name: 'user-App 1-read', toolName: 'read', description: 'Read it' }] }] });
    if (method === 'CheckHttpMcpStatus') {
      const auth = new URL('https://provider.invalid/authorize');
      auth.searchParams.set('state', `state-${++seq}`);
      auth.searchParams.set('redirect_uri', req.body.oauthRedirectUri);
      return sendJson(res, 200, { statuses: [{ id: 10, serverIdentifier: 'user-App 1', requiresAuth: !state.ready, isAvailable: state.ready, hasValidToken: state.ready, ...state.ready ? {} : { authUrl: auth.href } }] });
    }
    if (method === 'CompleteMcpOAuth') {
      if (state.completeFail) return sendJson(res, 400, { message: 'Code rejected' });
      state.ready = !req.body.oauthError;
      return sendJson(res, 200, state.continuation ? { continueAuthorizationUrl: state.continuation } : {});
    }
    return sendJson(res, 200, {});
  });
  const manager = new ConnectionsManager(async (service, method, body, headers) => {
    const r = await fetch(`${up.url}/${service}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) throw new Error(j.message); return j;
  }, { ports: [0], now: () => state.time, authMs: 1000 });
  open.push({ manager, up });
  return { manager, up, state, run: (action: string, args: Record<string, unknown> = {}) => manager.command(action, args) as Promise<any> };
}
const calls = (up: Mock, name: string) => up.requests.filter((r) => r.url.endsWith('/' + name));
const callback = (flow: any) => {
  const u = new URL(flow.authorizationUrl); return { url: new URL(u.searchParams.get('redirect_uri')!), state: u.searchParams.get('state')! };
};

test('catalog includes installed, skills-only, custom and native entries without exposing configured secrets', async () => {
  const { run, up } = await setup();
  const out = await run('list');
  assert.ok(out.entries.some((p: any) => p.id === '1' && p.installed));
  assert.ok(out.entries.some((p: any) => p.id === '2' && p.connectors.length === 0 && p.skills.length === 1));
  for (const id of ['native:messages', 'native:onepassword', 'native:email']) assert.ok(out.entries.some((p: any) => p.id === id));
  assert.doesNotMatch(JSON.stringify(out), /never-return|configuredVariables/);
  assert.equal(calls(up, 'GetEffectiveUserPlugins')[0].body.excludeConfiguredVariables, true);
});

test('setup fields are validated before installation and only submitted values are sent', async () => {
  const { run, state, up } = await setup();
  state.plugins[1].variables = { type: 'object', required: ['API_KEY'], properties: { API_KEY: { type: 'string', title: 'API key' }, REGION: { type: 'string', enum: ['a', 'b'] } } };
  const out = await run('list');
  assert.equal(out.entries.find((p: any) => p.id === '2').fields[0].secret, true);
  await assert.rejects(run('install', { id: '2', values: {} }), /API_KEY/);
  await assert.rejects(run('install', { id: '2', values: { API_KEY: 'x', REGION: 'z' } }), /Invalid/);
  assert.equal(calls(up, 'InstallUserPlugin').length, 0);
  await run('install', { id: '2', values: { API_KEY: 'entered-here', REGION: 'a' } });
  assert.deepEqual(calls(up, 'InstallUserPlugin')[0].body, { pluginId: '2', variables: { API_KEY: 'entered-here', REGION: 'a' } });
});

test('team-required plugins cannot be disabled or removed and unknown ids never mutate', async () => {
  const { run, state, up } = await setup();
  state.installed[0].isTeamRequired = true;
  await run('list');
  await assert.rejects(run('uninstall', { id: '1' }), /required/i);
  await assert.rejects(run('enable', { id: '1', enabled: false }), /required/i);
  await assert.rejects(run('install', { id: 'missing', values: {} }), /Unknown/);
  assert.equal(calls(up, 'UninstallUserPlugin').length, 0);
});

test('OAuth binds its callback before authorization, exchanges only a matching state, verifies completion and rejects replay', async () => {
  const { run, up } = await setup();
  await run('list');
  const { flow } = await run('authenticate', { id: 'user-App 1', account: 'default' });
  const c = callback(flow);
  assert.equal(c.url.hostname, 'localhost');
  c.url.searchParams.set('state', 'wrong'); c.url.searchParams.set('code', 'code');
  assert.equal((await fetch(c.url)).status, 400);
  assert.equal(calls(up, 'CompleteMcpOAuth').length, 0);
  c.url.searchParams.set('state', c.state);
  assert.equal((await fetch(c.url)).status, 200);
  assert.deepEqual(calls(up, 'CompleteMcpOAuth')[0].body, { stateId: c.state, authorizationCode: 'code' });
  assert.equal((await run('authStatus')).flow.status, 'connected');
  assert.equal(calls(up, 'CheckHttpMcpStatus')[0].headers['x-cursor-mcp-oauth-relayed-loopback'], '1');
  // The listener remains until the manager closes, so a replay gets a definite rejection.
  assert.equal((await fetch(c.url)).status, 400);
  assert.equal(calls(up, 'CompleteMcpOAuth').length, 1);
});

test('canceling or expiring authentication never deletes existing credentials', async () => {
  const { run, state, up } = await setup();
  await run('list');
  await run('authenticate', { id: 'user-App 1' });
  assert.equal((await run('cancelAuth')).flow.status, 'cancelled');
  const { flow } = await run('authenticate', { id: 'user-App 1' });
  state.time += 1001;
  assert.equal((await run('authStatus')).flow.status, 'expired');
  const c = callback(flow); c.url.searchParams.set('state', c.state); c.url.searchParams.set('code', 'late');
  assert.equal((await fetch(c.url)).status, 400);
  assert.equal(calls(up, 'CompleteMcpOAuth').length, 0);
  assert.equal(calls(up, 'DeleteMcpOAuthToken').length, 0);
});

test('account and tool management use the selected server and preserve other saved settings', async () => {
  const { run, state, up } = await setup();
  state.settings.settings.servers = [{ serverId: 'unrelated', disabledTools: ['keep'], customInstructions: 'Keep this' }];
  await run('list');
  await run('renameAccount', { id: 'user-App 1', account: 'work', name: 'Work mail' });
  assert.deepEqual(calls(up, 'RenameMcpOAuthAccount')[0].body, { serverId: 10, accountKey: 'work', newAccountKey: 'Work mail' });
  await run('disconnect', { id: 'user-App 1', account: 'work' });
  assert.equal(calls(up, 'DeleteMcpOAuthAccount')[0].body.accountKey, 'work');
  await run('setRule', { id: 'user-App 1', tool: 'read', permission: 'blocked' });
  assert.equal(calls(up, 'SetGrokBotMcpToolPermissions')[0].body.tools.read, 'GROK_BOT_TOOL_PERMISSION_BLOCKED');
  const settings = calls(up, 'SetGrokBotUserMcpSettings')[0].body.settings;
  assert.equal(settings.userTimeZone, 'Keep/me');
  assert.deepEqual(settings.servers[0], state.settings.settings.servers[0]);
});

test('configuration merges changed secrets; enabling and uninstalling use existing installations', async () => {
  const { run, state, up } = await setup();
  state.installed[0].plugin.variables = {type:'object',required:['SECRET'],properties:{SECRET:{type:'string',writeOnly:true}}};
  await run('list');
  await run('configure',{id:'1',values:{}});
  assert.deepEqual(calls(up,'UpdateUserPluginInstall')[0].body,{pluginId:'1',variables:{},mergeWithStored:true});
  await run('enable',{id:'1',enabled:false});
  await run('uninstall',{id:'1'});
  assert.equal(calls(up,'UpdateUserPluginInstall')[1].body.isEnabled,false);
  assert.equal(calls(up,'UninstallUserPlugin').length,1);
  await assert.rejects(run('enable',{id:'2',enabled:true}),/installed/);
  await assert.rejects(run('uninstall',{id:'2'}),/no longer installed/);
  await assert.rejects(run('install',{id:'2',values:null}),/object/);
  await assert.rejects(run('install',{id:'2',values:[]}),/object/);
  await assert.rejects(run('install',{id:'native:messages',values:{}}),/native/);
  await assert.rejects(run('wat'),/Unknown/);
  await assert.rejects(run('native',{id:'1'}),/no native/);
  await assert.rejects(run('native',{id:''}),/required/);
  assert.match((await run('native',{id:'native:onepassword'})).url,/onepassword/);
});

test('native status, custom accounts, policy defaults and legacy disabled rules stay distinct',async()=>{
  const {run,state}=await setup();
  state.onePassword={connections:[{secret:'do-not-forward'},{secret:'do-not-forward'}],items:[{password:'never'}]};
  state.servers.push({id:20,name:'Custom',serverIdentifier:'custom',enabled:false,accounts:[{accountKey:'work',accountEmail:'work@example.test',userHasAccessToken:true}]});
  state.permissions={servers:[{serverId:'10',disabledTools:['read'],policy:{reads:'GROK_BOT_TOOL_PERMISSION_NEEDS_APPROVAL',tools:{read:'GROK_BOT_TOOL_PERMISSION_ALWAYS_ALLOW'}}}]};
  const out=await run('list');
  assert.equal(out.entries.find((e:any)=>e.id==='server:custom').enabled,false);
  assert.match(out.entries.find((e:any)=>e.id==='native:onepassword').summary,/2 accounts/);
  assert.doesNotMatch(JSON.stringify(out),/do-not-forward|never/);
  assert.equal((await run('tools',{id:'user-App 1'})).tools[0].permission,'blocked');
  await assert.rejects(run('setRule',{id:'user-App 1',tool:'bad',permission:'allow'}),/not available/);
  await assert.rejects(run('setRule',{id:'user-App 1',tool:'read',permission:'bad'}),/Choose/);
  await assert.rejects(run('authenticate',{id:'unknown'}),/Unknown/);
});

test('OAuth handles provider denial, completion failure, continuation, and existing sessions',async()=>{
  const {run,state}=await setup();
  const hit=async(flow:any,params:Record<string,string>)=>{const c=callback(flow);c.url.searchParams.set('state',c.state);for(const[k,v]of Object.entries(params))c.url.searchParams.set(k,v);return fetch(c.url)};
  let {flow}=await run('authenticate',{id:'user-App 1',reconnect:true});
  await assert.rejects(run('authenticate',{id:'user-App 1'}),/Finish/);
  assert.equal((await hit(flow,{error:'access_denied'})).status,200);
  assert.equal((await run('authStatus')).flow.status,'cancelled');
  ({flow}=await run('authenticate',{id:'user-App 1'}));
  state.completeFail=true;
  assert.equal((await hit(flow,{code:'bad'})).status,400);
  assert.equal((await run('authStatus')).flow.status,'failed');
  state.completeFail=false;
  ({flow}=await run('authenticate',{id:'user-App 1'}));
  const c=callback(flow);
  const next=new URL('https://provider.invalid/continue');next.searchParams.set('state','next');next.searchParams.set('redirect_uri',c.url.href);
  state.continuation=next.href;
  assert.equal((await hit(flow,{code:'first'})).status,200);
  assert.equal((await run('authStatus')).flow.status,'waiting');
  state.continuation='';
  assert.equal((await hit((await run('authStatus')).flow,{code:'second'})).status,200);
  assert.equal((await run('authenticate',{id:'user-App 1'})).flow.status,'connected');
});

test('malformed callbacks never exchange a code',async()=>{
  const {run,up}=await setup();
  const {flow}=await run('authenticate',{id:'user-App 1'});
  const c=callback(flow);c.url.searchParams.set('state',c.state);
  assert.equal((await fetch(c.url)).status,400);
  c.url.searchParams.set('code','ok');c.url.searchParams.set('error','no');
  assert.equal((await fetch(c.url)).status,400);
  c.url.searchParams.delete('error');c.url.searchParams.append('code','twice');
  assert.equal((await fetch(c.url)).status,400);
  c.url.searchParams.delete('code');c.url.searchParams.set('error','one');c.url.searchParams.append('error','two');
  assert.equal((await fetch(c.url)).status,400);
  assert.equal((await fetch(c.url,{method:'POST'})).status,400);
  c.url.pathname='/other';assert.equal((await fetch(c.url)).status,400);
  assert.equal(calls(up,'CompleteMcpOAuth').length,0);
});

test('private catalogs paginate, merge installed-only entries, and surface partial failures',async()=>{
  const {run,state}=await setup();
  state.override=(method:any,req:any,res:any)=>{
    if(method==='ListMarketplaces'){sendJson(res,200,{marketplaces:[{id:'private',name:'Team',isPrivate:true},{id:'broken',teamId:'t'}]});return true}
    if(method==='ListMarketplacePlugins'){
      if(req.body.marketplaceId==='broken'){sendJson(res,500,{message:'Down'});return true}
      if(req.body.marketplaceId==='private'){sendJson(res,200,{plugins:[plugin('3')],hasMore:!req.body.pageToken,nextPageToken:'next'});return true}
    }
  };
  state.installed.push({plugin:plugin('4',{isDeprecated:true}),installMode:'EFFECTIVE_PLUGIN_INSTALL_MODE_TEAM_REQUIRED',isEnabled:false});
  state.plugins.push({},plugin('5',{teamAdminInstallBlockReason:'BLOCKED'}));
  state.servers.push({});
  let out=await run('list');
  assert.ok(out.entries.some((e:any)=>e.id==='3'));
  assert.equal(out.entries.find((e:any)=>e.id==='4').required,true);
  assert.equal(out.warnings.length,3);
  await assert.rejects(run('install',{id:'5',values:{}}),/team/);
  state.override=(m:any,_:any,r:any)=>{if(['ListMarketplaces','GetOnePasswordState'].includes(m)){sendJson(r,500,{message:'Unavailable'});return true}};
  out=await run('list');assert.equal(out.warnings.length,4);
});

test('invalid catalog pagination and malformed lists fail visibly',async()=>{
  const {run,state}=await setup();
  for(const response of [{plugins:[],hasMore:true},{plugins:[],hasMore:true,nextPageToken:'same'},{plugins:'bad'}]){
    state.override=(m:any,_:any,r:any)=>{if(m==='ListMarketplacePlugins'){sendJson(r,200,response);return true}};
    await assert.rejects(run('list'),/invalid/);
  }
});

test('configuration errors redact credentials and concurrent mutations are refused',async()=>{
  const {run,state,up}=await setup();
  state.installed[0].plugin.variables={type:'object',properties:{SECRET:{type:'string',format:'password'}}};
  await run('list');
  let release:()=>void=()=>{};
  state.override=(m:any,_:any,r:any)=>{if(m==='UpdateUserPluginInstall'){release=()=>sendJson(r,400,{message:'Failure secret-value'});return true}};
  const changing=run('configure',{id:'1',values:{SECRET:'secret-value'}});
  // Wait until the mock actually receives the mutation, rather than sleeping through a race.
  const {until}=await import('./helpers.ts');await until(()=>calls(up,'UpdateUserPluginInstall').length>0);
  await assert.rejects(run('enable',{id:'1',enabled:false}),/already running/);
  release();await assert.rejects(changing,(e:Error)=>e.message==='Failure [redacted]');
});

test('permission edits preserve read/write policies and clear only the chosen legacy block',async()=>{
  const {run,state,up}=await setup();
  state.permissions={servers:[{serverId:'10',policy:{reads:'GROK_BOT_TOOL_PERMISSION_NEEDS_APPROVAL',writes:'GROK_BOT_TOOL_PERMISSION_BLOCKED',tools:{keep:'GROK_BOT_TOOL_PERMISSION_BLOCKED'}}}]};
  state.settings.settings.servers=[{serverId:'10',disabledTools:['read','user-App 1-read','keep'],customInstructions:'Keep'}];
  await run('setRule',{id:'user-App 1',tool:'user-App 1-read',permission:'allow'});
  const p=calls(up,'SetGrokBotMcpToolPermissions')[0].body;
  assert.equal(p.reads,'GROK_BOT_TOOL_PERMISSION_NEEDS_APPROVAL');assert.equal(p.writes,'GROK_BOT_TOOL_PERMISSION_BLOCKED');assert.equal(p.tools.keep,'GROK_BOT_TOOL_PERMISSION_BLOCKED');
  const saved=calls(up,'SetGrokBotUserMcpSettings')[0].body.settings.servers[0];
  assert.deepEqual(saved.disabledTools,['keep']);assert.equal(saved.customInstructions,'Keep');
});

test('unsafe and incomplete authorization responses never open a usable flow',async()=>{
  const {run,state}=await setup();
  for(const status of [null,{requiresAuth:true},{requiresAuth:true,error:'Denied'},{requiresAuth:true,authUrl:'file:///etc/passwd'},{requiresAuth:true,authUrl:'https://provider.invalid/'},{requiresAuth:true,authUrl:'https://user:pass@provider.invalid/?state=s'}]){
    state.override=(m:any,_:any,r:any)=>{if(m==='CheckHttpMcpStatus'){sendJson(r,200,{statuses:status?[{serverIdentifier:'user-App 1',...status}]:[]});return true}};
    await assert.rejects(run('authenticate',{id:'user-App 1'}));
  }
});

test('catalog tolerates missing optional metadata and retains one native account summary',async()=>{
  const {run,state}=await setup();
  state.plugins=[{id:'7',name:'Minimal',tags:['Other'],mcpServers:[{}, {name:'Connector'}],skills:null},plugin('8',{variables:{properties:{REGION:{description:'Region',default:'us'}}}})];
  state.installed=[];
  state.onePassword={connections:[{}]};
  state.servers=[{id:20,name:'Custom',serverIdentifier:'custom',hasStaticCredentialHeaders:true,userHasAccessToken:false,accounts:[{accountKey:'key',displayName:'Display',serverIdentifier:'custom-account'}]}];
  const out=await run('list');assert.equal(out.entries.find((e:any)=>e.id==='7').summary,'');
  assert.match(out.entries.find((e:any)=>e.id==='native:onepassword').summary,/1 account configured/);
  await run('disconnect',{id:'custom-account',account:'key'});
});

test('missing optional lists are empty, and tool permissions accept either tool name format',async()=>{
  const {run,state}=await setup();
  state.permissions={servers:[{serverId:'user-App 1',policy:{tools:{'user-App 1-read':'GROK_BOT_TOOL_PERMISSION_NEEDS_APPROVAL'}}}]};
  state.settings={};
  assert.equal((await run('tools',{id:'user-App 1'})).tools[0].permission,'ask');
  await run('setRule',{id:'user-App 1',tool:'read',permission:'auto'});
  state.override=(m:any,_:any,r:any)=>{if(m==='ListSandMcpTools'){sendJson(r,200,{servers:[{rowServerIdentifier:'user-App 1',tools:[{name:'plain'}]}]});return true}};
  assert.equal((await run('tools',{id:'user-App 1'})).tools[0].key,'plain');
  state.override=(m:any,_:any,r:any)=>{if(['ListMarketplaces','ListSandMcpTools'].includes(m)){sendJson(r,200,{});return true}};
  assert.equal((await run('tools',{id:'user-App 1'})).status,'unavailable');
  await run('list');
  // A first direct native command loads its list lazily.
  const other=await setup();assert.match((await other.run('native',{id:'native:messages'})).url,/messages/);
});

test('unnamed accounts and settings without disabled tools remain usable',async()=>{
 const {run,state}=await setup();
 state.servers[0].accounts=[{accountKey:'default',serverIdentifier:'account-id'}];
 state.servers.push({id:11,name:'Other',serverIdentifier:'other'});
 state.settings={settings:{servers:[{serverId:'10'}]}};
 const out=await run('list');assert.equal(out.entries.find((e:any)=>e.id==='1').servers[0].accounts[0].name,'default');
 await assert.rejects(run('tools',{id:'unknown'}),/Unknown/);
 await run('tools',{id:'user-App 1'});
});

test('built-in account services use their own setup instead of HTTP MCP OAuth',async()=>{
 const {run,state,up}=await setup();
 state.servers=[{id:-1000,serverIdentifier:'cursor-github',name:'GitHub'},{id:-1001,serverIdentifier:'cursor-origin',name:'Origin'}];
 const snapshot=await run('list');
 assert.equal(snapshot.entries.find((e:any)=>e.name==='Origin').servers[0].included,true);
 assert.equal((await run('authenticate',{id:'cursor-github'})).url,'https://cursor.com/dashboard?tab=integrations');
 await assert.rejects(run('authenticate',{id:'cursor-origin'}),/included/);
 assert.equal(calls(up,'CheckHttpMcpStatus').length,0);
});

test('service outages are checked read-only and never mislabeled as sign-in failures',async()=>{
 const {run,state,up}=await setup();
 state.override=(m:any,_:any,r:any)=>{if(m==='CheckHttpMcpStatus'){sendJson(r,200,{statuses:[{serverIdentifier:'user-App 1',error:'Streamable HTTP error: {"error":{"code":"503","message":"The deployment is currently unavailable"}}',signInRefusal:{kind:'MCP_SIGN_IN_REFUSAL_KIND_TRANSPORT_FAILURE',transportFailureReason:'MCP_TRANSPORT_FAILURE_REASON_HTTP_5XX'}}]});return true}};
 const checked=await run('check',{id:'user-App 1'});
 assert.equal(checked.status,'unavailable');assert.match(checked.message,/service.*unavailable/i);assert.doesNotMatch(checked.message,/Streamable|POSTing|\{/);
 assert.equal(calls(up,'CheckHttpMcpStatus')[0].body.statusOnly,true);
 await assert.rejects(run('authenticate',{id:'user-App 1'}),/service.*unavailable/i);
 assert.equal((await run('authStatus')).flow.authorizationUrl,null);
});

test('connection checks distinguish auth, health, disabled and unknown states without starting OAuth',async()=>{
 const {run,state,up}=await setup();
 for(const [status,expected] of [[{requiresAuth:true},'needsAuth'],[{isAvailable:true},'connected'],[{},'unknown'],[null,'unknown'],[{error:'HTTP 429'},'rateLimited']] as const){
  state.override=(m:any,_:any,r:any)=>{if(m==='CheckHttpMcpStatus'){sendJson(r,200,{statuses:status?[{serverIdentifier:'user-App 1',...status}]:[]});return true}};
  assert.equal((await run('check',{id:'user-App 1',account:'work'})).status,expected);
 }
 state.override=(m:any,_:any,r:any)=>{if(m==='CheckHttpMcpStatus'){sendJson(r,503,{message:'HTTP 503'});return true}};
 assert.equal((await run('check',{id:'user-App 1'})).status,'unavailable');
 state.servers[0].enabled=false;assert.equal((await run('check',{id:'user-App 1'})).status,'disabled');
 assert.equal(calls(up,'CompleteMcpOAuth').length,0);
 assert.ok(calls(up,'CheckHttpMcpStatus').every((r:any)=>r.body.statusOnly===true&&r.body.userInitiated===false));
});

test('built-in health checks discover tools and tool errors include a usable message',async()=>{
 const {run,state}=await setup();
 state.servers.push({id:-1000,name:'GitHub',serverIdentifier:'cursor-github'},{id:-1001,name:'Origin',serverIdentifier:'cursor-origin'});
 state.override=(m:any,_:any,r:any)=>{if(m==='ListSandMcpTools'){sendJson(r,200,{servers:[{serverIdentifier:'cursor-github',status:'connected'}]});return true}};
 assert.equal((await run('check',{id:'cursor-github'})).status,'connected');assert.equal((await run('check',{id:'cursor-origin'})).status,'needsAuth');
 state.override=(m:any,_:any,r:any)=>{if(m==='ListSandMcpTools'){sendJson(r,200,{servers:[{serverIdentifier:'user-App 1',status:'unavailable',error:'HTTP 503'}]});return true}};
 assert.match((await run('tools',{id:'user-App 1'})).message,/service.*unavailable/i);
});

test('pinned manifest setup fields survive refresh and are required before installing',async()=>{
 const source={gitUrl:'https://github.com/example/plugin',gitRef:'a'.repeat(40),gitPath:'.'};
 let installed:any, requests=0;
 const manager=new ConnectionsManager(async(_s,m,b)=>{
  if(m==='ListMarketplacePlugins')return {plugins:[plugin('77',{...source,variables:{}})]};
  if(m==='InstallUserPlugin'){installed=b;return {}};
  return {};
 },{fetchManifest:async()=>{requests++;return new Response(JSON.stringify({variables:{type:'object',properties:{API_KEY_21ST:{type:'string'}},required:['API_KEY_21ST']}}))}});
 try{
  await manager.command('list');const {entry}=await manager.command('details',{id:'77'});
  assert.equal(entry.fields[0].secret,true);
  await assert.rejects(manager.command('install',{id:'77',values:{}}),/API_KEY_21ST/);
  await manager.command('install',{id:'77',values:{API_KEY_21ST:'entered'}});
  assert.equal(installed.variables.API_KEY_21ST,'entered');
  const refreshed=await manager.command('list');assert.equal(refreshed.entries.find((e:any)=>e.id==='77').fields[0].key,'API_KEY_21ST');assert.equal(requests,1);
  assert.equal((await manager.command('details',{id:'native:messages'})).entry.kind,'native');
 }finally{manager.close()}
});
