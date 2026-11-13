// Opt-in integration: real call backend + voice + Grok agent + production native capture.
// Only a disposable verification app is permitted. No browser launch or navigation.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { AuthStore } from '../src/auth.ts';
import { createOverlayServer } from '../src/overlay/server.ts';
const exec = promisify(execFile);
const fixture = (await exec('python3', ['scripts/build-verification-app.py'], { cwd: process.cwd() })).stdout.trim();
assert.ok(fixture.startsWith(path.join(os.homedir(), 'Library/Application Support/GrokCall/live-tests/')));
const fixtureApp = path.join(fixture, 'Grok Call Verification.app');
const expected = fs.readFileSync(path.join(fixture, 'phrase.txt'), 'utf8').trim();
const realStore = new AuthStore(path.join(os.homedir(), 'Library/Application Support/GrokCall'));
const auth = realStore.read(); assert.ok(auth);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-native-call-'));
const tempStore = new AuthStore(dir); tempStore.write(auth);
const token = crypto.randomBytes(32).toString('hex');
const log: any[] = [];
const server = createOverlayServer({ dataDir: dir, token, fetch: async (url, opts) => {
  if (String(url).endsWith('/VoiceCallHarnessTool')) {
    const body = JSON.parse(String(opts?.body));
    if (body.name === 'send_task' && !body.input.request.includes('The call ended') && !body.input.request.includes(fixtureApp)) {
      log.push({ refusedAgentRequest: body.input.request });
      return new Response(JSON.stringify({ message: 'Verification only permits the exact fixture app path.' }), { status: 403 });
    }
  }
  return fetch(url, opts);
} });
await new Promise<void>((r) => server.server.listen(0, '127.0.0.1', r));
const port = (server.server.address() as any).port;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${token}` } });
let seq = 0, audioFrames = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
const lines: string[] = [];
const native: any[] = [];
let view: any;
function op(op: string, args: object = {}): Promise<any> {
  const req = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(req); reject(new Error(`${op} timed out`)); }, 30000);
    pending.set(req, { resolve, reject, timer });
    ws.send(JSON.stringify({ op, req, ...args }));
  });
}
ws.on('message', (data, binary) => {
  if (binary) { audioFrames++; return; }
  const m = JSON.parse(data.toString());
  if (m.t === 'reply') {
    const p = pending.get(m.req); if (p) { clearTimeout(p.timer); pending.delete(m.req); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)); }
  }
  if (m.t === 'view') view = m.view ?? m;
  if (m.t === 'lines') for (const l of m.lines) { lines.push(l.text); log.push({ line: l.text }); }
  if (m.t === 'localTool') void (async () => {
    assert.equal(m.tool, 'mac_observe', 'This check must not operate any real app or browser through native tools');
    assert.ok(['Grok Call Verification', 'me.shashankdev.grokcall.verification'].includes(m.input.app));
    const input = path.join(dir, `${m.id}.json`), result = path.join(dir, `${m.id}-result.json`);
    fs.writeFileSync(input, JSON.stringify(m), { mode: 0o600 });
    await exec('/bin/bash', ['mac/test.sh', '--skip-build', '--filter', 'VoiceCaptureBridgeTests'], { cwd: process.cwd(), env: { ...process.env, GROK_CAPTURE_COMMAND: input, GROK_CAPTURE_RESULT: result }, timeout: 45000, maxBuffer: 1024 * 1024 });
    const text = fs.readFileSync(result, 'utf8');
    const context = JSON.parse(fs.readFileSync(result + '.context', 'utf8'));
    assert.equal(context.foregroundBefore, context.foregroundAfter, 'Capture must preserve focus');
    assert.notEqual(context.foregroundBefore, 'me.shashankdev.grokcall.verification', 'This acceptance read must exercise a background app');
    native.push({ input: m.input, result: JSON.parse(text), context });
    await op('localResult', { id: m.id, text });
  })().catch(async (e) => { log.push({ nativeError: e.message }); await op('localResult', { id: m.id, error: e.message }).catch(() => {}); });
});
async function until(check: () => boolean, ms = 120000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('Native-call acceptance timed out'); await new Promise((r) => setTimeout(r, 200)); }
}
try {
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const { bots } = await op('bots');
  const bot = bots.find((b: any) => b.name === 'My Bot') ?? bots[0]; assert.ok(bot);
  await op('join', { botIds: [bot.id] });
  await until(() => view?.bots?.some((b: any) => !['connecting', 'reconnecting'].includes(b.status)), 45000);
  await op('say', { text: `On my Mac, open the verification app in the background without bringing it forward, at this exact path: ${fixtureApp}. Then navigate it by pressing its Show details button without bringing it forward and verify the resulting window. This is an authorized disposable UI test. Use the local Mac, not the cloud computer. Do not open any browser, change profiles, touch other apps/documents, edit any files, or claim completion from a job receipt.` });
  await until(() => fs.existsSync(path.join(fixture, 'navigation-proof.txt')));
  assert.equal(fs.readFileSync(path.join(fixture, 'navigation-proof.txt'), 'utf8'), expected, 'A real navigation must produce the fixture proof');
  const before = lines.length;
  await op('say', { text: 'Can you read all windows of Grok Call Verification now, including their background, navigation and reference proof phrases? It is already open. Do not activate it or launch anything. Use actual window reading rather than window titles.' });
  await until(() => native.length > 0 && lines.slice(before).some((l) => l.toLowerCase().includes(expected.toLowerCase())));
  assert.ok(native.some((n) => n.input.operation === 'read_all' && n.result.capturedCount === 2), 'Both real app windows must be captured, not merely listed');
  const referencePhrase = expected.split(' ').reverse().join(' ');
  assert.ok(lines.slice(before).join(' ').toLowerCase().includes(referencePhrase.toLowerCase()), 'The second window must also be read back');
  assert.ok(audioFrames > 0, 'The voice endpoint must produce audio');
  const actions = await op('actions');
  assert.ok(actions.actions.some((a: any) => a.tool === 'send_task'), 'Launch/navigation must use the tracked Mac agent route');
  assert.ok(actions.actions.some((a: any) => a.tool === 'mac_observe' && a.status === 'completed'));
  const report = { passed: true, scope: 'Real backend WebSocket, voice endpoint, Grok agent launch/navigation, production MacTools/AppObservation through opt-in native harness, and generated voice audio. Native menu UI and speaker playback are not automated.', fixtureApp, expected, native, actions: actions.actions.map((a: any) => ({ tool: a.tool, status: a.status, summary: a.summary })), log, audioFrames };
  fs.writeFileSync(new URL('../docs/verification/background-viewing/live-native-call.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, nativeCaptures: native.length, audioFrames, log }));
} catch (e) {
  const actions = ws.readyState === WebSocket.OPEN ? await op('actions').catch(() => null) : null;
  fs.writeFileSync(path.join(dir, 'failure.json'), JSON.stringify({ error: String(e), log, native, actions }, null, 2), { mode: 0o600 });
  console.error('Failure evidence:', path.join(dir, 'failure.json'));
  throw e;
} finally {
  ws.close(); server.close(); server.server.close();
  const executable = path.join(fixtureApp, 'Contents/MacOS/Verification');
  const ps = await exec('/bin/ps', ['-axo', 'pid=,command=']);
  for (const line of ps.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (match?.[2] === executable) { try { process.kill(Number(match[1]), 'SIGTERM'); } catch {} }
  }
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Test ended')); }
  const refreshed = tempStore.read();
  if (refreshed && JSON.stringify(realStore.read()) === JSON.stringify(auth) && refreshed.accessToken !== auth.accessToken) realStore.write(refreshed);
  tempStore.clear();
}
