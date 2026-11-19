import { APP_TOOLS } from '../src/apps.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp, isAllowed, parseLanded, parseToolCall, readJson, TOOL_BODY_LIMIT } from '../src/server.ts';

const TOKEN = 'k'.repeat(48);
/** Every request in this file carries the run's key, as the page does; tests that check refusals leave it out. */
const fetch = (url: string | URL, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { 'x-grok-call-token': TOKEN, ...(init.headers as Record<string, string>) } });
import { mock, sendJson, until, type Mock } from './helpers.ts';

let up: Mock;
let app: Server;
let base: string;
let port: number;
let signedIn = false;
let upstreamFail = false;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-call-srv-'));
const SEARCH = { type: 'function', name: 'search_conversations', description: 'Search.', parameters: { type: 'object', properties: {} } };
const toolBodies: unknown[] = [];
let transcriptAt = Date.now() + 60_000; // later than the first check, so it counts as news

before(async () => {
  up = await mock((req, res) => {
    if (req.url.startsWith('/auth/poll')) {
      return signedIn ? sendJson(res, 200, { accessToken: 'good', refreshToken: 'ref' }) : sendJson(res, 404, {});
    }
    if (req.headers.authorization !== 'Bearer good') return sendJson(res, 401, { code: 'unauthenticated' });
    if (upstreamFail) return sendJson(res, 503, { message: 'grok is down' });
    const method = req.url.split('/').pop();
    if (method === 'ListGrokBotAgents') {
      return sendJson(res, 200, { agents: [{ id: '7', name: 'My Bot', kind: 'GROK_BOT_AGENT_KIND_AGENT', voiceId: 'carina' }] });
    }
    if (method === 'VoiceCallHarnessSession') return sendJson(res, 200, { instructions: 'Be My Bot.', tools: [SEARCH] });
    if (method === 'VoiceCallHarnessTool') {
      toolBodies.push(req.body);
      return sendJson(res, 200, { kind: 'VOICE_CALL_HARNESS_TOOL_OUTCOME_KIND_SERVED', output: { hits: [], more: false } });
    }
    if (method === 'ListGrokBotTranscriptEntries') {
      const body = { kind: 'send-message', message: { type: 'text', content: 'Posted it.', channel: 'voice:call-1-7' }, timestampMs: transcriptAt };
      return sendJson(res, 200, { entries: [{ seq: '3', body: Buffer.from(JSON.stringify(body)).toString('base64') }] });
    }
    if (method === 'ListGrokBotUserComputers') return sendJson(res, 200, {});
    if (method === 'GetAvailableMcpServers') return sendJson(res, 200, { servers: [{ name: 'Mail', serverIdentifier: 'user-Mail', type: 'HTTP', userHasAccessToken: true }] });
    if (method === 'MintSandVoiceCallSecret') {
      return sendJson(res, 200, { clientSecret: 's', model: 'm', websocketUrl: 'wss://voice.test/rt', expiresAtUnixSeconds: '5' });
    }
  });
  app = createApp({ dataDir, token: TOKEN, apiUrl: up.url, siteUrl: 'https://site.test', pollMs: 5 });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  port = (app.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  app.closeAllConnections();
  await new Promise((r) => app.close(r));
  await up.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Raw request so tests can set Host and Origin freely. */
function raw(method: string, p: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, 'x-grok-call-token': TOKEN, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves the call page and its scripts with a strict CSP', async () => {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type')!, /text\/html/);
  assert.match(page.headers.get('content-security-policy')!, /connect-src 'self' wss:/);
  assert.match(await page.text(), /<title>Alotbot<\/title>/);
  for (const p of ['/app.js', '/core.js']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type')!, /text\/javascript/);
  }
  // The page's call engine is given the host's name (it has no environment of its own).
  const engine = await (await fetch(base + '/core.js')).text();
  assert.match(engine, /^export const USER = "Shashank";$/m);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});

test('the API needs this run\'s key; the page itself does not', async () => {
  for (const key of [undefined, '', 'k'.repeat(47), 'x'.repeat(48)]) {
    const r = await globalThis.fetch(`${base}/api/state`, key === undefined ? {} : { headers: { 'x-grok-call-token': key } });
    assert.equal(r.status, 403, String(key));
    assert.match((await r.json()).error, /link printed in the terminal/);
  }
  assert.equal((await globalThis.fetch(base)).status, 200);
  assert.equal((await globalThis.fetch(`${base}/core.js`)).status, 200);
  assert.equal((await fetch(`${base}/api/state`)).status, 200);
});

test('a key is made for each run when none is given', () => {
  const a = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gc-key-')) });
  const b = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gc-key-')) });
  assert.match(a.token, /^[0-9a-f]{48}$/);
  assert.notEqual(a.token, b.token);
});

test('blocks other sites and DNS rebinding', async () => {
  assert.equal((await raw('GET', '/api/state', { host: 'evil.test' })).status, 403);
  assert.equal((await raw('GET', '/api/state', { host: 'a b' })).status, 403);
  assert.equal((await raw('POST', '/api/login', { origin: 'https://evil.test' })).status, 403);
  assert.equal((await raw('POST', '/api/login', { origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.equal((await raw('GET', '/api/state', { host: `localhost:${port}` })).status, 200);
  // A cross-site GET can't read the response anyway (no CORS), so Origin isn't required there.
  assert.equal((await raw('GET', '/api/state', { origin: 'https://evil.test' })).status, 200);
});

test('isAllowed accepts IPv6 loopback', () => {
  const req = { headers: { host: '[::1]:8787' }, method: 'GET' } as unknown as http.IncomingMessage;
  assert.equal(isAllowed(req), true);
  assert.equal(isAllowed({ headers: {}, method: 'GET' } as unknown as http.IncomingMessage), false);
});

test('signed out: bots answer 401 so the page shows sign-in', async () => {
  const r = await fetch(`${base}/api/bots`);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).signedOut, true);
});

test('sign-in flow: login URL, then state flips to signed-in', async () => {
  const r = await fetch(`${base}/api/login`, { method: 'POST' });
  const { loginUrl } = await r.json();
  assert.match(loginUrl, /^https:\/\/site\.test\/loginDeepControl\?challenge=/);
  assert.equal((await (await fetch(`${base}/api/state`)).json()).state, 'signing-in');
  signedIn = true;
  await until(() => fs.existsSync(path.join(dataDir, 'auth.json')));
  assert.equal((await (await fetch(`${base}/api/state`)).json()).state, 'signed-in');
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));
  assert.equal(stored.accessToken, 'good');
});

test('lists bots and mints a voice session for one', async () => {
  await until(() => fs.existsSync(path.join(dataDir, 'auth.json')));
  const bots = await (await fetch(`${base}/api/bots`)).json();
  assert.deepEqual(bots, { bots: [{ id: '7', name: 'My Bot', voice: 'carina', speed: 1, language: null, color: null, shape: null }] });
  const r = await fetch(`${base}/api/bots/7/voice`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { clientSecret: 's', url: 'wss://voice.test/rt?model=m', expiresAt: 5, instructions: 'Be My Bot.', tools: [SEARCH, ...APP_TOOLS], apps: [{ id: 'user-Mail', name: 'Mail', status: 'connected' }], greeting: null, receipt: null, skills: [], routines: [], computers: [] });
  assert.equal((await fetch(`${base}/api/bots/nope/voice`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/api/bots/7/voice`)).status, 405);
  assert.equal((await fetch(`${base}/api/bots/bad%20id/voice`, { method: 'POST' })).status, 404);
});

test('upstream trouble is a 502 with the reason', async () => {
  upstreamFail = true;
  const r = await fetch(`${base}/api/bots`);
  upstreamFail = false;
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /HTTP 503: grok is down/);
});

test('unknown routes and methods', async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  const r = await fetch(`${base}/api/state`, { method: 'POST' });
  assert.equal(r.status, 405);
  assert.match((await r.json()).error, /POST not allowed/);
});

test('closing the server stops a pending sign-in', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-call-srv2-'));
  const other = createApp({ dataDir: dir, token: TOKEN, apiUrl: up.url, siteUrl: 'https://site.test', pollMs: 5 });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  signedIn = false;
  await fetch(`${url}/api/login`, { method: 'POST' });
  other.closeAllConnections();
  await new Promise((r) => other.close(r));
  const polls = up.requests.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(up.requests.length <= polls + 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('defaults to the real Grok Bot sign-in page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-call-srv3-'));
  const real = createApp({ dataDir: dir, token: TOKEN, pollMs: 60_000 });
  await new Promise<void>((r) => real.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(real.address() as AddressInfo).port}`;
  const { loginUrl } = await (await fetch(`${url}/api/login`, { method: 'POST' })).json();
  assert.match(loginUrl, /^https:\/\/cursor\.com\/loginDeepControl\?/);
  real.closeAllConnections();
  await new Promise((r) => real.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('memory: none at first, then the last saved call; calls are saved under dataDir', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/memory`)).json(), { memory: null });
  const memory = { summary: 'We chose May.', actionItems: ['Email Sam'], notes: [{ text: 'Budget 5k', by: 'Bot A' }] };
  const r = await fetch(`${base}/api/calls`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memory, markdown: '# Call' }) });
  assert.equal(r.status, 200);
  const { file } = await r.json();
  assert.match(file, /^calls[/\\]call-.*\.md$/);
  assert.equal(fs.readFileSync(path.join(dataDir, file), 'utf8'), '# Call');
  assert.deepEqual(await (await fetch(`${base}/api/memory`)).json(), { memory });
  assert.equal((await fetch(`${base}/api/memory`, { method: 'POST' })).status, 405);
});

test('saving a call refuses bad input with the reason', async () => {
  const post = (body: string, type = 'application/json') => fetch(`${base}/api/calls`, { method: 'POST', headers: { 'content-type': type }, body });
  const memory = { summary: '', actionItems: [], notes: [] };
  const cases: [Response, number, RegExp][] = [
    [await post('{}', 'text/plain'), 415, /send JSON/],
    [await post('{nope'), 400, /not valid JSON/],
    [await post('null'), 400, /markdown must be non-empty text/],
    [await post(JSON.stringify({ memory, markdown: '  ' })), 400, /markdown must be non-empty text/],
    [await post(JSON.stringify({ memory, markdown: 'x'.repeat(2_000_001) })), 400, /markdown must be non-empty text/],
    [await post(JSON.stringify({ memory: { ...memory, summary: 3 }, markdown: '# x' })), 400, /summary must be text/],
  ];
  for (const [r, status, msg] of cases) {
    assert.equal(r.status, status);
    assert.match((await r.json()).error, msg);
  }
  // a cross-site page can't save a call
  assert.equal((await raw('POST', '/api/calls', { origin: 'https://evil.test', 'content-type': 'application/json' })).status, 403);
});

test('readJson stops reading a body over the limit', async () => {
  const req = Object.assign((async function* () {
    yield Buffer.from('[1,');
    yield Buffer.from('2]');
  })(), { headers: { 'content-type': 'application/json; charset=utf-8' } }) as unknown as http.IncomingMessage;
  await assert.rejects(readJson(req, 4), (e: any) => e.status === 413 && /larger than 4 bytes/.test(e.message));
  const ok = Object.assign((async function* () {
    yield Buffer.from('[1,2]');
  })(), { headers: { 'content-type': 'APPLICATION/JSON' } }) as unknown as http.IncomingMessage;
  assert.deepEqual(await readJson(ok, 100), [1, 2]);
  const none = Object.assign((async function* () {})(), { headers: {} }) as unknown as http.IncomingMessage;
  await assert.rejects(readJson(none, 100), (e: any) => e.status === 415);
});

const LINE = { theyJustTalked: true, newsOwed: false, receiptOwed: false, alreadySpokeThisTurn: false };

test('call tools: a bot\'s search goes to Grok Bot; hang-up and malformed calls are refused with the reason', async () => {
  await until(() => fs.existsSync(path.join(dataDir, 'auth.json')));
  const post = (id: string, body: unknown, type = 'application/json') =>
    fetch(`${base}/api/bots/${id}/tool`, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const call = { callId: 'call-1-7', name: 'search_conversations', input: { query: 'launch', if_missing: 'say-no-record' }, line: LINE };
  await fetch(`${base}/api/bots/7/voice`, { method: 'POST' }); // the bot's tools are known once its session is minted
  let r = await post('7', call);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { kind: 'served', output: { hits: [], more: false } });
  assert.deepEqual(toolBodies.at(-1), { agentId: '7', ...call });
  r = await post('7', { ...call, name: 'end_the_call' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /not one of this bot's call tools/);
  assert.equal((await post('unknown', call)).status, 400);
  assert.equal((await post('7', call, 'text/plain')).status, 415);
  assert.equal((await post('7', 'x'.repeat(TOOL_BODY_LIMIT + 1))).status, 413);
  assert.equal((await fetch(`${base}/api/bots/7/tool`)).status, 405);
  assert.equal((await raw('POST', '/api/bots/7/tool', { origin: 'https://evil.test', 'content-type': 'application/json' })).status, 403);
  upstreamFail = true;
  r = await post('7', call);
  upstreamFail = false;
  assert.equal(r.status, 502);
});

test('parseToolCall checks every field', () => {
  const ok = { callId: 'call-1.a:b_c', name: 'send_task', input: { request: 'x' }, line: { ...LINE, extra: 1 } };
  assert.deepEqual(parseToolCall(ok), { ...ok, line: LINE });
  const cases: [unknown, RegExp][] = [
    [null, /body must be an object/],
    [[], /body must be an object/],
    [{ ...ok, callId: '' }, /callId/],
    [{ ...ok, callId: 'a b' }, /callId/],
    [{ ...ok, callId: 'x'.repeat(129) }, /callId/],
    [{ ...ok, callId: 5 }, /callId/],
    [{ ...ok, name: 'Send Task' }, /name must be a tool name/],
    [{ ...ok, name: 7 }, /name must be a tool name/],
    [{ ...ok, input: null }, /input must be an object/],
    [{ ...ok, input: [] }, /input must be an object/],
    [{ ...ok, line: null }, /line must have/],
    [{ ...ok, line: { ...LINE, newsOwed: 'no' } }, /line must have/],
  ];
  for (const [body, msg] of cases) assert.throws(() => parseToolCall(body), (e: any) => e.status === 400 && msg.test(e.message), String(msg));
});

test('agent updates: the page reads what a bot\'s agent sent back to this call', async () => {
  await until(() => fs.existsSync(path.join(dataDir, 'auth.json')));
  const post = (id: string, body: unknown) =>
    fetch(`${base}/api/bots/${id}/landed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let r = await post('8', { callId: 'call-1-8', after: 0 });
  assert.equal(r.status, 400, 'no voice session with this bot');
  assert.match((await r.json()).error, /voice session with this bot first/);
  await fetch(`${base}/api/bots/7/voice`, { method: 'POST' });
  // The first ask marks the call live; the watcher reads the bot's chat and the next ask returns it.
  let work: unknown[] = [];
  for (let i = 0; i < 100 && !work.length; i++) {
    r = await post('7', { callId: 'call-1-7', after: 0 });
    assert.equal(r.status, 200);
    work = (await r.json()).work;
    if (!work.length) await new Promise((res) => setTimeout(res, 20));
  }
  assert.deepEqual(work, [{ seq: 3, at: transcriptAt, kind: 'reply', text: 'Posted it.', actionId: null }]);
  assert.deepEqual(await (await post('7', { callId: 'call-1-7', after: 3 })).json(), { work: [] });
  assert.equal((await post('7', { callId: 'bad id', after: 0 })).status, 400);
  assert.equal((await fetch(`${base}/api/bots/7/landed`)).status, 405);
  // Grok Bot being down does not fail the page: it reads the history, and the watcher tries Grok again.
  upstreamFail = true;
  r = await post('7', { callId: 'call-1-7', after: 3 });
  upstreamFail = false;
  assert.deepEqual([r.status, (await r.json()).work], [200, []]);
});

test('parseLanded checks every field', () => {
  assert.deepEqual(parseLanded({ callId: 'call-1.a:b_c', after: 12, extra: 1 }), { callId: 'call-1.a:b_c', after: 12 });
  const cases: [unknown, RegExp][] = [
    [null, /body must be an object/],
    [[], /body must be an object/],
    [{ callId: '', after: 0 }, /callId/],
    [{ callId: 'x'.repeat(129), after: 0 }, /callId/],
    [{ callId: 5, after: 0 }, /callId/],
    [{ callId: 'c', after: -1 }, /after/],
    [{ callId: 'c', after: 1.5 }, /after/],
    [{ callId: 'c', after: '1' }, /after/],
    [{ callId: 'c' }, /after/],
  ];
  for (const [body, msg] of cases) assert.throws(() => parseLanded(body), (e: any) => e.status === 400 && msg.test(e.message), String(msg));
});

test('recorded action lists are available without sending full tool results again', async () => {
  const response = await fetch(`${base}/api/actions`);
  assert.equal(response.status, 200);
  const list = (await response.json()).actions;
  assert.ok(Array.isArray(list));
  assert.ok(list.every((a: any) => a.result === undefined && a.input === undefined));
});
