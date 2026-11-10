import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { AuthStore, Login, pkce } from '../src/auth.ts';
import { deadUrl, mock, sendJson, until } from './helpers.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-call-auth-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshStore = () => new AuthStore(path.join(tmp, `s${n++}`, 'data'));

test('AuthStore reads nothing when the file is missing, corrupt or incomplete', () => {
  const s = freshStore();
  assert.equal(s.read(), null);
  fs.mkdirSync(s.dir, { recursive: true });
  for (const bad of ['not json', 'null', '{}', '{"accessToken":"a"}', '{"machineId":"m"}', '{"accessToken":"","machineId":"m"}', '{"accessToken":"a","machineId":""}']) {
    fs.writeFileSync(s.file, bad);
    assert.equal(s.read(), null, bad);
  }
});

test('AuthStore writes a private file and reads it back', () => {
  const s = freshStore();
  s.write({ accessToken: 'tok', refreshToken: 'ref', machineId: 'mid' });
  assert.deepEqual(s.read(), { accessToken: 'tok', refreshToken: 'ref', machineId: 'mid' });
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(s.dir).mode & 0o777, 0o700);
  fs.writeFileSync(s.file, JSON.stringify({ accessToken: 'tok', refreshToken: '', machineId: 'mid' }));
  assert.equal(s.read()!.refreshToken, null);
  s.clear();
  assert.equal(s.read(), null);
  s.clear(); // clearing twice is fine
});

test('pkce: challenge is the SHA-256 of the verifier', () => {
  const { verifier, challenge, uuid } = pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.match(uuid, /^[0-9a-f-]{36}$/);
});

test('Login: opens the Grok Bot sign-in page and stores tokens once the account approves', async () => {
  let polls = 0;
  const up = await mock((req, res) => {
    polls++;
    if (polls === 1) return sendJson(res, 404, { error: 'pending' });
    if (polls === 2) return sendJson(res, 200, 'not json');
    if (polls === 3) return sendJson(res, 200, { accessToken: '' });
    sendJson(res, 200, { accessToken: 'acc', refreshToken: 'ref', uuid: 'x' });
  });
  const store = freshStore();
  const login = new Login({ store, apiUrl: up.url, siteUrl: 'https://site.test', pollMs: 5 });
  assert.deepEqual(login.state(), { state: 'signed-out', error: null });
  const url = new URL(login.start());
  assert.equal(url.origin + url.pathname, 'https://site.test/loginDeepControl');
  assert.equal(url.searchParams.get('mode'), 'login');
  assert.equal(url.searchParams.get('redirectTarget'), 'sand');
  assert.equal(url.searchParams.get('supportsSelectedTeamLogin'), 'true');
  assert.equal(login.state().state, 'signing-in');
  await until(() => login.state().state === 'signed-in');
  const auth = store.read()!;
  assert.equal(auth.accessToken, 'acc');
  assert.equal(auth.refreshToken, 'ref');
  assert.match(auth.machineId, /^[0-9a-f]{64}$/);
  // The poll proves it holds the verifier for the challenge it sent.
  const q = new URL(up.requests[0].url, 'http://x').searchParams;
  assert.equal(q.get('uuid'), url.searchParams.get('uuid'));
  assert.equal(crypto.createHash('sha256').update(q.get('verifier')!).digest('base64url'), url.searchParams.get('challenge'));
  await up.close();
});

test('Login: no refresh token is stored as null', async () => {
  const up = await mock((_req, res) => sendJson(res, 200, { accessToken: 'only' }));
  const store = freshStore();
  const login = new Login({ store, apiUrl: up.url, siteUrl: 'https://site.test', pollMs: 5 });
  login.start();
  await until(() => store.read());
  assert.equal(store.read()!.refreshToken, null);
  await up.close();
});

test('Login: gives up with a message after the timeout, retrying through network errors', async () => {
  const login = new Login({ store: freshStore(), apiUrl: await deadUrl(), siteUrl: 'https://site.test', pollMs: 5, timeoutMs: 60 });
  login.start();
  await until(() => login.state().state === 'signed-out');
  assert.deepEqual(login.state(), { state: 'signed-out', error: 'Sign-in timed out. Try again.' });
});

test('Login: starting again replaces the old attempt; cancel stops it', async () => {
  const up = await mock((_req, res) => sendJson(res, 404, {}));
  const login = new Login({ store: freshStore(), apiUrl: up.url, siteUrl: 'https://site.test', pollMs: 20 });
  const first = new URL(login.start()).searchParams.get('uuid')!;
  await until(() => up.requests.length >= 1);
  const second = new URL(login.start()).searchParams.get('uuid')!;
  assert.notEqual(first, second);
  assert.equal(login.state().state, 'signing-in');
  const firstPolls = () => up.requests.filter((r) => r.url.includes(first)).length;
  const before = firstPolls();
  await until(() => up.requests.filter((r) => r.url.includes(second)).length >= 3);
  assert.ok(firstPolls() <= before + 1, 'the replaced attempt stopped polling');
  login.cancel();
  login.cancel(); // nothing pending: no-op
  assert.equal(login.state().state, 'signed-out');
  const count = up.requests.length;
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(up.requests.length <= count + 1, 'polling stopped after cancel');
  await up.close();
});

test('Login: uses defaults when options are omitted', () => {
  const login = new Login({ store: freshStore(), apiUrl: 'http://127.0.0.1:9', siteUrl: 'https://site.test' });
  assert.equal(login.state().state, 'signed-out');
});
