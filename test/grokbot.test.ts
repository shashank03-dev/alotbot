import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { AuthStore } from '../src/auth.ts';
import {
  CLIENT_ID,
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
  fail?: [number, string];
};
let up: Mock;
let b: Behavior;

beforeEach(async () => {
  await up?.close();
  b = {
    token: 'good',
    agents: { agents: AGENTS },
    refresh: () => [200, { access_token: 'good', refresh_token: 'ref2' }],
    mint: { clientSecret: 'sec', expiresAtUnixSeconds: '1794298888', model: 'grok-voice-3.0', websocketUrl: 'wss://voice.test/v1/realtime?enable_async_updates=true' },
    harness: { instructions: 'Be My Bot.', tools: [SEND_TASK, HANG_UP] },
    tool: (_body: any): [number, unknown] => [200, { kind: 'VOICE_CALL_HARNESS_TOOL_OUTCOME_KIND_SERVED', output: { receipt: 'under way' } }],
    toolDelayMs: 0,
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
    if (method === 'ListGrokBotAgents') return sendJson(res, 200, b.agents);
    if (method === 'VoiceCallHarnessSession') return sendJson(res, 200, b.harness);
    if (method === 'MintSandVoiceCallSecret') return sendJson(res, 200, b.mint);
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
    tools: [SEND_TASK],
  });
  const harness = up.requests.find((r) => r.url.endsWith('/VoiceCallHarnessSession'))!;
  assert.deepEqual(harness.body, { agentId: '2', agentName: "Shashank's Bot", userName: 'Shashank' });
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
  assert.deepEqual(v.tools, []);
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
