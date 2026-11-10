import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp, isAllowed, readJson } from '../src/server.ts';
import { mock, sendJson, until, type Mock } from './helpers.ts';

let up: Mock;
let app: Server;
let base: string;
let port: number;
let signedIn = false;
let upstreamFail = false;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-call-srv-'));

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
    if (method === 'VoiceCallHarnessSession') return sendJson(res, 200, { instructions: 'Be My Bot.' });
    if (method === 'MintSandVoiceCallSecret') {
      return sendJson(res, 200, { clientSecret: 's', model: 'm', websocketUrl: 'wss://voice.test/rt', expiresAtUnixSeconds: '5' });
    }
  });
  app = createApp({ dataDir, apiUrl: up.url, siteUrl: 'https://site.test', pollMs: 5 });
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
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
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
  assert.match(await page.text(), /<title>Grok Call<\/title>/);
  for (const p of ['/app.js', '/core.js']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type')!, /text\/javascript/);
  }
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
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
  assert.deepEqual(await r.json(), { clientSecret: 's', url: 'wss://voice.test/rt?model=m', expiresAt: 5, instructions: 'Be My Bot.' });
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
  const other = createApp({ dataDir: dir, apiUrl: up.url, siteUrl: 'https://site.test', pollMs: 5 });
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
  const real = createApp({ dataDir: dir, pollMs: 60_000 });
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
