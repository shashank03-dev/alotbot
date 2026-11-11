import { APP_TOOLS } from '../src/apps.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { AuthStore } from '../src/auth.ts';
import { ActionStore } from '../src/actions.ts';
import { JobWatcher } from '../src/jobs.ts';
import {
  APPS_GRACE_MS,
  LANDED_SCAN,
  LANDED_TEXT_MAX,
  landedText,
  APPS_REMEMBERED_MS,
  CLIENT_ID,
  spokenLanguage,
  CLIENT_VERSION,
  checksum,
  clientHeaders,
  errorDetail,
  GrokBotClient,
  harnessTools,
  NotFoundError,
  SignedOutError,
  ToolRefusedError,
} from '../src/grokbot.ts';
import { deadUrl, mock, sendJson, type Mock } from './helpers.ts';

const SEND_TASK = { type: 'function', name: 'send_task', description: 'Send a job.', parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] } };
const HANG_UP = { type: 'function', name: 'end_the_call', description: 'Hang up.', parameters: { type: 'object', properties: {} } };
const LINE = { theyJustTalked: true, newsOwed: false, receiptOwed: false, alreadySpokeThisTurn: false };

/** The checksum function exactly as it ships in the Grok Bot app (main-app.cjs). */
function appChecksum(machineId: string, now: number): string {
  const xor = (e: Uint8Array) => {
    let t = 165;
    for (let n = 0; n < e.length; n++) (e[n] = (e[n] ^ t) + (n % 256)), (t = e[n]);
    return e;
  };
  const t = Math.floor(now / 1e6);
  const n = new Uint8Array([(t >> 40) & 255, (t >> 32) & 255, (t >> 24) & 255, (t >> 16) & 255, (t >> 8) & 255, t & 255]);
  return `${Buffer.from(xor(n)).toString('base64url')}${machineId}`;
}

test('checksum matches the Grok Bot app byte for byte', () => {
  for (const now of [0, 1_794_298_588_000, 1_700_000_000_000, 4_102_444_800_000]) {
    assert.equal(checksum('mid', now), appChecksum('mid', now));
  }
  assert.ok(checksum('abc').endsWith('abc'));
});

test('clientHeaders identify as the Grok Bot desktop client', () => {
  const h = clientHeaders({ accessToken: 'tok', refreshToken: null, machineId: 'mid' }, 1_794_298_588_000);
  assert.equal(h.authorization, 'Bearer tok');
  assert.equal(h['x-cursor-client-type'], 'sand');
  assert.equal(h['x-cursor-client-version'], CLIENT_VERSION);
  assert.equal(h['x-cursor-client-source'], 'sand-desktop');
  assert.equal(h['x-cursor-checksum'], appChecksum('mid', 1_794_298_588_000));
  assert.equal(h['connect-protocol-version'], '1');
  assert.match(h['x-request-id'], /^[0-9a-f-]{36}$/);
});

test('errorDetail pulls the readable reason out of Connect errors', () => {
  const debug = (d: object) => JSON.stringify({ code: 'x', message: 'Error', details: [{ debug: d }] });
  assert.equal(errorDetail(401, debug({ error: 'ERROR_NOT_LOGGED_IN', details: { detail: 'Please log in' } })), 'HTTP 401: Please log in');
  assert.equal(errorDetail(403, debug({ error: 'ERROR_USAGE_LIMIT' })), 'HTTP 403: ERROR_USAGE_LIMIT');
  assert.equal(errorDetail(500, JSON.stringify({ message: 'boom' })), 'HTTP 500: boom');
  assert.equal(errorDetail(500, '{"other":1}'), 'HTTP 500: {"other":1}');
  assert.equal(errorDetail(502, ' bad gateway '), 'HTTP 502: bad gateway');
  assert.equal(errorDetail(504, ''), 'HTTP 504');
  assert.equal(errorDetail(500, 'x'.repeat(400)).length, 'HTTP 500: '.length + 300);
});

// ---------- client against a fake Grok Bot backend ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-call-gb-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let dirN = 0;

const AGENTS = [
  { id: '1', name: 'My Bot', kind: 'GROK_BOT_AGENT_KIND_AGENT', voiceId: '', voiceSpeed: 1, voiceLanguage: 'auto', avatarColor: 'black', avatarShape: 'blob' },
  { id: '2', name: "Shashank's Bot", kind: 'GROK_BOT_AGENT_KIND_AGENT', voiceId: 'carina', voiceSpeed: 1.2, voiceLanguage: 'en', avatarColor: 'violet', avatarShape: 'cloud' },
  { id: '3', name: 'No extras', kind: 'GROK_BOT_AGENT_KIND_AGENT', voiceSpeed: 0 },
  { id: '4', name: 'A group chat', kind: 'GROK_BOT_AGENT_KIND_GROUP' },
  { id: '', name: 'No id', kind: 'GROK_BOT_AGENT_KIND_AGENT' },
  { id: '6', kind: 'GROK_BOT_AGENT_KIND_AGENT' },
  null,
];

type Behavior = {
  token: string; // the access token the backend accepts
  agents: unknown;
  refresh: (body: any) => [number, unknown];
  mint: unknown;
  harness: unknown;
  tool: (body: any) => [number, unknown];
  toolDelayMs: number;
  apps: unknown; // GetAvailableMcpServers answer; null fails it
  appsDelayMs: number;
  harnessDelayMs: number;
  transcript: unknown; // ListGrokBotTranscriptEntries answer
  fail?: [number, string];
};
let up: Mock;
let b: Behavior;
let extras: Record<string, unknown> = {};

beforeEach(async () => {
  await up?.close();
  extras = {};
  b = {
    token: 'good',
    agents: { agents: AGENTS },
    refresh: () => [200, { access_token: 'good', refresh_token: 'ref2' }],
    mint: { clientSecret: 'sec', expiresAtUnixSeconds: '1794298888', model: 'grok-voice-3.0', websocketUrl: 'wss://voice.test/v1/realtime?enable_async_updates=true' },
    harness: { instructions: 'Be My Bot.', tools: [SEND_TASK, HANG_UP] },
    tool: (_body: any): [number, unknown] => [200, { kind: 'VOICE_CALL_HARNESS_TOOL_OUTCOME_KIND_SERVED', output: { receipt: 'under way' } }],
    toolDelayMs: 0,
    apps: { servers: [{ name: 'Mail', serverIdentifier: 'user-Mail', type: 'HTTP', userHasAccessToken: true }] },
    appsDelayMs: 0,
    harnessDelayMs: 0,
    transcript: { entries: [] },
  };
  up = await mock((req, res) => {
    if (req.url === '/oauth/token') {
      const [s, body] = b.refresh(req.body);
      return sendJson(res, s, body);
    }
    if (req.headers.authorization !== `Bearer ${b.token}`) {
      return sendJson(res, 401, { code: 'unauthenticated', details: [{ debug: { error: 'ERROR_NOT_LOGGED_IN' } }] });
    }
    if (b.fail) return sendJson(res, b.fail[0], b.fail[1]);
    const method = req.url.split('/').pop();
    if (method && method in extras) return sendJson(res, 200, extras[method]);
    if (method === 'ListGrokBotAgents') return sendJson(res, 200, b.agents);
    if (method === 'VoiceCallHarnessSession') return void setTimeout(() => sendJson(res, 200, b.harness), b.harnessDelayMs);
    if (method === 'MintSandVoiceCallSecret') return sendJson(res, 200, b.mint);
    if (method === 'ListGrokBotTranscriptEntries') return sendJson(res, 200, typeof b.transcript === 'function' ? (b.transcript as any)(req.body) : b.transcript);
    if (method === 'GetAvailableMcpServers') return void setTimeout(() => sendJson(res, b.apps ? 200 : 500, b.apps ?? {}), b.appsDelayMs);
    if (method === 'VoiceCallHarnessTool') {
      const [s, body] = b.tool(req.body);
      return void setTimeout(() => sendJson(res, s, body), b.toolDelayMs);
    }
    sendJson(res, 404, {});
  });
});
after(() => up.close());

function client(auth: object | null = { accessToken: 'good', refreshToken: 'ref', machineId: 'mid' }) {
  const store = new AuthStore(path.join(tmp, `d${dirN++}`));
  if (auth) store.write(auth as any);
  return { store, grok: new GrokBotClient({ store, apiUrl: up.url }) };
}

test('listBots returns only your bots, with voice and avatar', async () => {
  const { grok } = client();
  assert.deepEqual(await grok.listBots(), [
    { id: '1', name: 'My Bot', voice: null, speed: 1, language: null, color: 'black', shape: 'blob' },
    { id: '2', name: "Shashank's Bot", voice: 'carina', speed: 1.2, language: 'en', color: 'violet', shape: 'cloud' },
    { id: '3', name: 'No extras', voice: null, speed: 1, language: null, color: null, shape: null },
  ]);
  const req = up.requests.at(-1)!;
  assert.equal(req.url, '/aiserver.v1.GrokBotService/ListGrokBotAgents');
  assert.deepEqual(req.body, {});
  assert.equal(req.headers['x-cursor-client-type'], 'sand');
});

test('listBots handles a response with no agents list', async () => {
  b.agents = {};
  assert.deepEqual(await client().grok.listBots(), []);
});

test('no sign-in: SignedOutError without calling the backend', async () => {
  await assert.rejects(client(null).grok.listBots(), SignedOutError);
  assert.equal(up.requests.length, 0);
});

test('expired token: refreshes, saves the new tokens, and retries', async () => {
  const { store, grok } = client({ accessToken: 'old', refreshToken: 'ref', machineId: 'mid' });
  assert.equal((await grok.listBots()).length, 3);
  const refresh = up.requests.find((r) => r.url === '/oauth/token')!;
  assert.deepEqual(refresh.body, { client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'ref' });
  assert.deepEqual(store.read(), { accessToken: 'good', refreshToken: 'ref2', machineId: 'mid' });
});

test('refresh without a new refresh token keeps the old one', async () => {
  b.refresh = () => [200, { access_token: 'good' }];
  const { store, grok } = client({ accessToken: 'old', refreshToken: 'ref', machineId: 'mid' });
  await grok.listBots();
  assert.equal(store.read()!.refreshToken, 'ref');
});

test('signed out for good: clears the sign-in in every failure path', async () => {
  const cases: [string, () => void, object][] = [
    ['no refresh token', () => {}, { accessToken: 'old', refreshToken: null, machineId: 'm' }],
    ['refresh rejected', () => (b.refresh = () => [400, { error: 'invalid_grant' }]), { accessToken: 'old', refreshToken: 'r', machineId: 'm' }],
    ['account says log out', () => (b.refresh = () => [200, { access_token: 'good', shouldLogout: true }]), { accessToken: 'old', refreshToken: 'r', machineId: 'm' }],
    ['refresh not JSON', () => (b.refresh = () => [200, 'nope']), { accessToken: 'old', refreshToken: 'r', machineId: 'm' }],
    ['new token still refused', () => (b.refresh = () => [200, { access_token: 'still-bad' }]), { accessToken: 'old', refreshToken: 'r', machineId: 'm' }],
  ];
  for (const [label, arrange, auth] of cases) {
    arrange();
    const { store, grok } = client(auth);
    await assert.rejects(grok.listBots(), SignedOutError, label);
    assert.equal(store.read(), null, label);
  }
});

test('refresh network failure counts as signed out', async () => {
  const store = new AuthStore(path.join(tmp, `d${dirN++}`));
  store.write({ accessToken: 'old', refreshToken: 'r', machineId: 'm' });
  const dead = await deadUrl();
  // First call reaches a backend that says 401, the refresh call hits a dead port.
  const grok = new GrokBotClient({
    store,
    apiUrl: up.url,
    fetch: (url, init) => fetch(String(url).endsWith('/oauth/token') ? `${dead}/oauth/token` : url, init),
  });
  await assert.rejects(grok.listBots(), SignedOutError);
});

test('backend errors carry the reason', async () => {
  b.fail = [403, JSON.stringify({ details: [{ debug: { error: 'ERROR_USAGE', details: { detail: 'Included usage used up' } } }] })];
  await assert.rejects(client().grok.listBots(), /ListGrokBotAgents failed \(HTTP 403: Included usage used up\)/);
  b.fail = [200, 'not json'];
  await assert.rejects(client().grok.listBots(), /ListGrokBotAgents returned invalid JSON/);
});

test('voiceSession: bot instructions plus a realtime socket secret', async () => {
  const { grok } = client();
  const v = await grok.voiceSession('2'); // not cached yet: lists bots first
  assert.deepEqual(v, {
    clientSecret: 'sec',
    url: 'wss://voice.test/v1/realtime?enable_async_updates=true&model=grok-voice-3.0',
    expiresAt: 1794298888,
    instructions: 'Be My Bot.',
    tools: [SEND_TASK, ...APP_TOOLS],
    apps: [{ id: 'user-Mail', name: 'Mail', status: 'connected' }],
    greeting: null, receipt: null, skills: [], routines: [], computers: [],
  });
  const harness = up.requests.find((r) => r.url.endsWith('/VoiceCallHarnessSession'))!;
  assert.deepEqual(harness.body, { agentId: '2', agentName: "Shashank's Bot", userName: 'Shashank', spokenLanguage: 'English', hasSpeedSetting: true });
  assert.deepEqual(up.requests.find((r) => r.url.endsWith('/MintSandVoiceCallSecret'))!.body, {});
  const lists = up.requests.filter((r) => r.url.endsWith('/ListGrokBotAgents')).length;
  await grok.voiceSession('2'); // cached now
  assert.equal(up.requests.filter((r) => r.url.endsWith('/ListGrokBotAgents')).length, lists);
});

test('voiceSession: unknown bot is NotFoundError', async () => {
  await assert.rejects(client().grok.voiceSession('999'), NotFoundError);
});

test('voiceSession: tolerates missing harness text and expiry', async () => {
  b.harness = {};
  b.mint = { ...(b.mint as object), expiresAtUnixSeconds: undefined };
  const v = await client().grok.voiceSession('1');
  assert.equal(v.instructions, '');
  assert.equal(v.expiresAt, 0);
  assert.deepEqual(v.tools, APP_TOOLS);
});

test('voiceSession: refuses an unusable socket secret', async () => {
  const good = b.mint as Record<string, unknown>;
  for (const mint of [
    { ...good, clientSecret: '' },
    { ...good, model: '' },
    { ...good, websocketUrl: 'ws://insecure.test/' },
    { ...good, websocketUrl: 'not a url' },
    null,
  ]) {
    b.mint = mint;
    await assert.rejects(client().grok.voiceSession('1'), /unusable voice session/);
  }
});

test('defaults: real Grok Bot API and global fetch', () => {
  const grok = new GrokBotClient({ store: new AuthStore(path.join(tmp, 'unused')) });
  assert.ok(grok instanceof GrokBotClient);
});

test('harnessTools keeps well-formed function tools and drops hang-up', () => {
  const ok = { type: 'function', name: 'search_conversations', description: 'd', parameters: { type: 'object' } };
  assert.deepEqual(harnessTools(null), []);
  assert.deepEqual(harnessTools({}), []);
  assert.deepEqual(
    harnessTools([
      ok,
      null,
      HANG_UP,
      { ...ok, type: 'mcp' },
      { ...ok, name: '' },
      { ...ok, description: 3 },
      { ...ok, parameters: null },
      { ...ok, parameters: 'x' },
      { ...ok, parameters: [] },
      { ...ok, extra: 'dropped' },
    ]),
    [ok, ok],
  );
});

test('harnessTool forwards a call tool to Grok Bot and maps the outcome', async () => {
  const { grok } = client();
  await grok.voiceSession('1');
  const call = { callId: 'c-1', name: 'send_task', input: { request: 'check mail' }, line: LINE };
  assert.deepEqual(await grok.harnessTool('1', call), { kind: 'served', output: { receipt: 'under way' } });
  assert.deepEqual(up.requests.at(-1)!.body, { agentId: '1', ...call });
  b.tool = () => [200, { kind: 'VOICE_CALL_HARNESS_TOOL_OUTCOME_KIND_INVALID_INPUT', output: { error: 'missing request' } }];
  assert.deepEqual(await grok.harnessTool('1', call), { kind: 'invalid_input', output: { error: 'missing request' } });
  b.tool = () => [200, { kind: 'VOICE_CALL_HARNESS_TOOL_OUTCOME_KIND_UNKNOWN_TOOL' }];
  assert.deepEqual(await grok.harnessTool('1', call), { kind: 'unknown_tool', output: null });
  b.tool = () => [200, { kind: 'VOICE_CALL_HARNESS_TOOL_OUTCOME_KIND_UNSPECIFIED' }];
  await assert.rejects(grok.harnessTool('1', call), /VoiceCallHarnessTool returned an unusable answer/);
  b.tool = () => [200, null];
  await assert.rejects(grok.harnessTool('1', call), /unusable answer/);
  b.tool = () => [500, { message: 'boom' }];
  await assert.rejects(grok.harnessTool('1', call), /VoiceCallHarnessTool failed \(HTTP 500: boom\)/);
});

test('harnessTool only forwards tools that bot was given, and only after its voice session', async () => {
  const { grok } = client();
  const call = { callId: 'c-1', name: 'send_task', input: {}, line: LINE };
  await assert.rejects(grok.harnessTool('1', call), (e: any) => e instanceof ToolRefusedError && /voice session with this bot first/.test(e.message));
  await grok.voiceSession('1');
  for (const name of ['end_the_call', 'run_anything']) {
    await assert.rejects(grok.harnessTool('1', { ...call, name }), (e: any) => e instanceof ToolRefusedError && /not one of this bot's call tools/.test(e.message));
  }
  assert.equal(up.requests.filter((r) => r.url.endsWith('/VoiceCallHarnessTool')).length, 0, 'nothing was forwarded');
});

test('harnessTool gives up when Grok Bot is too slow', async () => {
  const store = new AuthStore(path.join(tmp, `d${dirN++}`));
  store.write({ accessToken: 'good', refreshToken: 'ref', machineId: 'mid' } as any);
  const grok = new GrokBotClient({ store, apiUrl: up.url, toolTimeoutMs: 50 });
  await grok.voiceSession('1');
  b.toolDelayMs = 300;
  await assert.rejects(grok.harnessTool('1', { callId: 'c', name: 'send_task', input: {}, line: LINE }), /VoiceCallHarnessTool did not answer within 0.05 s/);
});

test('server harness definitions cannot duplicate or replace the direct app tools', async () => {
  b.harness = { tools: [{ ...SEND_TASK, name: 'list_connected_apps', description: 'Old conflicting definition' }] };
  const voice = await client().grok.voiceSession('1');
  assert.equal(voice.tools.filter((t) => t.name === 'list_connected_apps').length, 1);
  assert.doesNotMatch(voice.tools.find((t) => t.name === 'list_connected_apps')!.description, /conflicting/);
});

test('voiceSession: the connected apps come with the session; a late or failed list falls back to the last one and adds at most APPS_GRACE_MS to a join', async () => {
  let now = 0;
  const store = new AuthStore(path.join(tmp, `d${dirN++}`));
  store.write({ accessToken: 'good', refreshToken: 'ref', machineId: 'mid' });
  const grok = new GrokBotClient({ store, apiUrl: up.url, now: () => now });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const mail = { name: 'Mail', serverIdentifier: 'user-Mail', type: 'HTTP', userHasAccessToken: true };
  const render = { name: 'Render', serverIdentifier: 'user-Render', type: 'HTTP', userHasAccessToken: false };
  const MAIL = { id: 'user-Mail', name: 'Mail', status: 'connected' };
  const RENDER = { id: 'user-Render', name: 'Render', status: 'needsAuth' };
  const timed = async () => { const s = Date.now(); const v = await grok.voiceSession('1'); return { apps: v.apps, ms: Date.now() - s, v }; };

  b.apps = null;
  const failed = await timed();
  assert.deepEqual(failed.apps, [], 'failed and nothing remembered: the bot lists apps itself');
  assert.equal(failed.v.instructions, 'Be My Bot.', 'the join itself is fine');
  b.apps = { servers: [mail] };
  b.appsDelayMs = APPS_GRACE_MS + 400;
  const late = await timed();
  assert.deepEqual(late.apps, [], 'late and nothing remembered');
  assert.ok(late.ms < APPS_GRACE_MS + 250, `joining waited ${late.ms} ms, not for the late list`);
  await sleep(500); // the late list lands, and is remembered
  b.apps = null;
  b.appsDelayMs = 0;
  assert.deepEqual((await timed()).apps, [MAIL], 'failed: the remembered list');
  b.apps = { servers: [mail, render] };
  b.appsDelayMs = APPS_GRACE_MS + 400;
  const lateAgain = await timed();
  assert.deepEqual(lateAgain.apps, [MAIL], 'late: the remembered list');
  assert.ok(lateAgain.ms < APPS_GRACE_MS + 250);
  await sleep(500); // now remembered: Mail and Render, at time 0
  b.apps = null;
  b.appsDelayMs = 0;
  now = APPS_REMEMBERED_MS - 1;
  assert.deepEqual((await timed()).apps, [MAIL, RENDER], 'still young enough');
  now = APPS_REMEMBERED_MS;
  assert.deepEqual((await timed()).apps, [], 'too old to use');
  // While the rest of the setup is slow, the list has time to arrive.
  b.apps = { servers: [mail] };
  b.appsDelayMs = 300;
  b.harnessDelayMs = 450;
  assert.deepEqual((await timed()).apps, [MAIL]);
});

test('an unreachable Grok Bot server says so and why, instead of "fetch failed"', async () => {
  const store = new AuthStore(path.join(tmp, `d${dirN++}`));
  store.write({ accessToken: 'good', refreshToken: 'r', machineId: 'm' });
  await assert.rejects(new GrokBotClient({ store, apiUrl: await deadUrl() }).listBots(), /^Error: Could not reach Grok Bot's server \(ListGrokBotAgents: ECONNREFUSED\)$/);
  const noCode = Object.assign(new TypeError('fetch failed'), { cause: new Error('socket hang up') });
  const bare = new TypeError('fetch failed');
  for (const [err, why] of [[noCode, 'socket hang up'], [bare, 'network error']] as const) {
    const grok = new GrokBotClient({ store, apiUrl: up.url, fetch: async () => { throw err; } });
    await assert.rejects(grok.listBots(), (e: any) => e.message === `Could not reach Grok Bot's server (ListGrokBotAgents: ${why})` && e.cause === err);
  }
  const other = new TypeError('something else');
  await assert.rejects(new GrokBotClient({ store, apiUrl: up.url, fetch: async () => { throw other; } }).listBots(), (e) => e === other, 'other errors pass through');
});

test('a voice setup request that hangs fails after its limit instead of holding the join', async () => {
  const { store } = client();
  const grok = new GrokBotClient({ store, apiUrl: up.url, setupTimeoutMs: 80 });
  await grok.listBots();
  b.harnessDelayMs = 400;
  const started = Date.now();
  await assert.rejects(grok.voiceSession('1'), /Grok Bot VoiceCallHarnessSession did not answer within 0\.08 s/);
  assert.ok(Date.now() - started < 350);
  await new Promise((r) => setTimeout(r, 450));
});

const entry = (seq: number | string, body: object) => ({ seq: String(seq), entryKind: (body as any).kind, body: Buffer.from(JSON.stringify(body)).toString('base64') });

test('landedText turns each kind of agent message into words the bot can say', () => {
  assert.equal(landedText({ type: 'text', content: '  Posted it.  ' }), 'Posted it.');
  assert.equal(landedText({ type: 'text', content: '   ' }), null);
  assert.equal(landedText({ type: 'text' }), null);
  assert.equal(landedText({ type: 'auto-review-approval', approval: { summary: 'Post a comment on PR 1249' } }), 'It is waiting for approval in the Grok Bot app: Post a comment on PR 1249.');
  assert.equal(landedText({ type: 'auto-review-approval' }), 'It is waiting for approval in the Grok Bot app: an action it wants to take.');
  assert.equal(landedText({ type: 'connector', connector: 'X', variant: 'connect' }), 'It needs X connected in the Grok Bot app first.');
  assert.equal(landedText({ type: 'connector', connector: 'Gmail', variant: 'reauth' }), 'It needs Gmail signed in again in the Grok Bot app first.');
  assert.equal(landedText({ type: 'connector' }), 'It needs an app signed in again in the Grok Bot app first.');
  assert.equal(landedText({ type: 'widget', widget: { prompt: 'Which one?', options: [{ label: 'A' }, { label: ' ' }, null, { label: 'B' }] } }), 'Which one? Options: A, B.');
  assert.equal(landedText({ type: 'widget', widget: { options: 'nope' } }), 'It asks a question');
  assert.equal(landedText({ type: 'draft-card' }), 'It sent a draft-card card, which only shows in the Grok Bot app chat.');
  for (const nothing of [undefined, null, {}, { type: 5 }]) assert.equal(landedText(nothing), null);
});

/** A chat of `count` entries (seq 1..count) that pages like Grok Bot: newest first, `beforeSeq` for older. */
function pagedChat(bodies: Map<number, object>, count: number) {
  const asked: any[] = [];
  const answer = (body: any) => {
    asked.push(body);
    const top = body.beforeSeq === undefined ? count : Number(body.beforeSeq) - 1;
    const entries = [];
    for (let seq = top; seq >= 1 && entries.length < body.limit; seq--) entries.push(entry(seq, bodies.get(seq) ?? { kind: 'event', event: { type: 'noise' } }));
    return { entries };
  };
  return { asked, answer };
}

test('transcript reads back page by page to the cursor, oldest first, once per entry', async () => {
  const { grok } = client();
  const chat = pagedChat(new Map(), 130);
  b.transcript = chat.answer;
  const all = await grok.transcript('1', 7);
  assert.deepEqual([all.entries.length, all.entries[0].seq, all.entries.at(-1)!.seq, all.newest, all.gap], [123, 8, 130, 130, false]);
  assert.deepEqual(chat.asked.map((x) => x.beforeSeq), [undefined, '81', '31'], 'pages of LANDED_SCAN, older each time');
  assert.ok(chat.asked.every((x) => x.agentId === '1' && x.limit === LANDED_SCAN));
  chat.asked.length = 0;
  assert.deepEqual((await grok.transcript('1', 125)).entries.map((e) => e.seq), [126, 127, 128, 129, 130]);
  assert.equal(chat.asked.length, 1, 'the first page reached the cursor');
  chat.asked.length = 0;
  const first = await grok.transcript('1', null);
  assert.deepEqual([first.entries.length, first.newest, chat.asked.length], [LANDED_SCAN, 130, 1], 'no cursor: the newest page only');
  assert.deepEqual((await grok.transcript('1', 130)).entries, []);
  // A backlog longer than ten pages still reaches the cursor.
  b.transcript = pagedChat(new Map(), 600).answer;
  const far = await grok.transcript('1', 0);
  assert.deepEqual([far.gap, far.entries.length], [false, 600]);
  // A broken server that repeats a full page cannot make polling loop forever.
  b.transcript = pagedChat(new Map(), 100).answer({ agentId: '1', limit: LANDED_SCAN });
  assert.equal((await grok.transcript('1', 0)).gap, true);
  // Empty, short and odd chats.
  for (const odd of [{}, { entries: 'nope' }, null, { entries: [] }]) {
    b.transcript = odd;
    assert.deepEqual(await grok.transcript('1', 3), { entries: [], newest: null, gap: false });
  }
  b.transcript = { entries: [entry(9, { kind: 'message' }), { seq: 'x', body: entry(1, {}).body }, { seq: '8', body: 'not base64 json' }, { seq: '7', body: Buffer.from('5').toString('base64') }, { seq: '6' }, entry(9, { kind: 'dup' })] };
  assert.deepEqual((await grok.transcript('1', 0)).entries, [{ seq: 9, body: { kind: 'dup' } }], 'broken entries skipped, one per seq');
});

test('acceptance 4: more than 50 unrelated entries between a job and its approval card; the card reaches its job once, and a relaunch keeps it', async () => {
  const { grok } = client();
  const dir = fs.mkdtempSync(path.join(tmp, 'accept4-'));
  const store = new ActionStore(dir);
  const ch = 'voice:call-4-1';
  const bodies = new Map<number, object>();
  const t0 = Date.now();
  bodies.set(10, { kind: 'message', role: 'user', content: 'Post the comment', channel: ch, channelSender: 'the call', requestId: 'req-1', timestampMs: t0 });
  for (let s = 11; s <= 130; s++) bodies.set(s, { kind: 'send-message', message: { type: 'text', content: `unrelated ${s}` }, requestId: `other-${s}`, timestampMs: t0 });
  bodies.set(131, { kind: 'send-message', id: 't131s', requestId: 'req-1', message: { type: 'auto-review-approval', approval: { requestId: 'ap-1', summary: 'Post a comment on PR 1249', status: 'pending' } }, timestampMs: t0 });
  const action = store.create({ callId: 'call-4-1', botId: '1', botName: 'Bot', target: 'agent', tool: 'send_task', input: { request: 'Post the comment' } });
  store.setCursor('1', 9);
  b.transcript = pagedChat(bodies, 131).answer;
  const timers: any[] = [];
  const watcher = (s: ActionStore) => new JobWatcher({ grok, store: s, setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimer: () => {}, now: Date.now });
  await watcher(store).check('1');
  const got = store.get(action.id)!;
  assert.deepEqual([got.requestId, got.status, got.approval?.requestId], ['req-1', 'waiting_approval', 'ap-1']);
  assert.deepEqual(store.events(action.id).map((e) => [e.seq, e.kind]), [[131, 'approval']], 'once, to the right job');
  assert.equal(store.eventsForCall('1', 'call-4-1', 0).length, 1, 'none of the 120 unrelated entries reached the call');
  store.close();
  // Relaunch: a new store and watcher on the same file; the same chat again changes nothing and keeps the card.
  const again = new ActionStore(dir);
  await watcher(again).check('1');
  assert.deepEqual(again.events(action.id).map((e) => e.seq), [131]);
  assert.equal(again.get(action.id)!.status, 'waiting_approval');
  assert.equal(again.cursor('1'), 131);
  again.close();
});


test('voice setup forwards description, language and speed and discovers bot resources by UUID', async () => {
  b.agents = { agents: [{ ...AGENTS[0], agentId: 'uuid-1', description: 'Build things', voiceLanguage: 'hi' }] };
  b.harness = { instructions: 'base', greeting: { direction: 'hello' }, receipt: { instructions: 'keep talking' } };
  extras = {
    ListGrokBotAgentSkills: { skills: [null, { name: '  research ', description: 'Read docs' }, { name: 'plain' }] },
    ListGrokBotAgentRoutines: { routines: [null, { name: 'Daily', triggerDescription: '9 am', isEnabled: true, nextRunAtMs: '20' }, { name: 'Paused', schedule: 'weekly' }, { name: 'Plain' }] },
    ListGrokBotUserComputers: { computers: [{ hello: { label: 'Mac' }, lastSeenAtMs: Date.now() }, {}] },
  };
  const { grok } = client(); const v = await grok.voiceSession('1');
  assert.deepEqual(v.greeting, { direction: 'hello', withLandedWork: 'hello' });
  assert.deepEqual(v.receipt, { instructions: 'keep talking', output: null });
  assert.equal(v.skills.length, 2); assert.equal(v.routines.length, 3);
  assert.equal(v.computers[0].online, true); assert.equal(v.computers[1].label, 'a computer');
  assert.equal(up.requests.find((r) => r.url.endsWith('ListGrokBotAgentSkills'))!.body.agentId, 'uuid-1');
  assert.equal(up.requests.find((r) => r.url.endsWith('VoiceCallHarnessSession'))!.body.description, 'Build things');
  b.harness = { greeting: { direction: 'hi', withLandedWork: 'news' }, receipt: { instructions: 'receipt', output: { status: 'running' } } };
  assert.equal((await grok.voiceSession('1')).greeting!.withLandedWork, 'news');
  assert.equal(spokenLanguage('bad@@'), null);
  assert.equal(spokenLanguage('zzzz'), null);
  assert.deepEqual(grok.botMeta('missing'), { uuid: null, description: null });
  delete extras.ListGrokBotAgentSkills; delete extras.ListGrokBotAgentRoutines; delete extras.ListGrokBotUserComputers;
  const empty = await grok.voiceSession('1');
  assert.deepEqual([empty.skills, empty.routines, empty.computers], [[], [], []]);
});

test('file catalogs and approvals use the UUID and exact request contracts', async () => {
  b.agents = { agents: [{ ...AGENTS[0], agentId: 'uuid-1' }] };
  extras = { ListGrokBotAgentFiles: { files: [{ name: 'a', path: 'a', sizeBytes: '12' }, null] }, ListGrokBotUserStoreFiles: { files: [{ name: 'b', path: 'b' }] }, ResolveGrokBotAutoReviewApproval: {}, ResolveGrokBotLocalToolPermission: {} };
  const { grok } = client();
  assert.deepEqual((await grok.files('1')).map((f) => [f.name, f.sizeBytes, f.source]), [['a', 12, 'agent'], ['b', 0, 'store']]);
  const approval = { kind: 'auto_review' as const, requestId: 'request-1', entryId: 'entry', summary: 'Read test', status: 'pending' as const };
  for (const decision of ['approve', 'deny'] as const) {
    await grok.resolveApproval('1', approval, decision);
    await grok.resolveApproval('1', { ...approval, kind: 'local_tool' }, decision);
  }
  const requests = up.requests.filter((r) => /ResolveGrokBot/.test(r.url));
  assert.deepEqual(requests.map((r) => r.body.resolution), [1, 1, 2, 2]);
  assert.ok(requests.every((r) => r.body.agentId === 'uuid-1' && r.body.requestId === 'request-1'));
  await assert.rejects(grok.resolveApproval('1', { ...approval, kind: 'local_tool', entryId: null }, 'approve'), /entry ID/);
  await assert.rejects(grok.resolveApproval('1', { ...approval, kind: 'connector' }, 'approve'), /Connect/);
  await assert.rejects(grok.resolveApproval('missing', approval, 'approve'), /UUID/);
  await assert.rejects(grok.files('missing'), /UUID/);
  extras.ListGrokBotAgentFiles = {}; extras.ListGrokBotUserStoreFiles = {};
  assert.deepEqual(await grok.files('1'), []);
});
