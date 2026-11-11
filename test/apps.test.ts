import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { AuthStore } from '../src/auth.ts';
import { GrokBotClient } from '../src/grokbot.ts';
import { ConnectedApps, TOOL_LIST_REUSE_MS } from '../src/apps.ts';
import { mock, sendJson, until, type Mock } from './helpers.ts';
import { OverlayCall } from '../src/overlay/call.ts';
import { bot, FakeAudio, FakeSocket, reply } from './overlay-fakes.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-apps-'));
const LINE = { theyJustTalked: true, newsOwed: false, receiptOwed: false, alreadySpokeThisTurn: false };
const tool = (name = 'profile', extra = {}) => ({ name: `user-Mail-${name}`, toolName: name, description: `Read ${name}`, inputSchemaJson: '{"type":"object","properties":{}}', annotationsJson: '{"readOnlyHint":true}', ...extra });
let up: Mock;
let servers: any;
let listed: any;
let permissions: any;
let settings: any;
let result: any;
let executeStatus: number;
let delay = 0;
let token = 'token';
let late401 = false;
let expiredRequests = 0;
let on401 = () => {};
let n = 0;
beforeEach(async () => {
  await up?.close();
  servers = { servers: [{ name: 'Mail', serverIdentifier: 'user-Mail', enabled: true, type: 'HTTP', userHasAccessToken: true }, { name: 'Offline', serverIdentifier: 'user-Offline', enabled: true, type: 'HTTP', userHasAccessToken: false }] };
  listed = { servers: [{ serverIdentifier: 'user-Mail', status: 'connected', tools: [tool()] }, { serverIdentifier: 'user-Offline', status: 'needsAuth' }] };
  permissions = {};
  settings = {};
  result = { result: { success: { content: [{ text: 'Your profile' }] } } };
  executeStatus = 200;
  delay = 0;
  token = 'token';
  late401 = false;
  expiredRequests = 0;
  on401 = () => {};
  up = await mock((req, res) => {
    const method = req.url.split('/').pop();
    if (method === 'token') return void setTimeout(() => sendJson(res, 200, { access_token: token, refresh_token: 'next' }), 20);
    if (req.headers.authorization !== `Bearer ${token}`) {
      on401();
      if (late401 && ++expiredRequests === 2) return void setTimeout(() => sendJson(res, 401, { message: 'Expired' }), 80);
      return sendJson(res, 401, { message: 'Expired' });
    }
    if (method === 'ListGrokBotAgents') return sendJson(res, 200, { agents: ['a', 'b'].map((id) => ({ id, name: id, kind: 'GROK_BOT_AGENT_KIND_AGENT' })) });
    if (method === 'VoiceCallHarnessSession') return sendJson(res, 200, { instructions: 'Be helpful.' });
    if (method === 'MintSandVoiceCallSecret') return sendJson(res, 200, { clientSecret: 'secret', model: 'voice', websocketUrl: 'wss://voice.test' });
    if (method === 'ListGrokBotUserComputers') return sendJson(res, 200, {});
    if (method === 'GetGrokBotMcpToolPermissions') return sendJson(res, 200, permissions);
    if (method === 'GetGrokBotUserMcpSettings') return sendJson(res, 200, settings);
    assert.ok(req.url.startsWith('/aiserver.v1.DashboardService/'), req.url);
    if (method === 'GetAvailableMcpServers') return sendJson(res, 200, servers);
    if (method === 'ListSandMcpTools') return sendJson(res, 200, listed);
    assert.equal(method, 'ExecuteSandMcpTool');
    setTimeout(() => sendJson(res, executeStatus, result), delay);
  });
});
after(async () => { await up.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
async function setup(timeoutMs?: number) {
  const store = new AuthStore(path.join(tmp, String(++n)));
  store.write({ accessToken: 'token', refreshToken: 'refresh', machineId: 'machine' });
  const client = new GrokBotClient({ store, apiUrl: up.url, toolTimeoutMs: timeoutMs });
  const a = await client.voiceSession('a');
  const b = await client.voiceSession('b');
  const call = async (name: string, input: Record<string, unknown> = {}, botId = 'a') => (await client.harnessTool(botId, { name, input, callId: `call-${botId}`, line: LINE })).output as any;
  return { client, a, b, call, store };
}
const executions = () => up.requests.filter((r) => r.url.endsWith('/ExecuteSandMcpTool'));

test('every bot is offered direct app tools even without background harness tools', async () => {
  const { a, b } = await setup();
  for (const v of [a, b]) assert.deepEqual(v.tools.map((t) => t.name), ['list_connected_apps', 'find_app_tools', 'use_app_tool']);
});

test('discovery lists real names and connection states without credentials or schemas', async () => {
  servers.servers[0].url = 'https://private.invalid/?secret=do-not-return';
  const { call } = await setup();
  const out = await call('list_connected_apps');
  assert.deepEqual(out.apps, [{ id: 'user-Mail', name: 'Mail', status: 'connected' }, { id: 'user-Offline', name: 'Offline', status: 'needsAuth' }]);
  assert.doesNotMatch(JSON.stringify(out), /do-not-return|inputSchema|Your profile/);
});

test('find returns the qualified name and actual schema for matching tools, with paging', async () => {
  listed.servers[0].tools = Array.from({ length: 12 }, (_, i) => tool(`profile_${i}`));
  const { call } = await setup();
  const page = await call('find_app_tools', { app: 'mail', query: 'profile' });
  assert.equal(page.tools.length, 10);
  assert.deepEqual(page.tools[0], { name: 'user-Mail-profile_0', description: 'Read profile_0', parameters: { type: 'object', properties: {} } });
  assert.equal(page.nextOffset, 10);
  const end = await call('find_app_tools', { app: 'user-Mail', query: 'profile', offset: 10 });
  assert.equal(end.tools.length, 2);
  assert.equal(end.nextOffset, null);
  assert.equal((await call('find_app_tools', { app: 'Mail', query: 'unknown' })).tools.length, 0);
});

test('find ranks tools by how many query words they match, so a long spoken query still finds them', async () => {
  listed.servers[0].tools = [
    ...Array.from({ length: 10 }, (_, i) => tool(`preview_${i}`)),
    tool('t3_thread_send', { description: 'Send a message to a thread' }),
    tool('t3_thread_launch', { description: 'Start a new thread and send it a prompt' }),
  ];
  const { call } = await setup();
  const out = await call('find_app_tools', { app: 'Mail', query: 'create new chat threads and send prompts Asterix' });
  assert.deepEqual(out.tools.map((t: any) => t.name), ['user-Mail-t3_thread_launch', 'user-Mail-t3_thread_send']);
  assert.equal(out.total, 2);
  assert.equal(out.names, undefined);
  const browse = await call('find_app_tools', { app: 'Mail' });
  assert.equal(browse.tools.length, 10);
  assert.deepEqual(browse.names, listed.servers[0].tools.map((t: any) => t.name));
  const none = await call('find_app_tools', { app: 'Mail', query: 'xyz' });
  assert.equal(none.total, 0);
  assert.equal(none.names.length, 12);
});

test('each bot executes the discovered qualified name and gets its actual result', async () => {
  const { call } = await setup();
  for (const bot of ['a', 'b']) {
    const out = await call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: { detail: true } }, bot);
    assert.deepEqual(out, { success: { content: [{ text: 'Your profile' }] } });
    const req = executions().at(-1)!;
    assert.equal(req.body.agentId, bot);
    assert.equal(req.body.serverIdentifier, 'user-Mail');
    assert.equal(req.body.toolName, 'user-Mail-profile');
    assert.deepEqual(req.body.args, { detail: true });
    assert.match(req.body.toolCallId, /^[0-9a-f-]{36}$/);
    assert.equal(req.headers.authorization, 'Bearer token');
  }
});

test('unknown apps, disconnected apps, stale or invented tools and invalid args never execute', async () => {
  const { call } = await setup();
  for (const input of [
    {}, { app: 'missing' }, { app: 'Offline' }, { app: 'Mail', tool: 'fake', arguments: {} },
    { app: 'Mail', tool: 'user-Mail-profile', arguments: null },
    { app: 'Mail', tool: 'user-Mail-profile', arguments: [] },
  ]) assert.ok((await call('use_app_tool', input)).error);
  assert.equal(executions().length, 0);
});

test('fresh discovery prevents execution after an app is disabled', async () => {
  const { call } = await setup();
  await call('find_app_tools', { app: 'Mail' });
  servers.servers[0].enabled = false;
  assert.match((await call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} })).error, /disabled/i);
  assert.equal(executions().length, 0);
});

test('saved disabled tools and blocked or approval-required permission overrides are respected', async () => {
  const { call } = await setup();
  for (const [field, value] of [['tools', { profile: 'GROK_BOT_TOOL_PERMISSION_BLOCKED' }], ['reads', 'GROK_BOT_TOOL_PERMISSION_NEEDS_APPROVAL']] as const) {
    permissions = { servers: [{ serverId: 'user-Mail', policy: { [field]: value } }] };
    assert.ok((await call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} })).error);
  }
  permissions = {};
  settings = { settings: { servers: [{ serverId: 'user-Mail', disabledTools: ['profile'] }] } };
  assert.ok((await call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} })).error);
  assert.equal(executions().length, 0);
});

test('permissions follow Grok Bot: tool rule, then the reads or writes rule, and the default (auto review) runs without asking', async () => {
  // Grok Bot's effectiveMcpToolPermission: blocked or disabled refuses; else tools[name] ?? reads/writes ?? "auto_review".
  // Its UNSPECIFIED is "auto_review" and is dropped from rules, so it falls through. Unknown values mean needs approval.
  // Grok Bot runs auto review inside its own agent; on the call the default runs without asking (Shashank, 2026-11-11).
  const P = (v: string) => `GROK_BOT_TOOL_PERMISSION_${v}`;
  const read = tool('profile');
  const write = tool('send', { annotationsJson: '{}' });
  const destructive = tool('purge', { annotationsJson: '{"readOnlyHint":true,"destructiveHint":true}' });
  listed.servers[0].tools = [read, write, destructive];
  const { call } = await setup();
  const cases: [string, any, any, 'runs' | 'asks' | 'blocked'][] = [
    ['a write with no rules (the default)', write, undefined, 'runs'],
    ['a read with no rules', read, undefined, 'runs'],
    ['a destructive "read" with no rules', destructive, undefined, 'runs'],
    ['writes always allowed', write, { writes: P('ALWAYS_ALLOW') }, 'runs'],
    ['writes set to unspecified (auto review)', write, { writes: P('UNSPECIFIED') }, 'runs'],
    ['writes need approval', write, { writes: P('NEEDS_APPROVAL') }, 'asks'],
    ['writes blocked', write, { writes: P('BLOCKED') }, 'blocked'],
    ['reads need approval: a read', read, { reads: P('NEEDS_APPROVAL') }, 'asks'],
    ['reads need approval: a write is not a read', write, { reads: P('NEEDS_APPROVAL') }, 'runs'],
    ['writes need approval: a read is not a write', read, { writes: P('NEEDS_APPROVAL') }, 'runs'],
    ['writes need approval: a destructive tool is a write', destructive, { writes: P('NEEDS_APPROVAL'), reads: P('ALWAYS_ALLOW') }, 'asks'],
    ['the tool rule beats a blocking group rule', write, { tools: { send: P('ALWAYS_ALLOW') }, writes: P('BLOCKED') }, 'runs'],
    ['the tool rule beats an allowing group rule', write, { tools: { send: P('BLOCKED') }, writes: P('ALWAYS_ALLOW') }, 'blocked'],
    ['a tool rule by qualified name', write, { tools: { 'user-Mail-send': P('NEEDS_APPROVAL') } }, 'asks'],
    ['an unspecified tool rule falls through to the group rule', write, { tools: { send: P('UNSPECIFIED') }, writes: P('BLOCKED') }, 'blocked'],
    ['a rule for another tool does not apply', write, { tools: { profile: P('BLOCKED') } }, 'runs'],
    ['an unknown value needs review', write, { writes: 'FUTURE_PERMISSION' }, 'asks'],
    ['an unknown tool value needs review', read, { tools: { profile: 'FUTURE_PERMISSION' } }, 'asks'],
  ];
  for (const [what, t, policy, expected] of cases) {
    permissions = policy ? { servers: [{ serverId: 'user-Mail', policy }] } : {};
    const before = executions().length;
    const out = await call('use_app_tool', { app: 'Mail', tool: t.name, arguments: {} });
    assert.equal(executions().length - before, expected === 'runs' ? 1 : 0, what);
    if (expected === 'runs') assert.ok(out.success, what);
    if (expected === 'asks') assert.deepEqual([out.needsApproval, /needs approval/.test(out.error)], [true, true], what);
    if (expected === 'blocked') assert.deepEqual([out.needsApproval, /blocked/.test(out.error)], [undefined, true], what);
  }
  // Rules for another app never apply, and a disabled tool stays off even when always allowed.
  permissions = { servers: [{ serverId: 'user-Other', policy: { writes: P('BLOCKED') } }] };
  assert.ok((await call('use_app_tool', { app: 'Mail', tool: write.name, arguments: {} })).success);
  permissions = { servers: [{ serverId: 'user-Mail', disabledTools: ['send'], policy: { tools: { send: P('ALWAYS_ALLOW') } } }] };
  const before = executions().length;
  assert.match((await call('use_app_tool', { app: 'Mail', tool: write.name, arguments: {} })).error, /disabled/);
  assert.equal(executions().length, before);
});

test('backend result refusals are returned intact and unusable results are errors', async () => {
  const { call } = await setup();
  for (const refusal of [{ error: { error: 'Sign in again', needsAuth: true } }, { permissionDenied: { reason: 'Denied' } }, { rejected: {} }, { success: { isError: true, content: [{ text: 'Upstream failed' }] } }]) {
    result = { result: refusal };
    assert.deepEqual(await call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} }), refusal);
  }
  for (const malformed of [{}, { result: [] }, { result: {} }, { result: 'invalid' }]) {
    result = malformed;
    await assert.rejects(call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} }), /unusable/i);
  }
});

test('tool HTTP failures and timeouts are surfaced without automatically retrying', async () => {
  const { call } = await setup(50);
  executeStatus = 503;
  result = { message: 'Unavailable' };
  await assert.rejects(call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} }), /Unavailable/);
  executeStatus = 200;
  delay = 300;
  await assert.rejects(call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} }), /did not answer/);
  assert.equal(executions().length, 2);
});

test('malformed tool schemas never reach execution', async () => {
  const { call } = await setup();
  for (const schema of ['{bad', 'null', '[]', '"not a schema"', undefined]) {
    listed.servers[0].tools = [tool('profile', { inputSchemaJson: schema })];
    await assert.rejects(call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} }), /schema/i);
    assert.deepEqual((await call('find_app_tools', { app: 'Mail' })).tools, []);
  }
  assert.equal(executions().length, 0);
});

test('empty, malformed and incomplete discovery responses are distinguished', async () => {
  const { call } = await setup();
  servers = {}; listed = {};
  assert.deepEqual(await call('list_connected_apps'), { apps: [] });
  for (const bad of [null, [], { servers: true }]) {
    servers = bad;
    await assert.rejects(call('list_connected_apps'), /unusable app list/);
  }
  for (const bad of [{ name: 'Missing id' }, { serverIdentifier: 'id' }, null]) {
    servers = { servers: [bad] };
    assert.deepEqual((await call('list_connected_apps')).apps, []);
  }
  servers = { servers: [{ name: 'Local', serverIdentifier: 'local-id', enabled: true }] };
  assert.deepEqual((await call('list_connected_apps')).apps, [{ id: 'local-id', name: 'Local', status: 'unavailable' }]);
  assert.match((await call('find_app_tools', { app: 'Local' })).error, /unavailable/);
});

test('multiple accounts require an exact id and execute only the selected account', async () => {
  servers.servers = [{ name: 'Mail', serverIdentifier: 'user-Mail', enabled: true, type: 'HTTP', id: 12, accounts: ['work', 'personal'].map((label) => ({ accountKey: label, serverIdentifier: `user-Mail-${label}`, userHasAccessToken: true })) }];
  listed.servers = ['work', 'personal'].map((accountLabel) => ({ serverIdentifier: 'user-Mail', rowServerIdentifier: `user-Mail-${accountLabel}`, accountLabel, status: 'connected', tools: [tool()] }));
  const { call } = await setup();
  assert.equal((await call('list_connected_apps')).apps.length, 2);
  assert.ok((await call('find_app_tools', { app: 'Mail' })).error);
  await call('use_app_tool', { app: 'user-Mail-work', tool: 'user-Mail-profile', arguments: {} });
  assert.equal(executions().at(-1)!.body.serverIdentifier, 'user-Mail-work');
  permissions = { servers: [{ serverId: '12', disabledTools: ['user-Mail-profile'] }] };
  assert.match((await call('use_app_tool', { app: 'user-Mail-work', tool: 'user-Mail-profile', arguments: {} })).error, /disabled/);
  assert.equal(executions().length, 1);
  permissions = { servers: [{ serverId: 'user-Mail', policy: { reads: 'GROK_BOT_TOOL_PERMISSION_BLOCKED' } }] };
  assert.match((await call('use_app_tool', { app: 'user-Mail-work', tool: 'user-Mail-profile', arguments: {} })).error, /blocked/);
  assert.equal(executions().length, 1);
});

test('pagination rejects invalid offsets and can browse past the end without repeating tools', async () => {
  const { call } = await setup();
  for (const offset of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) assert.match((await call('find_app_tools', { app: 'Mail', offset })).error, /whole number/);
  const out = await call('find_app_tools', { app: 'Mail', offset: 100 });
  assert.deepEqual(out.tools, []);
  assert.equal(out.nextOffset, null);
  listed.servers[0].tools = [tool('profile_11'), tool('profile_12')];
  const fresh = await setup(); // a search may reuse the app's tool list for a minute, so a new client sees the change
  assert.equal((await fresh.call('find_app_tools', { app: 'Mail', query: 'profile_11' })).tools.length, 1);
});

test('object schemas, missing descriptions and unknown annotations remain usable, and unreadable annotations count as writes', async () => {
  const { call } = await setup();
  listed.servers[0].tools = [tool('profile', { inputSchema: { type: 'object' }, description: undefined, annotationsJson: '{bad' })];
  assert.deepEqual((await call('find_app_tools', { app: 'Mail' })).tools[0].parameters, { type: 'object' });
  assert.equal((await call('find_app_tools', { app: 'Mail' })).tools[0].description, '');
  permissions = { servers: [{ serverId: 'user-Mail', policy: { reads: 'GROK_BOT_TOOL_PERMISSION_ALWAYS_ALLOW', writes: 'GROK_BOT_TOOL_PERMISSION_NEEDS_APPROVAL' } }] };
  assert.equal((await call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} })).needsApproval, true);
  permissions = { servers: [{ serverId: 'user-Mail', policy: { tools: { 'user-Mail-profile': 'GROK_BOT_TOOL_PERMISSION_ALWAYS_ALLOW' } } }] };
  assert.ok((await call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} })).success);
});

test('missing tools and annotations do not invent capabilities', async () => {
  const { call } = await setup();
  listed.servers[0].tools = undefined;
  assert.deepEqual((await call('find_app_tools', { app: 'Mail' })).tools, []);
  assert.ok((await call('use_app_tool', { app: 'Mail', tool: 'invented', arguments: {} })).error);
  listed.servers[0].tools = [tool('profile', { annotationsJson: undefined })];
  permissions = { servers: [{ serverId: 'user-Mail', policy: { reads: 'GROK_BOT_TOOL_PERMISSION_ALWAYS_ALLOW', writes: 'GROK_BOT_TOOL_PERMISSION_NEEDS_APPROVAL' } }] };
  assert.equal((await call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} })).needsApproval, true, 'no annotations: a write');
  assert.equal(executions().length, 0);
});


test('a call bot receives the HTTP app result before speaking and shares its reply with the other bot', async () => {
  const { client } = await setup();
  const sockets = new Map<string, FakeSocket>();
  const call = new OverlayCall({
    mintVoice: (id: string) => client.voiceSession(id),
    callTool: (id: string, request: any) => client.harnessTool(id, request),
    openSocket: (url: string, _protocols: string[], id: string) => {
      const socket = new FakeSocket(url);
      sockets.set(id, socket);
      return socket;
    },
    audio: new FakeAudio(),
    setTimer: () => 1,
    clearTimer: () => {},
    now: () => 0,
  });
  call.joinWith([bot('a'), bot('b')], [], null);
  await until(() => sockets.size === 2);
  for (const socket of sockets.values()) { socket.onopen!(); socket.emit('session.updated'); }
  const a = sockets.get('a')!, b = sockets.get('b')!;
  reply(a, '', [['use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} }]]);
  assert.equal(a.outputs().length, 0, 'no invented result while the HTTP request is pending');
  assert.equal(call.links.get('a').toolsBusy, true);
  await until(() => a.outputs().length === 1);
  assert.deepEqual(JSON.parse(a.outputs()[0]), { success: { content: [{ text: 'Your profile' }] } });
  assert.equal(a.sent.at(-1).type, 'response.create', 'the bot gets to speak with the real result');
  assert.equal(b.sent.filter((x) => x.type === 'response.create').length, 0, 'the other bot waits');
  reply(a, 'The app returned your profile successfully.');
  assert.ok(b.said().includes('[Bot A]: The app returned your profile successfully.'));
  assert.equal(executions().length, 1);
  call.leave();
});


test('parallel app discovery refreshes an expired sign-in once and retries the same Dashboard endpoints', async () => {
  const { call } = await setup();
  const start = up.requests.length; // joining loaded the app list too
  token = 'renewed';
  const [out] = await Promise.all([call('list_connected_apps'), call('list_connected_apps')]);
  assert.equal(out.apps[0].name, 'Mail');
  assert.equal(up.requests.filter((r) => r.url === '/oauth/token').length, 1);
  for (const method of ['GetAvailableMcpServers']) {
    const requests = up.requests.slice(start).filter((r) => r.url.endsWith('/' + method));
    assert.equal(requests.length, 4);
    assert.equal(requests[2].url, `/aiserver.v1.DashboardService/${method}`);
    assert.equal(requests[2].headers.authorization, 'Bearer renewed');
  }
});


test('a late 401 reuses the refreshed token instead of rotating credentials again', async () => {
  const { call } = await setup();
  token = 'renewed'; late401 = true;
  const out = await Promise.all([call('list_connected_apps'), call('list_connected_apps')]);
  assert.equal(out[0].apps[0].name, 'Mail');
  assert.equal(up.requests.filter((r) => r.url === '/oauth/token').length, 1);
});


test('signing out during discovery cannot be undone by a token refresh', async () => {
  const { call, store } = await setup();
  token = 'renewed'; on401 = () => store.clear();
  await assert.rejects(call('list_connected_apps'), /Signed out/);
  assert.equal(up.requests.filter((r) => r.url === '/oauth/token').length, 0);
  assert.equal(store.read(), null);
});

test('unknown saved permission values require review instead of silently granting access', async () => {
  const { call } = await setup();
  permissions = { servers: [{ serverId: 'user-Mail', policy: { reads: 'FUTURE_PERMISSION' } }] };
  assert.equal((await call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} })).needsApproval, true);
  assert.equal(executions().length, 0);
  permissions.servers[0].policy.reads = 'GROK_BOT_TOOL_PERMISSION_UNSPECIFIED';
  assert.ok((await call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} })).success);
});

test('listing apps does not wait for connector tool catalogs, and finding tools only loads the selected app', async () => {
  const { call } = await setup();
  await call('list_connected_apps');
  assert.equal(up.requests.filter((r) => r.url.endsWith('/ListSandMcpTools')).length, 0);
  await call('find_app_tools', { app: 'Mail' });
  assert.deepEqual(up.requests.filter((r) => r.url.endsWith('/ListSandMcpTools')).at(-1)!.body, { serverIdentifiers: ['user-Mail'] });
});

test('public and static-credential connectors do not require OAuth, but missing tool discovery is reported', async () => {
  const { call } = await setup();
  delete servers.servers[0].userHasAccessToken;
  assert.equal((await call('list_connected_apps')).apps[0].status, 'available');
  listed = {};
  assert.match((await call('find_app_tools', { app: 'Mail' })).error, /unavailable/);
  servers.servers[0].hasStaticCredentialHeaders = true;
  servers.servers[0].userHasAccessToken = false;
  assert.equal((await call('list_connected_apps')).apps[0].status, 'connected');
});

/** A fake Grok for ConnectedApps alone: answers after a tick, counts requests in flight, and has a settable clock. */
function fakeGrok(answer: (method: string, body: any) => unknown = () => undefined) {
  const f = {
    now: 0, inflight: 0, max: 0, log: [] as string[],
    servers: [{ name: 'Mail', serverIdentifier: 'user-Mail', type: 'HTTP', userHasAccessToken: true }] as any[],
    rowStatus: 'connected',
    rpc: (_service: string, method: string, body: any): Promise<any> => {
      f.inflight++;
      f.max = Math.max(f.max, f.inflight);
      f.log.push(method + (body.serverIdentifiers ? `:${body.serverIdentifiers[0]}` : ''));
      return new Promise((resolve, reject) => setTimeout(() => {
        f.inflight--;
        const custom = answer(method, body);
        if (custom instanceof Error) return reject(custom);
        if (custom !== undefined) return resolve(custom);
        if (method === 'GetAvailableMcpServers') return resolve({ servers: f.servers });
        if (method === 'ListSandMcpTools') return resolve({ servers: [{ serverIdentifier: body.serverIdentifiers[0], status: f.rowStatus, tools: [tool('profile'), tool('send', { annotationsJson: '{}' })] }] });
        if (method === 'ExecuteSandMcpTool') return resolve({ result: { success: { ran: body.serverIdentifier } } });
        resolve({});
      }, 2));
    },
  };
  return f;
}

test('an app action loads the app list, its tool list and the permission rules at the same time, and still checks all of them', async () => {
  // Measured live 2026-11-11: one after another these took 2.3-4.6 s per action, of which the action itself was ~1.2 s.
  const f = fakeGrok();
  const apps = new ConnectedApps(f.rpc, () => f.now);
  await apps.call('a', 'list_connected_apps', {});
  f.max = 0;
  f.log = [];
  assert.deepEqual(await apps.call('a', 'use_app_tool', { app: 'Mail', tool: 'user-Mail-send', arguments: {} }), { success: { ran: 'user-Mail' } });
  assert.equal(f.max, 4, 'app list, tool list, permissions and settings all in flight together');
  assert.deepEqual(f.log.slice(0, 4).sort(), ['GetAvailableMcpServers', 'GetGrokBotMcpToolPermissions', 'GetGrokBotUserMcpSettings', 'ListSandMcpTools:user-Mail']);
  assert.equal(f.log[4], 'ExecuteSandMcpTool', 'the action runs only after every check is in');
  // A rule that arrived with the others still stops the action.
  const blocked = fakeGrok((m) => (m === 'GetGrokBotMcpToolPermissions' ? { servers: [{ serverId: 'user-Mail', policy: { writes: 'GROK_BOT_TOOL_PERMISSION_BLOCKED' } }] } : undefined));
  const b = new ConnectedApps(blocked.rpc);
  await b.call('a', 'list_connected_apps', {});
  assert.match((await b.call('a', 'use_app_tool', { app: 'user-Mail', tool: 'user-Mail-send', arguments: {} }) as any).error, /blocked/);
  assert.ok(!blocked.log.includes('ExecuteSandMcpTool'));
});

test('the first action, before any app list, still loads the permission rules alongside discovery', async () => {
  const f = fakeGrok();
  const apps = new ConnectedApps(f.rpc);
  assert.ok(await apps.call('a', 'use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} }));
  assert.equal(f.max, 3, 'app list and both permission reads together; the tool list waits for the app id');
  assert.deepEqual(f.log.slice(3), ['ListSandMcpTools:user-Mail', 'ExecuteSandMcpTool']);
});

test('a wrong guess about the app is caught by the fresh app list, and its failed early load is ignored', async () => {
  const f = fakeGrok((m, body) => (m === 'ListSandMcpTools' && body.serverIdentifiers[0] === 'user-Mail' ? new Error('gone') : undefined));
  const apps = new ConnectedApps(f.rpc);
  await apps.call('a', 'list_connected_apps', {});
  f.servers = [{ name: 'Mail', serverIdentifier: 'user-Mail2', type: 'HTTP', userHasAccessToken: true }]; // reconnected under a new id
  const out = await apps.call('a', 'use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} });
  assert.deepEqual(out, { success: { ran: 'user-Mail2' } });
  assert.ok(f.log.includes('ListSandMcpTools:user-Mail') && f.log.includes('ListSandMcpTools:user-Mail2'));
  await new Promise((r) => setTimeout(r, 20)); // an unhandled rejection would fail this file
});

test('a failed tool list for the right app is an error, and failed permission reads are ignored only when the tool was refused first', async () => {
  const listFails = fakeGrok((m) => (m === 'ListSandMcpTools' ? new Error('Grok Bot ListSandMcpTools failed (HTTP 500)') : undefined));
  const a = new ConnectedApps(listFails.rpc);
  await a.call('a', 'list_connected_apps', {});
  await assert.rejects(a.call('a', 'use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} }), /HTTP 500/);
  await assert.rejects(a.call('a', 'find_app_tools', { app: 'Mail' }), /HTTP 500/);
  const rulesFail = fakeGrok((m) => (m === 'GetGrokBotUserMcpSettings' ? new Error('Grok Bot GetGrokBotUserMcpSettings failed (HTTP 503)') : undefined));
  const b = new ConnectedApps(rulesFail.rpc);
  assert.match((await b.call('a', 'use_app_tool', { app: 'Mail', tool: 'invented', arguments: {} }) as any).error, /not available/);
  assert.match((await b.call('a', 'use_app_tool', { app: 'Nope', tool: 'x', arguments: {} }) as any).error, /exact app id/);
  await assert.rejects(b.call('a', 'use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} }), /HTTP 503/);
  assert.ok(!rulesFail.log.includes('ExecuteSandMcpTool'));
  const listFailsToo = fakeGrok((m) => (m === 'GetAvailableMcpServers' ? new Error('down') : m === 'GetGrokBotMcpToolPermissions' ? new Error('down too') : undefined));
  await assert.rejects(new ConnectedApps(listFailsToo.rpc).call('a', 'use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} }), /^Error: down$/);
  await new Promise((r) => setTimeout(r, 20));
});

test('a tool search reuses a connected app\'s tool list for a minute; an action always loads it fresh', async () => {
  const f = fakeGrok();
  const apps = new ConnectedApps(f.rpc, () => f.now);
  const lists = () => f.log.filter((l) => l.startsWith('ListSandMcpTools')).length;
  await apps.call('a', 'find_app_tools', { app: 'Mail' });
  assert.equal(lists(), 1);
  f.now = TOOL_LIST_REUSE_MS - 1;
  assert.equal((await apps.call('a', 'find_app_tools', { app: 'mail', query: 'send' }) as any).tools[0].name, 'user-Mail-send');
  assert.equal(lists(), 1, 'reused, by name or id');
  await apps.call('a', 'use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} });
  assert.equal(lists(), 2, 'an action loads it fresh');
  f.now = 2 * TOOL_LIST_REUSE_MS - 2; // the action refreshed it at REUSE - 1
  await apps.call('a', 'find_app_tools', { app: 'user-Mail' });
  assert.equal(lists(), 2);
  f.now = 3 * TOOL_LIST_REUSE_MS;
  await apps.call('a', 'find_app_tools', { app: 'Mail' });
  assert.equal(lists(), 3, 'a minute old: loaded again');
  // An app that needed sign-in is checked again on every search, so signing in mid-call shows at once.
  f.rowStatus = 'needsAuth';
  f.now = 5 * TOOL_LIST_REUSE_MS;
  assert.match((await apps.call('a', 'find_app_tools', { app: 'Mail' }) as any).error, /needsAuth/);
  f.rowStatus = 'connected';
  assert.equal((await apps.call('a', 'find_app_tools', { app: 'Mail' }) as any).total, 2, 'signed in again: seen on the next search');
  // A disabled app is refused even with a fresh tool list in hand: the app list is always loaded.
  f.servers[0].enabled = false;
  assert.match((await apps.call('a', 'find_app_tools', { app: 'Mail' }) as any).error, /disabled/);
});

test('two apps with the same name are never guessed by name', async () => {
  const f = fakeGrok();
  f.servers = ['work', 'home'].map((k) => ({ name: 'Mail', serverIdentifier: `user-Mail-${k}`, type: 'HTTP', userHasAccessToken: true }));
  const apps = new ConnectedApps(f.rpc);
  await apps.call('a', 'list_connected_apps', {});
  f.log = [];
  assert.match((await apps.call('a', 'find_app_tools', { app: 'Mail' }) as any).error, /exact app id/);
  assert.deepEqual(f.log, ['GetAvailableMcpServers'], 'no tool list loaded on a guess');
  assert.equal((await apps.call('a', 'find_app_tools', { app: 'user-Mail-home' }) as any).app, 'user-Mail-home');
});


test('invalid connector arguments execute zero times, valid nested arguments execute once', async () => {
  const { call } = await setup();
  listed.servers[0].tools = [tool('profile', { inputSchemaJson: JSON.stringify({ type: 'object', required: ['to'], additionalProperties: false, properties: { to: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1 }, nested: { type: 'array', items: { type: 'string' } } } }) })];
  for (const args of [{}, { to: '' }, { to: 1 }, { to: 'a', count: 0 }, { to: 'a', extra: true }, { to: 'a', nested: [1] }]) {
    const before = executions().length;
    assert.match((await call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: args })).error, /arguments/);
    assert.equal(executions().length, before);
  }
  assert.ok((await call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: { to: 'a', count: 1, nested: ['ok'] } })).success);
  assert.equal(executions().length, 1);
});

test('one malformed connector or tool leaves the others usable', async () => {
  const { call } = await setup();
  servers.servers.unshift(null, { name: 'broken' });
  listed.servers[0].tools.unshift(null, { name: 'bad', inputSchemaJson: '{' });
  assert.equal((await call('list_connected_apps')).apps.length, 2);
  const found = await call('find_app_tools', { app: 'Mail' });
  assert.equal(found.tools.length, 1);
  assert.ok((await call('use_app_tool', { app: 'Mail', tool: 'user-Mail-profile', arguments: {} })).success);
});
