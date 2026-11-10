import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { USER } from '../public/core.js';
import { AuthStore } from '../src/auth.ts';
import { AUDIO_LEAD_S, createOverlayServer, decodeMic, defaultOpenSocket, encodeBotAudio, MSG, upgradeAllowed } from '../src/overlay/server.ts';
import { OverlayStore } from '../src/overlay/store.ts';
import { FakeSocket, flush, hostSays, reply } from './overlay-fakes.ts';
import { mock, sendJson, type Mock } from './helpers.ts';

const TOKEN = 't'.repeat(40);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-call-srv-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const agent = (id: string, name: string) => ({ id, name, kind: 'GROK_BOT_AGENT_KIND_AGENT', avatarShape: 'blob', avatarColor: 'blue', voiceSpeed: 1 });

// ---------- pure parts ----------

const req = (headers: Record<string, string | undefined>, url = '/ws') => ({ headers, url }) as unknown as http.IncomingMessage;

test('upgradeAllowed: local host, no browser origin, /ws, exact token', () => {
  const ok = { host: '127.0.0.1:8788', authorization: `Bearer ${TOKEN}` };
  assert.equal(upgradeAllowed(req(ok), TOKEN), true);
  assert.equal(upgradeAllowed(req({ ...ok, host: 'localhost:1' }), TOKEN), true);
  assert.equal(upgradeAllowed(req({ ...ok, host: 'evil.com' }), TOKEN), false);
  assert.equal(upgradeAllowed(req({ ...ok, host: 'a b' }), TOKEN), false);
  assert.equal(upgradeAllowed(req({ ...ok, host: undefined }), TOKEN), false);
  assert.equal(upgradeAllowed(req({ ...ok, origin: 'http://127.0.0.1:8788' }), TOKEN), false);
  assert.equal(upgradeAllowed(req(ok, '/other'), TOKEN), false);
  assert.equal(upgradeAllowed(req({ ...ok, authorization: undefined }), TOKEN), false);
  assert.equal(upgradeAllowed(req({ ...ok, authorization: `Bearer ${'x'.repeat(40)}` }), TOKEN), false);
});

test('bot audio frames carry id, play time and PCM16', () => {
  const f = encodeBotAudio(7, 12.5, new Float32Array([0, 0.5, -1]));
  assert.equal(f[0], MSG.botAudio);
  assert.equal(f.readUInt32LE(1), 7);
  assert.equal(f.readDoubleLE(5), 12.5);
  assert.deepEqual([f.readInt16LE(13), f.readInt16LE(15), f.readInt16LE(17)], [0, 16383, -32768]);
});

test('mic frames decode, clamp the level, and refuse junk', () => {
  const frame = (level: number, samples: number[], type: number = MSG.mic) => {
    const b = Buffer.alloc(5 + samples.length * 2);
    b[0] = type;
    b.writeFloatLE(level, 1);
    samples.forEach((s, i) => b.writeInt16LE(s, 5 + i * 2));
    return b;
  };
  assert.deepEqual(decodeMic(frame(0.25, [1, -2])), { level: 0.25, pcm: new Int16Array([1, -2]) });
  assert.equal(decodeMic(frame(5, [1]))!.level, 1);
  assert.equal(decodeMic(frame(0.1, [])), null); // no samples
  assert.equal(decodeMic(frame(0.1, [1], 9)), null);
  assert.equal(decodeMic(Buffer.concat([frame(0.1, [1]), Buffer.from([0])])), null); // odd length
  assert.equal(decodeMic(frame(Number.NaN, [1])), null);
  assert.equal(decodeMic(frame(-1, [1])), null);
});

// ---------- the server against a fake Grok Bot ----------

interface Harness {
  url: string;
  up: Mock;
  dir: string;
  sockets: Map<string, FakeSocket>;
  app: ReturnType<typeof createOverlayServer>;
  agents: any[];
  clockAt: (s: number) => void;
}
const open: Harness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) {
    h.app.close();
    h.app.server.closeAllConnections();
    await new Promise((r) => h.app.server.close(r));
    await h.up.close();
  }
});

/** `viewMs: null` leaves it out, so the server's default cadence is used. */
async function start(signedIn = true, viewMs: number | null = 5): Promise<Harness> {
  const agents = [agent('a', 'Bot A'), agent('b', 'Bot B'), agent('c', 'Bot C')];
  const up = await mock((r, res) => {
    const method = r.url.split('/').pop()!;
    if (method === 'ListGrokBotAgents') return sendJson(res, 200, { agents });
    if (method === 'VoiceCallHarnessSession') return sendJson(res, 200, { instructions: `I am ${r.body.agentName}.` });
    if (method === 'MintSandVoiceCallSecret') return sendJson(res, 200, { clientSecret: 's', model: 'm', websocketUrl: 'wss://voice.test/rt' });
    if (method === 'SetGrokBotAgentVoice') {
      Object.assign(agents.find((a) => a.id === r.body.id)!, { voiceId: r.body.voiceId });
      return sendJson(res, 200, {});
    }
    if (method === 'CreateGrokBotTemporalAgent') {
      agents.push(agent('n', r.body.name));
      return sendJson(res, 200, { agent: { id: 'n' } });
    }
    if (r.url.startsWith('/auth/poll')) return sendJson(res, 404, {});
    sendJson(res, 404, { message: method });
  });
  const dir = fs.mkdtempSync(path.join(tmp, 'd'));
  if (signedIn) new AuthStore(dir).write({ accessToken: 'tok', refreshToken: null, machineId: 'mid' });
  const sockets = new Map<string, FakeSocket>();
  let mintFor: string[] = [];
  let now = 100;
  const app = createOverlayServer({
    dataDir: dir,
    token: TOKEN,
    apiUrl: up.url,
    siteUrl: 'https://site.test',
    pollMs: 60_000,
    clock: () => now,
    ...(viewMs === null ? {} : { viewMs }),
    // Each bot's socket is keyed by the order the call asked for voice sessions.
    openSocket: (url: string) => {
      const ws = new FakeSocket(url);
      const id = mintFor.shift() ?? `x${sockets.size}`;
      sockets.set(id, ws);
      return ws;
    },
  });
  // Learn which bot each socket belongs to from the harness request order.
  const origFetchOrder = up.requests;
  void origFetchOrder;
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address() as AddressInfo;
  const h: Harness = { url: `ws://127.0.0.1:${port}/ws`, up, dir, sockets, app, agents, clockAt: (s) => (now = s) };
  (h as any).expect = (ids: string[]) => (mintFor = [...ids]);
  open.push(h);
  return h;
}

class Client {
  ws: WebSocket;
  msgs: any[] = [];
  bins: Buffer[] = [];
  n = 0;
  waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  closed: Promise<{ code: number }>;
  constructor(url: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
    this.ws = new WebSocket(url, { headers });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return void this.bins.push(data as Buffer);
      const m = JSON.parse(data.toString());
      this.msgs.push(m);
      for (const w of [...this.waiters]) if (w.pred(m)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(m);
      }
    });
    this.closed = new Promise((r) => this.ws.on('close', (code) => r({ code })));
  }
  ready() {
    return new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }
  /** Waits for a matching message, ignoring ones already received when `fresh`. */
  next(pred: (m: any) => boolean, fresh = false): Promise<any> {
    const have = fresh ? undefined : this.msgs.find(pred);
    if (have) return Promise.resolve(have);
    return new Promise((resolve) => this.waiters.push({ pred, resolve }));
  }
  async op(op: string, args: object = {}): Promise<any> {
    const req = ++this.n;
    this.ws.send(JSON.stringify({ ...args, req, op }));
    return this.next((m) => m.t === 'reply' && m.req === req);
  }
  async ok(op: string, args: object = {}) {
    const r = await this.op(op, args);
    assert.equal(r.ok, true, `${op}: ${r.error}`);
    return r.result;
  }
  async fails(op: string, args: object, why: RegExp) {
    const r = await this.op(op, args);
    assert.equal(r.ok, false, `${op} should fail`);
    assert.match(r.error, why);
    return r;
  }
}

async function connect(h: Harness) {
  const c = new Client(h.url);
  await c.ready();
  return c;
}

/** Joins with bots a and b and confirms both voice sessions. */
async function inCall(h: Harness, c: Client, ids = ['a', 'b']) {
  (h as any).expect(ids);
  await c.ok('join', { botIds: ids });
  for (let i = 0; i < 20 && h.sockets.size < ids.length; i++) await new Promise((r) => setTimeout(r, 5));
  for (const id of ids) {
    h.sockets.get(id)!.onopen!();
    h.sockets.get(id)!.emit('session.updated');
  }
}

test('plain HTTP gets 404 and a bad upgrade gets 403', async () => {
  const h = await start();
  const res = await fetch(h.url.replace('ws:', 'http:'));
  assert.equal(res.status, 404);
  const bad = new Client(h.url, { authorization: 'Bearer nope' });
  await assert.rejects(bad.ready(), /403/);
});

test('hello, state, login and bots', async () => {
  const h = await start();
  const c = await connect(h);
  const hello = await c.ok('hello');
  assert.equal(hello.version, 1);
  assert.equal(hello.serverNow, 100);
  assert.equal(hello.user, USER);
  assert.equal(hello.choices.voices.length, 28);
  assert.deepEqual(await c.ok('state'), { state: 'signed-in', error: null });
  assert.match((await c.ok('login')).loginUrl, /^https:\/\/site\.test\/loginDeepControl\?/);
  assert.deepEqual((await c.ok('bots')).bots.map((b: any) => b.name), ['Bot A', 'Bot B', 'Bot C']);
});

test('signed out: requests say so', async () => {
  const h = await start(false);
  const c = await connect(h);
  assert.equal((await c.ok('state')).state, 'signed-out');
  const r = await c.fails('bots', {}, /Signed out/);
  assert.equal(r.signedOut, true);
});

test('bad messages get clear errors', async () => {
  const h = await start();
  const c = await connect(h);
  c.ws.send('not json');
  const r = await c.next((m) => m.t === 'reply' && m.req === null);
  assert.equal(r.error, 'not JSON');
  c.ws.send('null');
  assert.match((await c.next((m) => m.t === 'reply' && m.req === null && m.error !== 'not JSON')).error, /unknown op "undefined"/);
  await c.fails('dance', {}, /unknown op "dance"/);
  for (const op of ['leave', 'say', 'stop', 'mute', 'addBot', 'removeBot']) await c.fails(op, { text: 'x', botId: 'a' }, /not in a call/);
  await c.fails('join', { botIds: [] }, /botIds must be a list/);
  await c.fails('join', { botIds: 'a' }, /botIds must be a list/);
  await c.fails('join', { botIds: [1] }, /botIds must be a list/);
  await c.fails('join', { botIds: ['a', 'zzz'] }, /not on this account/);
  await c.fails('callFile', {}, /file is required/);
  await c.fails('callFile', { file: '../auth.json' }, /not a call file name/);
  await c.fails('setVoice', { botId: 'a', settings: { speed: 9 } }, /speed must be one of/);
  await c.fails('createBot', { bot: { name: '' } }, /name is required/);
  // Binary that isn't a mic frame, or mic audio with no call, is ignored.
  c.ws.send(Buffer.from([9, 9, 9]));
  c.ws.send(Buffer.from([1, 0, 0, 0, 0, 1, 0]));
  assert.equal((await c.ok('state')).state, 'signed-in');
});

test('a call: view, transcript and tasks are pushed; bot audio comes as frames; stop and mute', async () => {
  const h = await start();
  const c = await connect(h);
  await inCall(h, c);
  await c.fails('join', { botIds: ['a'] }, /already in a call/);
  const v = await c.next((m) => m.t === 'view' && m.view.bots.every((b: any) => b.status !== 'connecting'));
  assert.deepEqual(v.view.bots.map((b: any) => b.id), ['a', 'b']);
  assert.ok((await c.next((m) => m.t === 'tasks')).tasks);
  // The opening line plays as audio frames, timed on the server clock plus the lead.
  const a = h.sockets.get('a')!;
  reply(a, 'Hello everyone.', [], 0.5);
  const lines = await c.next((m) => m.t === 'lines');
  assert.deepEqual(lines.lines.map((l: any) => [l.who, l.botId, l.text]), [['Bot A', 'a', 'Hello everyone.']]);
  for (let i = 0; i < 20 && !c.bins.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(c.bins[0][0], MSG.botAudio);
  assert.equal(c.bins[0].readDoubleLE(5), 100 + AUDIO_LEAD_S);
  // Stop: queued audio is cut, and the app is told which chunk to stop.
  await c.ok('stop');
  assert.equal((await c.next((m) => m.t === 'stopAudio')).id, 1);
  await c.ok('mute', { muted: true });
  assert.equal((await c.next((m) => m.t === 'view' && m.view.muted)).view.muted, true);
  await c.ok('mute', {});
  // A mic frame reaches the bot that is listening.
  await c.ok('mute', { muted: false });
  const frame = Buffer.alloc(5 + 4);
  frame[0] = MSG.mic;
  frame.writeFloatLE(0.2, 1);
  c.ws.send(frame);
  await c.ok('state');
  const ear = [a, h.sockets.get('b')!].find((s) => s.sent.some((m) => m.type === 'input_audio_buffer.append'));
  assert.ok(ear, 'mic audio was forwarded to a bot');
});

test('say: to everyone, or to one bot by name (a one-on-one)', async () => {
  const h = await start();
  const c = await connect(h);
  await inCall(h, c);
  assert.deepEqual(await c.ok('say', { text: 'Morning all' }), { sent: true });
  assert.deepEqual(await c.ok('say', { text: 'just you', botId: 'b' }), { sent: true });
  assert.ok(h.sockets.get('a')!.said().includes('[Shashank (host)]: Bot B, just you'));
  await c.fails('say', { text: 'x', botId: 'c' }, /not in the call/);
  await c.fails('say', { text: '  ' }, /text is required/);
  await c.ok('say', { text: 'hi', botId: null });
});

test('add and remove bots during the call', async () => {
  const h = await start();
  const c = await connect(h);
  await inCall(h, c);
  (h as any).expect(['c']);
  await c.ok('addBot', { botId: 'c' });
  assert.deepEqual((await c.next((m) => m.t === 'view' && m.view.bots.length === 3)).view.bots.map((b: any) => b.id), ['a', 'b', 'c']);
  const gone = c.next((m) => m.t === 'view' && m.view.bots.length === 2, true);
  await c.ok('removeBot', { botId: 'b' });
  assert.deepEqual((await gone).view.bots.map((b: any) => b.id), ['a', 'c']);
  await c.fails('addBot', { botId: 'nope' }, /No Grok Bot with id nope/);
});

test('setVoice saves to Grok Bot and updates a bot in the call', async () => {
  const h = await start();
  const c = await connect(h);
  await c.ok('bots');
  assert.equal((await c.ok('setVoice', { botId: 'c', settings: { voice: 'eve' } })).bot.voice, 'eve'); // not in a call
  await inCall(h, c);
  const before = h.sockets.get('a')!.sent.length;
  assert.equal((await c.ok('setVoice', { botId: 'a', settings: { voice: 'leo' } })).bot.voice, 'leo');
  const update = h.sockets.get('a')!.sent.slice(before).find((m) => m.type === 'session.update');
  assert.equal(update.session.voice, 'leo');
  // A bot that is still connecting gets the new voice when its session starts.
  (h as any).expect(['c']);
  await c.ok('addBot', { botId: 'c' });
  await c.ok('setVoice', { botId: 'c', settings: { voice: 'rex' } });
});

test('createBot makes the bot, and can pull it straight into the call', async () => {
  const h = await start();
  const c = await connect(h);
  const bot = { name: 'Researcher', description: 'Finds things', shape: 'star', color: 'violet' };
  assert.equal((await c.ok('createBot', { bot })).bot.name, 'Researcher');
  await inCall(h, c);
  (h as any).expect(['n']);
  await c.ok('createBot', { bot: { ...bot, name: 'Second' }, addToCall: true });
  await c.next((m) => m.t === 'view' && m.view.bots.length === 3);
});

test('tasks outside a call are saved, and every mistake is explained', async () => {
  const h = await start();
  const c = await connect(h);
  assert.deepEqual(await c.ok('tasks'), { version: 0, tasks: [] });
  await c.ok('bots');
  const added = await c.ok('taskAdd', { title: 'Launch', owner: USER });
  assert.equal(added.tasks[0].owner, USER);
  assert.equal((await c.next((m) => m.t === 'tasks' && m.tasks.length === 1)).tasks[0].title, 'Launch');
  await c.ok('taskAdd', { title: 'Part', owner: 'Bot A', parent: 1 });
  await c.ok('taskAdd', { title: 'After', owner: null, waitsOn: [2] });
  const list = await c.ok('taskStatus', { id: 2, status: 'doing' });
  assert.equal(list.tasks.find((t: any) => t.id === 1).status, 'doing');
  assert.deepEqual(list.tasks.find((t: any) => t.id === 3).blockedBy, [2]);
  await c.ok('taskUnlink', { id: 3, on: 2 });
  await c.ok('taskLink', { id: 3, on: 1 });
  await c.ok('taskRemove', { id: 3 });
  const saved = new OverlayStore(path.join(h.dir)).readMemory()!;
  assert.deepEqual(saved.tasks.map((t) => t.id), [1, 2]);
  await c.fails('taskAdd', { title: 'x', owner: 'Stranger' }, /"Stranger" is not you or one of your bots/);
  await c.fails('taskAdd', { title: 'x', owner: '' }, /owner is required/);
  await c.fails('taskAdd', { title: 'x', parent: 'one' }, /parent must be a whole number/);
  await c.fails('taskAdd', { title: 'x', waitsOn: 2 }, /waitsOn must be a list/);
  await c.fails('taskAdd', { title: 'x', waitsOn: ['2'] }, /waitsOn must be a whole number/);
  await c.fails('taskAdd', { title: ' ' }, /needs a title/);
  await c.fails('taskStatus', { id: 1, status: 'later' }, /status must be one of/);
  await c.fails('taskStatus', { id: 'x', status: 'done' }, /id must be a whole number/);
  await c.fails('taskLink', { id: 2, on: 2 }, /can't wait on itself/);
  await c.fails('taskRemove', { id: 99 }, /no task #99/);
});

test('tasks during a call go through the call, so bots hear about them', async () => {
  const h = await start();
  const c = await connect(h);
  await inCall(h, c);
  await c.ok('taskAdd', { title: 'Research', owner: 'Bot B' });
  assert.ok(h.sockets.get('b')!.said().includes('[Tasks]: Shashank gave you task #1: Research'));
  assert.equal((await c.next((m) => m.t === 'tasks' && m.tasks.length === 1)).tasks[0].owner, 'Bot B');
  await c.ok('taskAdd', { title: 'Write', waitsOn: [1] });
  await c.ok('taskLink', { id: 2, on: 1 });
  await c.ok('taskUnlink', { id: 2, on: 1 });
  await c.ok('taskStatus', { id: 1, status: 'done' });
  await c.ok('taskRemove', { id: 2 });
  await c.fails('taskStatus', { id: 9, status: 'done' }, /no task #9/);
});

test('leave without anything said ends the call and saves nothing', async () => {
  const h = await start();
  const c = await connect(h);
  await inCall(h, c);
  assert.deepEqual(await c.ok('leave'), { file: null, summary: '', actionItems: [] });
  await c.next((m) => m.t === 'ended');
  assert.ok(h.sockets.get('a')!.closed);
  assert.deepEqual((await c.ok('calls')).calls, []);
});

test('leave waits for the summary, saves the call and the tasks, and the next call starts from them', async () => {
  const h = await start();
  const c = await connect(h);
  await inCall(h, c);
  const a = h.sockets.get('a')!;
  hostSays(a, 'Bot A, let us plan the launch.');
  await c.ok('taskAdd', { title: 'Draft plan', owner: 'Bot A' });
  const leaving = c.op('leave');
  await c.fails('leave', {}, /already leaving/);
  await flush();
  reply(a, '', [['save_summary', { summary: 'We planned the launch.', action_items: ['Draft the plan'] }]]);
  const r = await leaving;
  assert.equal(r.ok, true);
  assert.match(r.result.file, /^call-.*\.md$/);
  assert.equal(r.result.summary, 'We planned the launch.');
  const md = await c.ok('callFile', { file: r.result.file });
  assert.match(md.markdown, /## Tasks\n\n- \[ \] #1 Draft plan \(owner: Bot A\)/);
  assert.deepEqual((await c.ok('calls')).calls.map((x: any) => x.summary), ['We planned the launch.']);
  // The next call: Bot A is told the summary and its open task.
  h.sockets.clear();
  await inCall(h, c, ['a']);
  const ins = h.sockets.get('a')!.lastSession().instructions;
  assert.match(ins, /Your open tasks:\n- #1 Draft plan/);
  assert.match(ins, /Summary: We planned the launch\./);
});

test('a second app connection replaces the first and ends its call; closing the app ends the call too', async () => {
  const h = await start();
  const c1 = await connect(h);
  await inCall(h, c1);
  const c2 = await connect(h);
  assert.equal((await c1.closed).code, 4000);
  assert.ok(h.sockets.get('a')!.closed);
  await c2.ok('state');
  h.sockets.clear();
  await inCall(h, c2, ['b']);
  c2.ws.close();
  await c2.closed;
  for (let i = 0; i < 20 && !h.sockets.get('b')!.closed; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(h.sockets.get('b')!.closed);
});

test('closing the backend closes the app connection', async () => {
  const h = await start();
  const c = await connect(h);
  h.app.close();
  assert.equal((await c.closed).code, 1001);
  h.app.close(); // twice is fine
});

test('defaults: the real clock and Grok Bot endpoints, and real voice sockets with the secret as subprotocol', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'def'));
  const app = createOverlayServer({ dataDir: dir, token: TOKEN });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const c = new Client(`ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`);
  await c.ready();
  const hello = await c.ok('hello');
  assert.ok(hello.serverNow > 0);
  assert.equal((await c.ok('state')).state, 'signed-out');
  app.close();
  await new Promise((r) => app.server.close(r));
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const got = new Promise<string>((r) => wss.once('connection', (_ws, q) => r(String(q.headers['sec-websocket-protocol']))));
  const ws = defaultOpenSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, ['xai-client-secret.abc']);
  assert.equal(await got, 'xai-client-secret.abc');
  if (ws.readyState !== WebSocket.OPEN) await new Promise((r) => ws.once('open', r));
  ws.close();
  await new Promise((r) => wss.close(r));
});

test('a task owner is checked against the bot list even before the app asked for it', async () => {
  const h = await start();
  const c = await connect(h);
  assert.equal((await c.ok('taskAdd', { title: 'x', owner: 'Bot A' })).tasks[0].owner, 'Bot A');
});

test('the view is pushed on the default cadence', async () => {
  const h = await start(true, null);
  const c = await connect(h);
  await inCall(h, c, ['a']);
  await c.next((m) => m.t === 'view' && m.view.bots[0].status !== 'connecting');
});

test('logout forgets the sign-in, but not during a call', async () => {
  const h = await start();
  const c = await connect(h);
  await inCall(h, c, ['a']);
  await c.fails('logout', {}, /leave the call before signing out/);
  await c.ok('leave');
  assert.deepEqual(await c.ok('logout'), { state: 'signed-out', error: null });
  assert.equal(new AuthStore(h.dir).read(), null);
});
