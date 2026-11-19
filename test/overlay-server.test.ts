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
import { actionView, AUDIO_LEAD_S, createOverlayServer, logArgs, parseMeeting, parseScreenSource, SCREEN_MIN_MS, ownScreenshot, decodeMic, defaultOpenSocket, encodeBotAudio, MSG, upgradeAllowed } from '../src/overlay/server.ts';
import { OverlayStore } from '../src/overlay/store.ts';
import { FakeSocket, flush, hostSays, reply } from './overlay-fakes.ts';
import { mock, sendJson, type Mock } from './helpers.ts';
import { CallLibrary } from '../src/overlay/library.ts';

const TOKEN = 't'.repeat(40);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alotbot-srv-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SEND_TASK = { type: 'function', name: 'send_task', description: 'Send a job.', parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] } };
const agent = (id: string, name: string) => ({ id, agentId: `uuid-${id}`, name, kind: 'GROK_BOT_AGENT_KIND_AGENT', avatarShape: 'blob', avatarColor: 'blue', voiceSpeed: 1 });

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
async function start(signedIn = true, viewMs: number | null = 5, workspaceEntries: {agentId:string;body:object}[] = [], workspaceReplies: Record<string,{status?:number;body:unknown}> = {}, extra: Partial<Parameters<typeof createOverlayServer>[0]> & { prepare?: (dir: string) => void } = {}): Promise<Harness> {
  const agents = [agent('a', 'Bot A'), agent('b', 'Bot B'), agent('c', 'Bot C')];
  const jobs: { agentId: string; callId: string; request: string; at: number }[] = [];
  /** While true, agents have not answered their jobs yet. */
  let holdJobs = false;
  let minted = 0;
  const up = await mock((r, res) => {
    const method = r.url.split('/').pop()!;
    if(method in workspaceReplies){const reply=workspaceReplies[method];return sendJson(res,reply.status??200,reply.body);}
    if (method === 'SendGrokBotDraft') return sendJson(res, 200, {accepted:true});
    if (method?.startsWith('ResolveGrokBot')) return sendJson(res, 200, {});
    if (method === 'ListGrokBotAgentSkills' || method === 'ListGrokBotAgentRoutines' || method === 'ListGrokBotUserComputers' || method === 'ListGrokBotAgentFiles' || method === 'ListGrokBotUserStoreFiles') return sendJson(res, 200, {});
    if (method === 'ListGrokBotAgents') return sendJson(res, 200, { agents });
    if (method === 'VoiceCallHarnessSession') return sendJson(res, 200, { instructions: `I am ${r.body.agentName}.`, tools: [SEND_TASK] });
    if (method === 'VoiceCallHarnessTool' && r.body.input.request === 'break') return sendJson(res, 500, { message: 'tool broke' });
    if (method === 'VoiceCallHarnessTool') {
      if (/^(post|relay) /.test(String(r.body.input.request))) jobs.push({ agentId: r.body.agentId, callId: r.body.callId, request: r.body.input.request, at: Date.now() });
      // "relay ..." jobs are accepted the way Grok Bot accepts background work, so they stay under way until answered.
      const relay = /^relay /.test(String(r.body.input.request)) ? { relay: 'accepted' } : {};
      return sendJson(res, 200, { kind: 'VOICE_CALL_HARNESS_TOOL_OUTCOME_KIND_SERVED', output: { queued: r.body.input.request, ...relay } });
    }
    if (method === 'ListGrokBotTranscriptEntries') {
      // The agent answers each job on the call's channel, as Grok Bot does.
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64');
      const entries = jobs.filter((j) => j.agentId === r.body.agentId && !holdJobs).flatMap((j, i) => [
        { seq: String(2 * i + 2), body: b64({ kind: 'send-message', requestId: `req-${i}`, message: { type: 'text', content: `Done: ${j.request}`, channel: `voice:${j.callId}` }, timestampMs: j.at }) },
        { seq: String(2 * i + 1), body: b64({ kind: 'message', role: 'user', content: j.request, channel: `voice:${j.callId}`, channelSender: 'the call', requestId: `req-${i}`, timestampMs: j.at }) },
      ]);
      return sendJson(res, 200, { entries: [...entries, ...workspaceEntries.filter(e=>e.agentId===r.body.agentId).map((e,i)=>({seq:String(1000+i),body:b64(e.body)}))] });
    }
    // Like Grok Bot: one URL for every session, a new secret each time.
    if (method === 'MintSandVoiceCallSecret') return sendJson(res, 200, { clientSecret: `secret-${++minted}`, model: 'm', websocketUrl: 'wss://voice.test/rt' });
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
  const { prepare, ...more } = extra;
  prepare?.(dir);
  const sockets = new Map<string, FakeSocket>();
  let mintFor: string[] = [];
  let now = 100;
  const app = createOverlayServer({
    dataDir: dir,
    token: TOKEN,
    apiUrl: up.url,
    fetch:async(url,options)=>fetch(String(url).replace('https://workspace.test',up.url),options),
    siteUrl: 'https://site.test',
    pollMs: 60_000,
    clock: () => now,
    ...(viewMs === null ? {} : { viewMs }),
    ...more,
    // Each bot's socket is keyed by the order the call asked for voice sessions.
    openSocket: (url: string) => {
      const ws = new FakeSocket(url);
      const id = mintFor.shift() ?? `x${sockets.size}`;
      sockets.set(id, ws);
      return ws;
    },
  });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address() as AddressInfo;
  const h: Harness = { url: `ws://127.0.0.1:${port}/ws`, up, dir, sockets, app, agents, clockAt: (s) => (now = s) };
  (h as any).expect = (ids: string[]) => (mintFor = [...ids]);
  (h as any).holdJobs = (v: boolean) => (holdJobs = v);
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
/** Waits until a bot was asked for the call summary: a leave request crosses a real socket first. */
async function askedForSummary(s: FakeSocket) {
  const asked = () => s.sent.some((m: any) => m.type === 'response.create' && /ending this group voice call/.test(m.response?.instructions ?? ''));
  for (let i = 0; i < 400 && !asked(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(asked(), 'asked for the summary');
}

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

test("a bot's own Grok Bot tools run through Grok Bot during the call", async () => {
  const h = await start();
  const c = await connect(h);
  await inCall(h, c);
  const a = h.sockets.get('a')!;
  const update = a.sent.find((m) => m.type === 'session.update');
  assert.ok(update.session.tools.some((t: any) => t.name === 'send_task'), 'the bot was given send_task');
  reply(a, 'On it.', [['send_task', { request: 'Draft the launch post' }]]);
  for (let i = 0; i < 40 && !a.outputs().length; i++) await new Promise((r) => setTimeout(r, 5));
  const sent = h.up.requests.find((r) => r.url.endsWith('/VoiceCallHarnessTool'));
  assert.ok(sent, 'the tool call went to Grok Bot');
  assert.equal(sent.body.agentId, 'a');
  assert.equal(sent.body.name, 'send_task');
  assert.deepEqual(sent.body.input, { request: 'Draft the launch post' });
  assert.deepEqual(JSON.parse(a.outputs()[0]), { queued: 'Draft the launch post' });
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

test('a bot made during a call: the bots in the call expect its name and can invite it', async () => {
  const h = await start();
  const c = await connect(h);
  await inCall(h, c);
  await c.ok('createBot', { bot: { name: 'Researcher', description: 'Finds things', shape: 'star', color: 'violet' } });
  const sent = h.sockets.get('a')!.sent.map((x: any) => (typeof x === 'string' ? JSON.parse(x) : x));
  const names = sent.filter((m: any) => m.session?.audio?.input?.transcription).at(-1).session.audio.input.transcription.keyterms;
  assert.ok(names.includes('Researcher'), names.join(', '));
  assert.match(sent.filter((m: any) => m.session?.instructions).at(-1).session.instructions, /Researcher/);
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

test('every call writes a live log: each bot\'s voice traffic, tools, app requests, mic, and the saved call points to it', async () => {
  const h = await start();
  const c = await connect(h);
  await inCall(h, c);
  const a = h.sockets.get('a')!;
  const b = h.sockets.get('b')!;
  a.emit('response.output_audio_transcript.delta', { delta: 'On' }); // word-by-word text is left out
  reply(a, 'On it.', [['send_task', { request: 'Draft the launch post' }]]);
  for (let i = 0; i < 40 && !a.outputs().length; i++) await new Promise((r) => setTimeout(r, 5));
  reply(a, 'Trying again.', [['send_task', { request: 'break' }]]);
  for (let i = 0; i < 40 && a.outputs().length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  hostSays(a, 'Bot B, plan the launch.');
  const frame = Buffer.alloc(5 + 4);
  frame[0] = MSG.mic;
  frame.writeFloatLE(0.3, 1);
  c.ws.send(frame);
  await new Promise((r) => setTimeout(r, 1050)); // the mic is summed up once a second
  c.ws.send(frame);
  await c.fails('connections', { action: 'install', id: 'private', values: { SECRET: 'setup-secret-never-log' } }, /Grok/);
  await c.ok('connections', { action: 'authStatus' });
  await c.fails('addBot', { botId: 'zzz' }, /No Grok Bot/);
  (b.onclose as any)({ code: 1006, reason: 'gone' });
  (b.onerror as any)({ message: 'reset' });
  const leaving = c.op('leave');
  await askedForSummary(a);
  reply(a, '', [['save_summary', { summary: 'Planned it.', action_items: [] }]]);
  const r = await leaving;
  const logs = fs.readdirSync(path.join(h.dir, 'logs'));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^call-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.jsonl$/);
  const file = path.join(h.dir, 'logs', logs[0]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'only this user can read it');
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /secret-\d|setup-secret-never-log/, 'voice and connection setup secrets are never logged');
  assert.match(raw, /Connection command failed/);
  const entries = raw.trim().split('\n').map((l) => JSON.parse(l));
  for (const e of entries) assert.ok(typeof e.at === 'string' && typeof e.ms === 'number' && typeof e.kind === 'string');
  const has = (pred: (e: any) => boolean, what: string) => assert.ok(entries.some(pred), what);
  has((e) => e.kind === 'join' && e.bots.join() === 'Bot A,Bot B', 'join');
  has((e) => e.kind === 'voice-connect' && e.bot === 'Bot A', 'Bot A socket');
  has((e) => e.kind === 'voice-open' && e.bot === 'Bot B', 'Bot B socket open');
  has((e) => e.kind === 'voice' && e.dir === 'out' && e.bot === 'Bot A' && e.msg.type === 'session.update', 'setup sent to Bot A');
  has((e) => e.kind === 'voice' && e.dir === 'in' && e.bot === 'Bot A' && e.msg.type === 'response.function_call_arguments.done' && e.msg.name === 'send_task', 'tool call from Bot A');
  has((e) => e.kind === 'voice' && e.dir === 'in' && e.bot === 'Bot A' && e.msg.type === 'conversation.item.input_audio_transcription.completed', 'host words heard by Bot A');
  has((e) => e.kind === 'voice' && e.dir === 'out' && e.bot === 'Bot B' && e.msg.type === 'response.create', 'Bot B asked to answer');
  has((e) => e.kind === 'grok-tool' && e.bot === 'Bot A' && e.req.name === 'send_task', 'Grok Bot tool request');
  has((e) => e.kind === 'grok-tool-result' && e.bot === 'Bot A', 'Grok Bot tool result');
  has((e) => e.kind === 'grok-tool-failed' && e.bot === 'Bot A' && /tool broke/.test(e.error), 'Grok Bot tool failure');
  has((e) => e.kind === 'event' && e.event === 'host' && /plan the launch/.test(e.text), 'timeline event');
  has((e) => e.kind === 'mic' && e.frames === 2 && e.avg === 0.3 && e.max === 0.3 && typeof e.botPlaying === 'boolean' && 'ear' in e, 'mic summary');
  has((e) => e.kind === 'app' && e.op === 'addBot' && !('op' in e.args) && !('req' in e.args), 'app request, with only its arguments');
  has((e) => e.kind === 'voice-close' && e.bot === 'Bot A', 'leaving closes the sockets, before the log ends');
  has((e) => e.kind === 'app-error' && e.op === 'addBot' && /No Grok Bot/.test(e.error), 'failed app request');
  has((e) => e.kind === 'voice-closed' && e.bot === 'Bot B' && e.code === 1006 && e.reason === 'gone', 'socket close code');
  has((e) => e.kind === 'voice-error' && e.bot === 'Bot B' && e.error === 'reset', 'socket error');
  has((e) => e.kind === 'saved' && e.file === r.result.file && e.logFile === logs[0], 'saved');
  assert.equal(entries.at(-1).kind, 'end');
  assert.ok(!entries.some((e) => e.kind === 'voice' && /delta|input_audio_buffer\.append/.test(e.msg?.type ?? '')), 'no audio or partial text');
  const md = (await c.ok('callFile', { file: r.result.file })).markdown;
  assert.match(md, /## Timeline\n\n- 0:00 /);
  assert.ok(md.includes(`Full log: \`logs/${logs[0]}\``));
  // Once the call is over nothing more is written to it.
  c.ws.send(frame);
  await c.ok('state');
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('the mic summary still comes when no bot is hearing the host (every bot left)', async () => {
  const h = await start();
  const c = await connect(h);
  await inCall(h, c);
  await c.ok('removeBot', { botId: 'a' });
  await c.ok('removeBot', { botId: 'b' });
  const frame = Buffer.alloc(5 + 4);
  frame[0] = MSG.mic;
  frame.writeFloatLE(0.1, 1);
  c.ws.send(frame);
  await new Promise((r) => setTimeout(r, 1050));
  c.ws.send(frame);
  await c.ok('leave');
  const dir = path.join(h.dir, 'logs');
  const entries = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(entries.some((e) => e.kind === 'mic' && e.ear === null && e.botPlaying === false));
});

test('leave without anything said ends the call and saves nothing', async () => {
  const h = await start();
  const c = await connect(h);
  await inCall(h, c);
  assert.deepEqual(await c.ok('leave'), { file: null, id: null, summary: '', decisions: [], actionItems: [] });
  await c.next((m) => m.t === 'ended');
  assert.ok(h.sockets.get('a')!.closed);
  assert.deepEqual((await c.ok('calls')).calls, []);
});

test('leave still ends the call when saving it fails, so a new call can start', async () => {
  const h = await start();
  const c = await connect(h);
  await inCall(h, c, ['a']);
  const a = h.sockets.get('a')!;
  hostSays(a, 'Bot A, let us plan the launch.');
  await flush();
  fs.writeFileSync(path.join(h.dir, 'calls'), 'x'); // calls/ can't be made, so saving throws
  const leaving = c.op('leave');
  await askedForSummary(a);
  reply(a, '', [['save_summary', { summary: 'S', action_items: [] }]]);
  const r = await leaving;
  assert.equal(r.ok, false);
  await c.next((m) => m.t === 'ended');
  assert.ok(a.closed);
  await c.fails('leave', {}, /not in a call/);
  fs.rmSync(path.join(h.dir, 'calls'));
  h.sockets.clear();
  await inCall(h, c, ['a']);
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
  // Stop and mute while leaving do nothing, and are not errors: the bots are already quiet and the mic is off.
  assert.equal(await c.ok('stop'), null);
  assert.equal(await c.ok('mute', { muted: true }), null);
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

test('a job\'s answer from the agent reaches the bot on the call, and is logged', async () => {
  const h = await start();
  const c = await connect(h);
  await inCall(h, c);
  const a = h.sockets.get('a')!;
  reply(a, 'On it.', [['send_task', { request: 'post the comment' }]]);
  for (let i = 0; i < 40 && !a.outputs().length; i++) await new Promise((r) => setTimeout(r, 5));
  // The first check is LANDED_POLL_MS after the job.
  for (let i = 0; i < 100 && !a.sent.some((m: any) => m.type === 'async_update.add' && m.async_update.payload[0].message.content === 'Done: post the comment'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(a.sent.some((m: any) => m.type === 'async_update.add' && m.async_update.payload[0].message.content === 'Done: post the comment'), 'Bot A heard its agent');
  assert.ok(!h.sockets.get('b')!.said().some((t) => t.startsWith('[Work landed]')));
  const leaving = c.op('leave');
  await askedForSummary(a);
  reply(a, '', [['save_summary', { summary: 'Posted.', action_items: [] }]]);
  await leaving;
  const logs = fs.readdirSync(path.join(h.dir, 'logs'));
  const entries = fs.readFileSync(path.join(h.dir, 'logs', logs[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(entries.some((e) => e.kind === 'landed' && e.bot === 'Bot A' && e.work[0].text === 'Done: post the comment'), 'logged');
  assert.ok(entries.some((e) => e.kind === 'event' && e.event === 'task' && e.text === "Bot A's agent: Done: post the comment"), 'on the timeline');
});

test('native file tools are recorded before dispatch, return to voice, and survive reopening history', async () => {
  const h = await start(); const c = await connect(h); await inCall(h, c);
  const a = h.sockets.get('a')!;
  assert.ok(a.lastSession().tools.some((t: any) => t.name === 'mac_files'));
  reply(a, '', [['mac_files', { operation: 'read', path: 'proof.txt' }]]);
  const command = await c.next((m) => m.t === 'localTool');
  const during = await c.ok('actions');
  const action = during.actions.find((r: any) => r.tool === 'mac_files');
  assert.equal(action.status, 'running'); assert.equal(action.target, 'mac');
  assert.equal(action.result, undefined, 'lists do not transport the full result');
  await c.ok('localResult', { id: command.id, text: 'nonce-from-this-mac' });
  const detail = await c.ok('action', { id: action.id });
  assert.equal(detail.action.status, 'completed'); assert.match(detail.action.result, /nonce-from-this-mac/);
  await c.fails('localResult', { id: command.id, text: 'duplicate' }, /expired/);
  await c.fails('resolveApproval', { id: action.id, decision: 'approve' }, /pending/);
  await c.fails('resolveApproval', { id: action.id, decision: 'always' }, /decision/);
  reply(a, '', [['mac_files', { operation: 'read', path: 123 }]]);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(c.msgs.filter((m) => m.t === 'localTool').length, 1, 'invalid arguments never reach native executor');
  await c.ok('localConfig', { browser: true });
  await c.ok('localConfig', { browser: false });
  assert.equal((await c.ok('action', { id: 'missing' })).action, null);
});

test('disconnecting while a native action runs marks its outcome unknown', async () => {
  const h = await start(); const c = await connect(h); await inCall(h, c);
  reply(h.sockets.get('a')!, '', [['mac_window', { operation: 'inspect' }]]);
  await c.next((m) => m.t === 'localTool');
  c.ws.close(); await c.closed;
  await new Promise((r) => setTimeout(r, 25));
  const { ActionStore } = await import('../src/actions.ts');
  const reopened = new ActionStore(h.dir);
  assert.equal(reopened.list().find((a) => a.tool === 'mac_window')!.status, 'unknown');
  reopened.close();
});


test('approval buttons and voice tools resolve only the exact pending action for that bot', async () => {
  const h = await start(); const c = await connect(h); await inCall(h, c);
  const { ActionStore } = await import('../src/actions.ts');
  const store = new ActionStore(h.dir);
  const make = (botId = 'a') => {
    const a = store.create({ callId: 'call', botId, botName: 'Bot', target: 'agent', tool: 'send_task', input: {} });
    store.update(a.id, { status: 'waiting_approval', approval: { kind: 'auto_review', requestId: `approval-${a.id}`, entryId: 'entry', summary: 'Read verification file', status: 'pending' } });
    return a;
  };
  const button = make();
  assert.equal((await c.ok('resolveApproval', { id: button.id, decision: 'approve' })).action.approval.status, 'approved');
  assert.equal(h.up.requests.filter((r) => r.url.endsWith('ResolveGrokBotAutoReviewApproval')).length, 1);
  await c.fails('resolveApproval', { id: button.id, decision: 'deny' }, /pending/);
  const a = h.sockets.get('a')!;
  reply(a, '', [['list_call_actions', {}]]);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(a.outputs().some((o) => o.includes(button.id)));
  const other = make('b');
  reply(a, '', [['resolve_call_approval', { id: other.id, decision: 'approve' }]]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.get(other.id)!.approval!.status, 'pending', 'cannot approve another bot’s action');
  const voice = make();
  reply(a, '', [['resolve_call_approval', { id: voice.id, decision: 'deny' }]]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.get(voice.id)!.approval!.status, 'denied');
  assert.deepEqual(await c.ok('botResources', { botId: 'a' }), { text: JSON.stringify({ skills: [], routines: [], files: [] }, null, 2) });
  reply(a, '', [['mac_browser', { operation: 'inspect' }]]);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(a.outputs().some((o) => /Enable the dedicated browser/.test(o)));
  store.close();
});

test('a native timeout is outcome unknown, and late results cannot turn it into success', async () => {
  const h = await start(); const c = await connect(h); await inCall(h, c);
  reply(h.sockets.get('a')!, '', [['mac_window', { operation: 'press', control: 'old-control' }]]);
  const command = await c.next((m) => m.t === 'localTool');
  await new Promise((r) => setTimeout(r, 15_100));
  const rows = (await c.ok('actions')).actions;
  assert.equal(rows.find((a: any) => a.tool === 'mac_window').status, 'unknown');
  await c.fails('localResult', { id: command.id, text: 'late' }, /expired/);
});

test('native errors are recorded as failures; a watcher outage is logged and retried', async () => {
  const h = await start(); const c = await connect(h); await inCall(h, c);
  const a = h.sockets.get('a')!;
  reply(a, '', [['mac_files', { operation: 'read', path: 'missing' }]]);
  const command = await c.next((m) => m.t === 'localTool');
  await c.ok('localResult', { id: command.id, error: 'Folder access denied' });
  assert.equal((await c.ok('actions')).actions.find((a: any) => a.tool === 'mac_files').status, 'failed');
  reply(a, '', [['mac_files', { operation: 'list', path: '.' }]]);
  const next = await c.next((m) => m.t === 'localTool' && m.id !== command.id);
  await c.ok('localResult', { id: next.id });
  await h.up.close();
  await new Promise((r) => setTimeout(r, 3100));
  const logs = fs.readdirSync(path.join(h.dir, 'logs'));
  const text = fs.readFileSync(path.join(h.dir, 'logs', logs[0]), 'utf8');
  assert.match(text, /jobs-error/);
});

test('the enabled desktop browser executes through the call and records its verified page state', async () => {
  const h = await start(); const c = await connect(h); await inCall(h, c);
  await c.ok('localConfig', { browser: true });
  const a = h.sockets.get('a')!;
  reply(a, '', [['mac_browser', { operation: 'inspect' }]]);
  for (let i = 0; i < 200 && !a.outputs().some((o) => o.includes('about:blank')); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(a.outputs().some((o) => o.includes('about:blank')));
  assert.equal((await c.ok('actions')).actions.find((a: any) => a.tool === 'mac_browser').status, 'completed');
  await c.ok('localConfig', { browser: false });
});

test('background observation is routed to the Mac with a screen action and invalid scopes are refused', async () => {
  const h = await start(); const c = await connect(h); await inCall(h, c);
  const a = h.sockets.get('a')!;
  assert.ok(a.lastSession().tools.some((t: any) => t.name === 'mac_observe'));
  reply(a, '', [['mac_observe', { operation: 'read', app: 'Zen', title: 'YouTube', windowId: 12 }]]);
  const command = await c.next((m) => m.t === 'localTool');
  assert.deepEqual(command.input, { operation: 'read', app: 'Zen', title: 'YouTube', windowId: 12 });
  const action = (await c.ok('actions')).actions.find((r: any) => r.tool === 'mac_observe');
  assert.equal(action.target, 'screen');
  await c.ok('localResult', { id: command.id, text: '{"status":"ambiguous","windows":[{"id":12},{"id":13}]}' });
  assert.equal((await c.ok('action', { id: action.id })).action.status, 'completed');
  reply(a, '', [['mac_observe', { operation: 'read', app: 'Zen', windowId: -1 }]]);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(c.msgs.filter((m) => m.t === 'localTool').length, 1);
});

test('user readiness leads to a fresh observation instead of replaying a blocked page result', async () => {
  const h = await start(); const c = await connect(h); await inCall(h, c);
  const a = h.sockets.get('a')!;
  const input = { operation: 'read', app: 'Zen', title: 'YouTube' };
  reply(a, '', [['mac_observe', input]]);
  const first = await c.next((m) => m.t === 'localTool');
  await c.ok('localResult', { id: first.id, text: '{"status":"not_found","note":"Select YouTube in Zen, then tell me when it is ready."}' });
  for (let i = 0; i < 100 && !a.outputs().some((o) => o.includes('not_found')); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(a.outputs().some((o) => o.includes('not_found')));
  reply(a, 'Select YouTube in Zen and tell me when it is ready.');
  await c.ok('say', { text: "It's ready now" });
  reply(a, '', [['mac_observe', input]]);
  const second = await c.next((m) => m.t === 'localTool' && m.id !== first.id);
  assert.notEqual(second.id, first.id);
  await c.ok('localResult', { id: second.id, text: '{"status":"captured","text":"Fresh verification phrase: cobalt orchard nine"}' });
  for (let i = 0; i < 100 && !a.outputs().some((o) => o.includes('cobalt orchard nine')); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(a.outputs().some((o) => o.includes('cobalt orchard nine')));
  assert.equal((await c.ok('actions')).actions.filter((x: any) => x.tool === 'mac_observe').length, 2);
  assert.equal(c.msgs.filter((m) => m.t === 'localTool').length, 2);
});

test('viewing tools require a capture operation instead of allowing metadata-only sight claims', async () => {
  const h = await start(); const c = await connect(h); await inCall(h, c);
  const a = h.sockets.get('a')!;
  reply(a, '', [['mac_observe', { operation: 'list', app: 'Zen' }]]);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(c.msgs.filter((m) => m.t === 'localTool').length, 0, 'metadata-only operation must not be offered to the voice bot');
  reply(a, '', [['mac_observe', { operation: 'read_all', app: 'Zen' }]]);
  const command = await c.next((m) => m.t === 'localTool');
  assert.equal(command.input.operation, 'read_all');
  await c.ok('localResult', { id: command.id, text: '{"status":"read_all","capturedCount":1,"windows":[{"status":"captured","text":"Actual background page"}]}' });
});

test('workspace draft submissions persist redacted receipts and cannot be replayed from another UI request',async()=>{
 const body={id:'draft-entry',sessionId:'session',kind:'send-message',message:{type:'email-draft',draft:{from:'sender@test.invalid',to:['recipient@test.invalid'],subject:'Review',body:'Original'}}};
 const h=await start(true,5,[{agentId:'uuid-a',body}]);const c=await connect(h);await inCall(h,c);
 const resources=await c.ok('workspace',{botId:'a',action:'resources'});assert.equal(resources.bot.agentId,'uuid-a');
 const revision=(await c.ok('workspace',{botId:'a',action:'activity'})).cards[0].draft.revision;
 await c.fails('workspace',{botId:'b',action:'draftSend',id:'draft-entry',sessionId:'session',body:'PRIVATE-DRAFT',revision},/changed|editable/);
 await c.ok('workspace',{botId:'a',action:'draftSend',id:'draft-entry',sessionId:'session',body:'PRIVATE-DRAFT',revision});
 await c.fails('workspace',{botId:'a',action:'draftSend',id:'draft-entry',sessionId:'session',body:'PRIVATE-DRAFT',revision},/already submitted/);
 assert.equal(h.up.requests.filter(r=>r.url.endsWith('/SendGrokBotDraft')).length,1);
 const actions=(await c.ok('actions')).actions;
 const receipt=actions.find((a:any)=>a.tool==='draftSend'&&a.botId==='a');assert.equal(receipt.status,'completed');
 assert.doesNotMatch(JSON.stringify((await c.ok('action',{id:receipt.id})).action),/PRIVATE-DRAFT/);
 const text=fs.readdirSync(path.join(h.dir,'logs')).map(name=>fs.readFileSync(path.join(h.dir,'logs',name),'utf8')).join('\n');assert.doesNotMatch(text,/PRIVATE-DRAFT/);
 const activity=await c.ok('workspace',{botId:'a',action:'activity'});assert.equal(activity.cards[0].id,'draft-entry');
 await c.fails('workspace',{botId:'a',action:'computerViewState',viewerId:'unknown'},/closed/);
 await c.fails('workspace',{botId:'a',action:'computerClose',viewerId:'unknown'},/closed/);
 await c.fails('workspace',{botId:'a',action:'computerControl',viewerId:'unknown',enabled:true},/closed/);
});

test('workspace events, viewer assets, saved activity and uncertain mutations survive transport and account lifecycle changes',async()=>{
 const replies:Record<string,{status?:number;body:unknown}>={
  GetSandBoxRunState:{body:{state:'SAND_BOX_RUN_STATE_RUNNING'}},EnsureSandBox:{body:{gatewayUrl:'https://workspace.test',gatewayToken:'gateway',vncUrl:'https://workspace.test/vnc.html'}},
  getAgentAutomations:{body:[]},getForeverBoxStatus:{body:{state:'running',vncUrl:'https://workspace.test/vnc.html',windows:[{subagentId:'screen',vncUrl:'https://workspace.test/vnc.html'}]}},
  ensureForeverBox:{body:{state:'running',vncUrl:'https://workspace.test/vnc.html',windows:[{subagentId:'screen',vncUrl:'https://workspace.test/vnc.html'}]}},events:{body:'data: changed\n\n'},'vnc.html':{body:'viewer'},
  ListGrokBotAgentAutomations:{body:{}},AddGrokBotAgentSkill:{body:{accepted:true}},
 };
 const h=await start(true,5,[{agentId:'uuid-a',body:{id:'entry',message:{type:'text',content:'Private result'}}}],replies),c=await connect(h);
 await c.ok('workspace',{botId:'a',action:'resources'});await c.next(m=>m.t==='workspaceChanged');
 await c.ok('workspace',{botId:'a',action:'activity'});
 replies.ListGrokBotTranscriptEntries={status:503,body:{message:'Offline'}};
 const offline=await c.ok('workspace',{botId:'a',action:'activity'});assert.equal(offline.stale,true);assert.equal(offline.cards[0].text,'');
 delete replies.ListGrokBotTranscriptEntries;
 const viewer=await c.ok('workspace',{botId:'a',action:'computerOpen',monitor:'screen'});
 const response=await fetch(viewer.url,{headers:{authorization:viewer.authorization}});assert.equal(response.status,200);assert.equal(await response.text(),'viewer');
 assert.equal((await c.ok('workspace',{botId:'a',action:'computerViewState',viewerId:viewer.id})).hasControl,false);
 await c.ok('workspace',{botId:'a',action:'computerClose',viewerId:viewer.id});
 const other=await c.ok('workspace',{botId:'a',action:'computerOpen'});
 const bad=new WebSocket(other.url.replace('http:','ws:').replace(/vnc.html.*/, 'socket'),{origin:'https://evil.test',headers:{authorization:other.authorization}});
 await new Promise<void>(resolve=>{bad.once('error',()=>resolve());});bad.terminate();
 await c.ok('workspace',{botId:'a',action:'skillCreate',name:'Test',content:'Instructions'});
 replies.AddGrokBotAgentSkill={status:503,body:{message:'Outcome unknown'}};
 await c.fails('workspace',{botId:'a',action:'skillCreate',name:'Test',content:'Instructions'},/Outcome unknown/);
 const actions=(await c.ok('actions')).actions;assert.ok(actions.some((a:any)=>a.tool==='skillCreate'&&a.status==='unknown'&&a.callId==='workspace'));
 await c.ok('logout');
 new AuthStore(h.dir).write({accessToken:'tok',refreshToken:null,machineId:'mid'});
 await c.ok('workspace',{botId:'a',action:'resources'});
 await c.ok('workspace',{botId:'a',action:'activity'});
 const reopened=await c.ok('workspace',{botId:'a',action:'computerOpen'});await c.ok('workspace',{botId:'a',action:'computerClose',viewerId:reopened.id});
});

test('malformed HTTP viewer targets close the request without exposing a transport exception',async()=>{
 const h=await start(),c=await connect(h);await c.ok('bots');
 const {request}=await import('node:http');const origin=new URL(h.url);origin.protocol='http:';
 await assert.rejects(new Promise<void>((resolve,reject)=>{const req=request(origin,{path:'http://'},res=>{res.resume();res.once('end',()=>resolve());});req.once('error',reject);req.end();}),/socket hang up|ECONNRESET/);
});

// ---------- the call library ----------


/** Joins, has Bot A answer, and leaves with a summary and decisions. Returns the leave result. */
async function callAndLeave(h: Harness, c: Client, said: string, summary: string, decisions: string[] = []) {
  h.sockets.clear();
  await inCall(h, c, ['a']);
  const a = h.sockets.get('a')!;
  hostSays(a, said);
  reply(a, 'Sounds good.');
  const leaving = c.op('leave');
  await askedForSummary(a);
  reply(a, '', [['save_summary', { summary, action_items: ['Email Sam'], decisions }]]);
  const r = await leaving;
  assert.equal(r.ok, true, r.error);
  return r.result;
}

test('leaving indexes the call: the library lists it, searches it, opens it and the bots can recall it', async () => {
  const h = await start();
  const c = await connect(h);
  assert.deepEqual(await c.ok('library'), { calls: [], hasMore: false, total: 0 });
  const first = await callAndLeave(h, c, 'Bot A, what should the price be?', 'We set the price at ten dollars.', ['Price is $10']);
  assert.match(first.id, /^call-.*Z(-\d+)?$/);
  assert.equal(`${first.id}.md`, first.file);
  assert.deepEqual(first.decisions, ['Price is $10']);
  const md = await c.ok('callFile', { file: first.file });
  assert.match(md.markdown, /## Decisions\n\n- Price is \$10\n/);
  const listed = await c.ok('library');
  assert.equal(listed.total, 1);
  assert.deepEqual(listed.calls.map((x: any) => [x.id, x.kind, x.summary, x.decisions, x.lineCount]), [[first.id, 'call', 'We set the price at ten dollars.', ['Price is $10'], 2]]);
  const found = await c.ok('library', { query: 'price', limit: 5, kind: 'call' });
  assert.match(found.calls[0].match.snippet, /«price»/i);
  assert.deepEqual((await c.ok('library', { query: 'zebra', before: Date.now() + 1000, kind: null, limit: null })).calls, []);
  const opened = await c.ok('libraryCall', { id: first.id });
  assert.deepEqual(opened.lines.map((l: any) => [l.who, l.text]), [[USER, 'Bot A, what should the price be?'], ['Bot A', 'Sounds good.']]);
  assert.match(opened.markdown, /^# Alotbot/);
  // The next call's bots are told about it, and recall_calls finds it.
  h.sockets.clear();
  await inCall(h, c, ['a']);
  const a = h.sockets.get('a')!;
  assert.match(a.lastSession().instructions, /There is 1 saved earlier call with/);
  reply(a, '', [['recall_calls', { query: 'price' }]]);
  assert.match(a.outputs().at(-1)!, new RegExp(`\\[id ${first.id}\\]`));
  await c.ok('leave');
});

test('library requests check their arguments', async () => {
  const h = await start();
  const c = await connect(h);
  await c.fails('library', { query: 5 }, /query must be text/);
  await c.fails('library', { kind: 'party' }, /kind must be call or meeting/);
  await c.fails('library', { before: 1, beforeId: 5 }, /beforeId/);
  assert.deepEqual((await c.ok('library', { before: Date.now(), beforeId: 'call-x' })).calls, []);
  await c.fails('library', { limit: 'ten' }, /limit must be a whole number/);
  await c.fails('library', { before: 1.5 }, /before must be a whole number/);
  await c.fails('libraryCall', {}, /id is required/);
  await c.fails('libraryCall', { id: '../../secrets' }, /not in your call history/);
  await c.fails('libraryCall', { id: 'call-2020-01-01T00-00-00Z' }, /not in your call history/);
  await c.fails('libraryDelete', { id: 'call-2020-01-01T00-00-00Z' }, /not in your call history/);
  await c.fails('join', { botIds: ['a'], continueFrom: 'call-2020-01-01T00-00-00Z' }, /not in your call history/);
  await c.fails('join', { botIds: ['a'], continueFrom: 7 }, /continueFrom is required/);
});

test('continuing a saved call: the bots start from its summary and decisions', async () => {
  const h = await start();
  const c = await connect(h);
  const first = await callAndLeave(h, c, 'Bot A, launch date?', 'We picked May for the launch.', ['Launch in May']);
  h.sockets.clear();
  (h as any).expect(['b']);
  await c.ok('join', { botIds: ['b'], continueFrom: first.id });
  for (let i = 0; i < 20 && !h.sockets.get('b'); i++) await new Promise((r) => setTimeout(r, 5));
  const b = h.sockets.get('b')!;
  b.onopen!();
  b.emit('session.updated');
  assert.match(b.lastSession().instructions, new RegExp(`# This call continues an earlier call \\(.*, id ${first.id}\\)\\nSummary: We picked May for the launch\\.\\nDecisions:\\n- Launch in May`));
  // The call being continued is left out of searches (it is already in the instructions).
  reply(b, '', [['recall_calls', { query: 'launch' }]]);
  assert.match(b.outputs().at(-1)!, /Nothing in earlier calls matches "launch"/);
  await c.ok('leave');
});

test('deleting a call removes its file and index entry, and the next call no longer starts from its summary', async () => {
  const h = await start();
  const c = await connect(h);
  const first = await callAndLeave(h, c, 'Bot A, budget?', 'Budget is fifty thousand.');
  const second = await callAndLeave(h, c, 'Bot A, hiring?', 'Hire two engineers.');
  assert.equal(new OverlayStore(h.dir).readMemory()!.summary, 'Hire two engineers.');
  // Deleting an older call keeps the memory, which came from the newer one.
  assert.deepEqual(await c.ok('libraryDelete', { id: first.id }), { deleted: first.id });
  assert.equal(fs.existsSync(path.join(h.dir, 'calls', first.file)), false);
  assert.equal(new OverlayStore(h.dir).readMemory()!.summary, 'Hire two engineers.');
  // Deleting the call the memory came from forgets its summary, and keeps the open tasks.
  await c.ok('taskAdd', { title: 'Keep me' });
  await c.ok('libraryDelete', { id: second.id });
  const memory = new OverlayStore(h.dir).readMemory()!;
  assert.equal(memory.summary, '');
  assert.ok(memory.tasks.some((t) => t.title === 'Keep me'));
  assert.equal((await c.ok('library')).total, 0);
  assert.deepEqual((await c.ok('calls')).calls, []);
});

test('the library is rebuilt from the saved files at start; a file removed by hand still opens from the index', async () => {
  const md = '# Alotbot, T\n\nBots: Bot A  \nLength: 1 min\n\n## Summary\n\nOld pricing call.\n\n## Transcript\n\n**Bot A:** ten dollars  \n';
  const h = await start(true, 5, [], {}, {
    prepare: (dir) => {
      fs.mkdirSync(path.join(dir, 'calls'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'calls', 'call-2026-01-02T03-04-05Z.md'), md);
    },
  });
  const c = await connect(h);
  const listed = await c.ok('library', { query: 'pricing' });
  assert.deepEqual(listed.calls.map((x: any) => x.id), ['call-2026-01-02T03-04-05Z']);
  fs.rmSync(path.join(h.dir, 'calls', 'call-2026-01-02T03-04-05Z.md'));
  const opened = await c.ok('libraryCall', { id: 'call-2026-01-02T03-04-05Z' });
  assert.equal(opened.markdown, null);
  assert.equal(opened.call.summary, 'Old pricing call.');
});

test('without a working library, calls still save and end; history search says why it is unavailable', async () => {
  const h = await start(true, 5, [], {}, { openLibrary: () => { throw new Error('disk I/O error'); } });
  const c = await connect(h);
  await c.fails('library', {}, /Call history search is unavailable: disk I\/O error/);
  await c.fails('libraryCall', { id: 'call-2026-01-02T03-04-05Z' }, /unavailable/);
  const r = await callAndLeave(h, c, 'Bot A, hi', 'Said hi.');
  assert.match(r.file, /^call-/);
  assert.ok(!h.sockets.get('a')!.lastSession().tools.some((t: any) => t.name === 'recall_calls'));
});

test('a call whose indexing fails is still saved, and the failure is logged', async () => {
  class Broken extends CallLibrary {
    index(): string {
      throw new Error('database is locked');
    }
  }
  const h = await start(true, 5, [], {}, { openLibrary: (d) => new Broken(d) });
  const c = await connect(h);
  const r = await callAndLeave(h, c, 'Bot A, hi', 'Said hi.');
  assert.ok(fs.existsSync(path.join(h.dir, 'calls', r.file)));
  const logs = fs.readdirSync(path.join(h.dir, 'logs')).filter((f) => f.endsWith('.jsonl'));
  const text = logs.map((f) => fs.readFileSync(path.join(h.dir, 'logs', f), 'utf8')).join('');
  assert.match(text, /"kind":"library-error".*database is locked/);
  // A call where nothing was said is not saved, so nothing is indexed.
  h.sockets.clear();
  await inCall(h, c, ['a']);
  const left = await c.ok('leave');
  assert.equal(left.file, null);
  assert.equal(left.id, null);
});

test('a library that opens but cannot be rebuilt is closed and reported unavailable', async () => {
  let closed = false;
  class Unreadable extends CallLibrary {
    backfill(): never {
      throw new Error('calls folder unreadable');
    }
    close() {
      closed = true;
      super.close();
    }
  }
  const h = await start(true, 5, [], {}, { openLibrary: (d) => new Unreadable(d) });
  const c = await connect(h);
  assert.equal(closed, true);
  await c.fails('library', {}, /unavailable: calls folder unreadable/);
});

// ---------- incoming calls ----------

/** Waits for a pushed incoming-call state that matches. */
const incomingWhere = async (c: Client, pred: (state: any) => boolean) => (await c.next((m) => m.t === 'incoming' && pred(m.state), true)).state;

async function readyBots(h: Harness, ids: string[]) {
  for (let i = 0; i < 40 && ids.some((id) => !h.sockets.get(id)); i++) await new Promise((r) => setTimeout(r, 5));
  for (const id of ids) {
    h.sockets.get(id)!.onopen!();
    h.sockets.get(id)!.emit('session.updated');
  }
}

test('standing calls: save, ring now, answer (the first bot opens with the agenda), and the refusals', async () => {
  const h = await start(true, 5, [], {}, { zone: () => 'UTC' });
  const c = await connect(h);
  const empty = await c.ok('incoming');
  assert.deepEqual([empty.schedules, empty.ringing, empty.missed, empty.settings.quietHours.timezone], [[], null, [], 'UTC']);
  await c.fails('scheduleSave', { schedule: { title: 'Standup', botIds: ['a', 'zzz'], days: [1], time: '09:00', timezone: 'UTC' } }, /not on this account/);
  await c.fails('scheduleSave', { schedule: { title: 'Standup', botIds: ['a'], days: [1], time: '9am', timezone: 'UTC' } }, /time must be HH:MM/);
  const saved = await c.ok('scheduleSave', { schedule: { title: 'Standup', botIds: ['a', 'b'], agenda: 'Blockers first', days: [0, 1, 2, 3, 4, 5, 6], time: '09:00', timezone: 'UTC' } });
  assert.equal(saved.schedule.title, 'Standup');
  assert.equal(saved.schedules[0].nextAt > Date.now(), true);
  const ringing = incomingWhere(c, (s) => s.ringing !== null);
  const rang = await c.ok('scheduleRingNow', { id: saved.schedule.id });
  assert.equal(rang.ringing.title, 'Standup');
  assert.equal((await ringing).ringing.id, rang.ringing.id, 'the app is told when a call rings');
  (h as any).expect(['a', 'b']);
  const joined = await c.ok('ringAnswer', { id: rang.ringing.id });
  assert.deepEqual([joined.joined, joined.ring], [['a', 'b'], rang.ringing.id]);
  await readyBots(h, ['a', 'b']);
  const a = h.sockets.get('a')!;
  assert.match(a.said().at(-1)!, /answered the standing call "Standup"\. Open it now in one or two short spoken sentences, starting with the agenda\./);
  assert.match(a.lastSession().instructions, /# This is the standing call "Standup"\nShashank answered the scheduled call\. Agenda:\nBlockers first/);
  await c.fails('scheduleRingNow', { id: saved.schedule.id }, /Leave the current call first/);
  await c.fails('ringAnswer', { id: rang.ringing.id }, /Leave the current call first/);
  await c.ok('leave');
  await c.fails('ringAnswer', { id: rang.ringing.id }, /already answered/);
  await c.fails('ringDecline', { id: 'nope' }, /no longer there/);
  await c.fails('ringAnswer', {}, /id is required/);
  await c.fails('incomingSettings', { settings: { ringSeconds: 1 } }, /ringSeconds must be 15 to 120/);
  assert.equal((await c.ok('incomingSettings', { settings: { ringSeconds: 20, approvals: false } })).settings.ringSeconds, 20);
  // Decline, snooze, clear.
  const again = (await c.ok('scheduleRingNow', { id: saved.schedule.id })).ringing;
  await c.fails('ringSnooze', { id: again.id, minutes: 3 }, /minutes must be one of/);
  const snoozed = await c.ok('ringSnooze', { id: again.id, minutes: 5 });
  assert.deepEqual(snoozed.snoozed.map((r: any) => [r.title, r.scheduleId]), [['Standup', saved.schedule.id]]);
  assert.deepEqual(snoozed.callbacks, []);
  await c.ok('ringDecline', { id: snoozed.snoozed[0].id });
  await c.fails('ringDecline', { id: snoozed.snoozed[0].id }, /already declined/);
  const third = (await c.ok('scheduleRingNow', { id: saved.schedule.id })).ringing;
  assert.equal((await c.ok('ringDecline', { id: third.id })).ringing, null);
  assert.deepEqual((await c.ok('missedClear')).missed, []);
  assert.deepEqual((await c.ok('scheduleDelete', { id: saved.schedule.id })).schedules, []);
  await c.fails('scheduleDelete', { id: saved.schedule.id }, /no longer there/);
});

// Both requests passed the "already in a call" check before either set the call, so two calls started and the first
// one's bot sockets and view timer were never closed.
test('two join requests at once start one call; so do an answer and a join', async () => {
  const settle = () => new Promise((r) => setTimeout(r, 40));
  const h = await start(true, 5, [], {}, { zone: () => 'UTC' });
  const c = await connect(h);
  const first = await c.ok('scheduleSave', { schedule: { title: 'Sync', botIds: ['b'], days: [0, 1, 2, 3, 4, 5, 6], time: '09:00', timezone: 'UTC' } });
  const rung = (await c.ok('scheduleRingNow', { id: first.schedule.id })).ringing;
  (h as any).expect(['a']);
  const [one, two, three] = await Promise.all([c.op('join', { botIds: ['a'] }), c.op('join', { botIds: ['a'] }), c.op('ringAnswer', { id: rung.id })]);
  assert.deepEqual([one.ok, two.ok, two.error, three.ok, three.error], [true, false, 'already in a call', false, 'Leave the current call first.']);
  await settle();
  assert.equal(h.sockets.size, 1, 'one bot socket: one call');
  // Signing out while a call is still starting is refused like signing out in a call.
  const h3 = await start(true, 5, [], {}, { zone: () => 'UTC' });
  const c3 = await connect(h3);
  (h3 as any).expect(['a']);
  const [started, out] = await Promise.all([c3.op('join', { botIds: ['a'] }), c3.op('logout')]);
  assert.deepEqual([started.ok, out.ok, out.error], [true, false, 'leave the call before signing out']);
  assert.equal((await c3.ok('state')).state, 'signed-in');
  const h2 = await start(true, 5, [], {}, { zone: () => 'UTC' });
  const c2 = await connect(h2);
  const saved = await c2.ok('scheduleSave', { schedule: { title: 'Standup', botIds: ['a', 'b'], days: [0, 1, 2, 3, 4, 5, 6], time: '09:00', timezone: 'UTC' } });
  const ring = (await c2.ok('scheduleRingNow', { id: saved.schedule.id })).ringing;
  (h2 as any).expect(['a', 'b']);
  const [answered, joined] = await Promise.all([c2.op('ringAnswer', { id: ring.id }), c2.op('join', { botIds: ['c'] })]);
  assert.deepEqual([answered.ok, joined.ok, joined.error], [true, false, 'already in a call']);
  assert.deepEqual(answered.result.joined, ['a', 'b']);
  await settle();
  assert.equal(h2.sockets.size, 2, 'only the answered call\'s two bots');
  await c2.fails('ringAnswer', { id: ring.id }, /Leave the current call first/);
});

// A ring kept sounding after you started a call yourself, and Answer then said "Leave this call first."
test('starting a call while a ring sounds holds the ring until the call ends', async () => {
  const h = await start(true, 5, [], {}, { zone: () => 'UTC' });
  const c = await connect(h);
  const saved = await c.ok('scheduleSave', { schedule: { title: 'Standup', botIds: ['b'], days: [0, 1, 2, 3, 4, 5, 6], time: '09:00', timezone: 'UTC' } });
  const ring = (await c.ok('scheduleRingNow', { id: saved.schedule.id })).ringing;
  await inCall(h, c, ['a']);
  const during = await c.ok('incoming');
  assert.equal(during.ringing, null);
  assert.deepEqual(during.held.map((r: any) => [r.id, r.note]), [[ring.id, 'You were in a call.']]);
  await c.ok('leave');
  assert.equal((await c.ok('incoming')).ringing.id, ring.id, 'rings once the call ended');
});

test('a ring whose bots were deleted cannot be answered: it is listed as missed with why, and the bots leave its standing call', async () => {
  const h = await start(true, 5, [], {}, { zone: () => 'UTC' });
  const c = await connect(h);
  const saved = await c.ok('scheduleSave', { schedule: { title: 'Solo', botIds: ['c'], days: [1], time: '09:00', timezone: 'UTC' } });
  const ring = (await c.ok('scheduleRingNow', { id: saved.schedule.id })).ringing;
  h.agents.splice(h.agents.findIndex((x) => x.id === 'c'), 1);
  await c.fails('ringAnswer', { id: ring.id }, /not on this account any more/);
  const st = await c.ok('incoming');
  assert.match(st.missed[0].note, /^Answering failed: The bots in that call are not on this account any more\./);
  await c.ok('bots');
  const after = await c.ok('incoming');
  assert.deepEqual([after.schedules[0].botIds, after.schedules[0].enabled], [[], false]);
});

test('a bot promises a call back during a call: by minutes or a time, or when its job finishes; refusals are told', async () => {
  const h = await start(true, 5, [], {}, { zone: () => 'UTC' });
  const c = await connect(h);
  await inCall(h, c, ['a']);
  const a = h.sockets.get('a')!;
  assert.ok(a.lastSession().tools.some((t: any) => t.name === 'call_back_later'));
  reply(a, 'I will call you back.', [['call_back_later', { reason: 'Check the numbers', in_minutes: 30 }]]);
  assert.match(a.outputs().at(-1)!, /^Call back set: Alotbot rings Shashank at [A-Z][a-z]{2} \d{1,2}:\d{2}\s?[AP]M, and you open that call\./);
  const st = await c.ok('incoming');
  assert.deepEqual(st.callbacks.map((x: any) => [x.botId, x.reason, x.waitsFor]), [['a', 'Check the numbers', []]]);
  await c.ok('callbackCancel', { id: st.callbacks[0].id });
  await c.fails('callbackCancel', { id: st.callbacks[0].id }, /no longer there/);
  reply(a, '', [['call_back_later', { reason: 'Results', when_job_done: true }]]);
  assert.match(a.outputs().at(-1)!, /^Not done: You have no job under way to wait for/);
  reply(a, '', [['call_back_later', { reason: 'Results' }]]);
  assert.match(a.outputs().at(-1)!, /^Not done: Give exactly one of/);
  reply(a, '', [['call_back_later', { in_minutes: 5 }]]);
  assert.match(a.outputs().at(-1)!, /^Not done: Give reason/);
  await c.ok('incomingSettings', { settings: { botCallbacks: false } });
  reply(a, '', [['call_back_later', { reason: 'x', in_minutes: 5 }]]);
  assert.match(a.outputs().at(-1)!, /turned off bot callbacks/);
  const leaving = c.op('leave');
  await askedForSummary(a);
  reply(a, '', [['save_summary', { summary: 'Call backs.', action_items: [] }]]);
  await leaving;
});

test('a call back waiting on a job rings after the call once the job finishes, and the bot opens with the result', async () => {
  const h = await start(true, 5, [], {}, { zone: () => 'UTC' });
  const c = await connect(h);
  (h as any).holdJobs(true);
  await inCall(h, c, ['a']);
  const a = h.sockets.get('a')!;
  // A job that was not accepted (it failed at once) is not waited for.
  reply(a, 'On it.', [['send_task', { request: 'post a note' }]]);
  for (let i = 0; i < 40 && a.outputs().length < 1; i++) await new Promise((r) => setTimeout(r, 5));
  reply(a, 'On it.', [['send_task', { request: 'relay the launch thread' }]]);
  for (let i = 0; i < 40 && a.outputs().length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  reply(a, 'I will call you when it is up.', [['call_back_later', { reason: 'The thread is posted', when_job_done: true }]]);
  assert.equal(a.outputs().at(-1), 'Call back set: Alotbot rings Shashank once your job finishes, and you open that call with the result.');
  reply(a, 'And the images.', [['send_task', { request: 'relay the images' }]]);
  for (let i = 0; i < 40 && a.outputs().length < 4; i++) await new Promise((r) => setTimeout(r, 5));
  reply(a, '', [['call_back_later', { reason: 'Both are up', when_job_done: true }]]);
  assert.equal(a.outputs().at(-1), 'Call back set: Alotbot rings Shashank once your 2 jobs finish, and you open that call with the result.');
  hostSays(a, 'Bot A, thanks.');
  const leaving = c.op('leave');
  await askedForSummary(a);
  reply(a, '', [['save_summary', { summary: 'Posting.', action_items: [] }]]);
  await leaving;
  const rang = incomingWhere(c, (s) => s.ringing?.source === 'callback');
  (h as any).holdJobs(false); // the agent answers after the call ended
  const ring = (await rang).ringing;
  assert.deepEqual([ring.title, ring.reason, ring.botIds], ['Bot A is calling back', 'The thread is posted Result: Done: relay the launch thread', ['a']]);
  const held = await c.ok('incoming');
  assert.equal(held.held[0].reason, 'Both are up Result: Done: relay the launch thread; Done: relay the images', 'the second call back waits its turn');
  h.sockets.clear();
  (h as any).expect(['a']);
  await c.ok('ringAnswer', { id: ring.id });
  await readyBots(h, ['a']);
  const back = h.sockets.get('a')!;
  assert.match(back.said().at(-1)!, /answered your call\. Open it now/);
  assert.match(back.lastSession().instructions, /# Why this call\nBot A called Shashank, and he answered\. It is the call back that was promised: The thread is posted Result: Done: relay the launch thread/);
  await c.ok('leave');
});

test('a job from an ended call that finishes later rings its bot', async () => {
  const h = await start(true, 5, [], {}, { zone: () => 'UTC' });
  const c = await connect(h);
  (h as any).holdJobs(true);
  await inCall(h, c, ['a']);
  const a = h.sockets.get('a')!;
  reply(a, 'Sending it.', [['send_task', { request: 'relay the recap' }]]);
  for (let i = 0; i < 40 && !a.outputs().length; i++) await new Promise((r) => setTimeout(r, 5));
  const leaving = c.op('leave');
  await askedForSummary(a);
  reply(a, '', [['save_summary', { summary: 'Recap.', action_items: [] }]]);
  await leaving;
  const rang = incomingWhere(c, (s) => s.ringing?.source === 'job');
  (h as any).holdJobs(false);
  const ring = (await rang).ringing;
  assert.deepEqual([ring.title, ring.reason], ['Bot A has results', 'Done: relay the recap']);
});

test('actionView passes on only a pending approval\'s summary', () => {
  const base = { id: 'x', callId: 'c', botId: 'a', botName: 'Bot A', target: 'agent' as const, tool: 'send_task', input: {}, status: 'waiting_approval' as const, requestId: null, summary: 's', result: 'r', error: null, createdAt: 1, updatedAt: 2 };
  const approval = { kind: 'auto_review' as const, requestId: 'q', entryId: null, summary: 'Send the email', status: 'pending' as const };
  assert.equal(actionView({ ...base, approval }).approvalSummary, 'Send the email');
  assert.equal(actionView({ ...base, approval: { ...approval, status: 'approved' } }).approvalSummary, null);
  assert.deepEqual(actionView({ ...base, approval: null }), { id: 'x', botId: 'a', botName: 'Bot A', callId: 'c', target: 'agent', tool: 'send_task', status: 'waiting_approval', summary: 's', error: null, approvalSummary: null });
});

test('a disk failure while saving incoming calls is reported as it is, not as a mistake in the request', async () => {
  const h = await start(true, 5, [], {}, { zone: () => 'UTC' });
  const c = await connect(h);
  const saved = await c.ok('scheduleSave', { schedule: { title: 'S', botIds: ['a'], days: [1], time: '09:00', timezone: 'UTC' } });
  const ring = (await c.ok('scheduleRingNow', { id: saved.schedule.id })).ringing;
  const file = path.join(h.dir, 'incoming.json');
  fs.rmSync(file);
  fs.mkdirSync(path.join(file, 'blocked'), { recursive: true }); // a folder where the file goes: every save fails
  await c.fails('incomingSettings', { settings: { approvals: false } }, /EISDIR|ENOTEMPTY|EEXIST|directory/i);
  await c.fails('ringAnswer', { id: ring.id }, /EISDIR|ENOTEMPTY|EEXIST|directory/i);
});

// ---------- meetings ----------

test('parseMeeting needs the app and the host\'s confirmation that the meeting knows it is transcribed', () => {
  assert.equal(parseMeeting(undefined), null);
  assert.equal(parseMeeting(null), null);
  assert.deepEqual(parseMeeting({ app: '  zoom.us ', consent: true }), { app: 'zoom.us' });
  for (const [raw, why] of [
    ['zoom', /meeting must be an object/],
    [['zoom'], /meeting must be an object/],
    [{ consent: true }, /meeting.app must name the meeting app/],
    [{ app: 'x'.repeat(101), consent: true }, /meeting.app must name/],
    [{ app: 'zoom.us' }, /Confirm that the people in the meeting know/],
    [{ app: 'zoom.us', consent: 'yes' }, /Confirm that/],
  ] as [unknown, RegExp][]) assert.throws(() => parseMeeting(raw), why);
});

test('a meeting call: lines from the Mac reach the bots, whispers switch, and it is saved and searchable as a meeting', async () => {
  const h = await start();
  const c = await connect(h);
  await c.fails('join', { botIds: ['a'], meeting: { app: 'zoom.us' } }, /Confirm that the people in the meeting know/);
  await c.fails('meetingLine', { who: 'meeting', text: 'x' }, /not in a call/);
  (h as any).expect(['a', 'b']);
  await c.ok('join', { botIds: ['a', 'b'], meeting: { app: 'zoom.us', consent: true } });
  await readyBots(h, ['a', 'b']);
  const view = await c.next((m) => m.t === 'view' && m.view.meeting !== null, true);
  assert.deepEqual(view.view.meeting, { app: 'zoom.us', whisper: 'text' });
  assert.deepEqual(await c.ok('meetingLine', { who: 'meeting', text: 'The renewal is 40 thousand' }), { kept: true });
  assert.deepEqual(await c.ok('meetingLine', { who: 'host', text: 'the renewal is 40 thousand' }), { kept: false });
  await c.fails('meetingLine', { who: 'boss', text: 'x' }, /who must be meeting or host/);
  await c.fails('meetingLine', { who: 'meeting', text: 5 }, /text must be text/);
  assert.equal(h.sockets.get('b')!.said().at(-1), '[Meeting]: The renewal is 40 thousand');
  await c.fails('setWhisper', { mode: 'loud' }, /mode must be text or voice/);
  assert.deepEqual(await c.ok('setWhisper', { mode: 'voice' }), { whisper: 'voice' });
  await c.next((m) => m.t === 'view' && m.view.meeting?.whisper === 'voice', true);
  const a = h.sockets.get('a')!;
  const leaving = c.op('leave');
  await askedForSummary(a);
  reply(a, '', [['save_summary', { summary: 'Renewal discussed.', action_items: [], decisions: ['Offer 40k'] }]]);
  const left = (await leaving).result;
  const md = await c.ok('callFile', { file: left.file });
  assert.match(md.markdown, /^# Alotbot meeting, .*\n\nBots: Bot A, Bot B  \nKind: meeting  \nLength: \d+ min\n/);
  assert.match(md.markdown, /\*\*Meeting:\*\* The renewal is 40 thousand/);
  const meetings = await c.ok('library', { kind: 'meeting' });
  assert.deepEqual(meetings.calls.map((x: any) => [x.kind, x.decisions]), [['meeting', ['Offer 40k']]]);
  // A normal call refuses meeting requests.
  h.sockets.clear();
  await inCall(h, c, ['a']);
  await c.fails('meetingLine', { who: 'meeting', text: 'x' }, /not listening to a meeting/);
  await c.fails('setWhisper', { mode: 'text' }, /not listening to a meeting/);
});

// ---------- sharing your screen ----------

test('parseScreenSource and screenshot paths: what may be shared, and never a password manager', () => {
  assert.deepEqual(parseScreenSource({ app: ' Safari ', title: ' Pricing  page ', kind: 'window' }), { app: 'Safari', title: 'Pricing page', kind: 'window' });
  assert.deepEqual(parseScreenSource({ app: 'Display 1', kind: 'display' }), { app: 'Display 1', title: '', kind: 'display' });
  for (const [m, why] of [
    [{ kind: 'window' }, /app must name the shared app/],
    [{ app: 'x'.repeat(101), kind: 'window' }, /app must name/],
    [{ app: 'Safari', title: 't'.repeat(301), kind: 'window' }, /title is longer than 300/],
    [{ app: 'Safari', kind: 'tab' }, /kind must be window or display/],
    [{ app: '1Password 8', kind: 'window' }, /never shared with the bots: it holds passwords/],
    [{ app: 'Keychain Access', kind: 'window' }, /never shared/],
    [{ app: 'Safari', title: 'Bitwarden vault', kind: 'window' }, /never shared/],
  ] as [Record<string, unknown>, RegExp][]) assert.throws(() => parseScreenSource(m), why);
  // Only the data folder in use (Alotbot, the GrokCall fallback, or ALOTBOT_DATA_DIR in tests) counts.
  const data = '/Users/me/Library/Application Support/Alotbot';
  assert.ok(ownScreenshot(`${data}/artifacts/screen-AB12-cd.png`, data));
  assert.ok(ownScreenshot('/tmp/alotbot-test/data/artifacts/screen-1.png', '/tmp/alotbot-test/data/'));
  for (const bad of [
    'relative/Alotbot/artifacts/screen-1.png', `${data}/artifacts/observation-1.png`, `${data}/artifacts/screen-1.png.sh`, '/etc/passwd',
    '/Users/me/Library/Application Support/GrokCall/artifacts/screen-1.png', `${data}/artifacts/../artifacts/screen-1.png`, `${data}/artifacts/x/screen-1.png`, `${data}/artifacts/screen-.png`,
  ]) assert.ok(!ownScreenshot(bad, data), bad);
});

// Switching windows: the old window's last read arrived after the switch, was taken as the new window's text (and used
// the new share's first read), so the bots were told the old window's private text.
test('switching the shared window ignores a late read from the old one, and the new one still gets its first read', async () => {
  const h = await start();
  const c = await connect(h);
  await inCall(h, c, ['a']);
  const mail = await c.ok('screenShare', { app: 'Mail', title: 'Inbox', kind: 'window' });
  const safari = await c.ok('screenShare', { app: 'Safari', title: 'Pricing', kind: 'window' });
  assert.notEqual(safari.share, mail.share);
  await c.fails('screenUpdate', { text: 'x', share: 'one' }, /share must be a whole number/);
  assert.deepEqual(await c.ok('screenUpdate', { text: 'Mail: private message', title: 'Inbox', share: mail.share }), { changed: false, ignored: true });
  assert.deepEqual(await c.ok('screenUpdate', { text: 'TOTAL 4,200', title: 'Pricing', share: safari.share }), { changed: true });
  const a = h.sockets.get('a')!;
  await c.ok('say', { text: 'What is on my screen?' });
  assert.ok(a.said().some((l) => l.includes('TOTAL 4,200')));
  assert.ok(!a.said().some((l) => l.includes('private message')));
  // A late read from a window that shows a password manager does not stop the new share.
  await new Promise((r) => setTimeout(r, SCREEN_MIN_MS + 50));
  assert.deepEqual(await c.ok('screenUpdate', { text: 'vault', title: '1Password', share: mail.share }), { changed: false, ignored: true });
  await c.ok('screenStop');
});

test('logArgs keeps only the size of screen text and meeting lines', () => {
  assert.deepEqual(logArgs('screenUpdate', { text: 'secret numbers' }, { text: 'secret numbers' }), { chars: 14 });
  assert.deepEqual(logArgs('meetingLine', { who: 'meeting', text: 'abc' }, {}), { who: 'meeting', chars: 3 });
  assert.deepEqual(logArgs('screenUpdate', {}, {}), { chars: null });
  assert.deepEqual(logArgs('workspace', { action: 'x', secret: 1 }, { secret: 1 }), { action: 'x' });
  assert.deepEqual(logArgs('say', { text: 'hi' }, { text: 'hi' }), { text: 'hi' });
});

test('sharing a screen through the app: updates are checked, throttled, kept out of the log, and stop for password managers', async () => {
  const h = await start();
  const c = await connect(h);
  await c.fails('screenShare', { app: 'Safari', kind: 'window' }, /not in a call/);
  assert.equal(await c.ok('screenStop'), null, 'stopping outside a call is fine');
  await inCall(h, c, ['a']);
  await c.fails('screenUpdate', { text: 'x' }, /not sharing a screen/);
  await c.fails('screenShare', { app: '1Password', kind: 'window' }, /holds passwords/);
  assert.deepEqual(await c.ok('screenShare', { app: 'Safari', title: 'Pricing', kind: 'window' }), { sharing: true, share: 1 });
  await c.next((m) => m.t === 'view' && m.view.screen?.app === 'Safari', true);
  await c.fails('screenUpdate', { text: 5 }, /text must be text/);
  await c.fails('screenUpdate', { text: 'x', screenshot: '/etc/passwd' }, /own screen captures/);
  await c.fails('screenUpdate', { text: 'x', screenshot: '/a/Alotbot/artifacts/../artifacts/screen-1.png' }, /own screen captures/);
  await c.fails('screenUpdate', { text: 'x', screenshot: 7 }, /own screen captures/);
  await c.fails('screenUpdate', { text: 'x', title: 7 }, /title must be text/);
  // The data folder in use, whatever it is called (ALOTBOT_DATA_DIR in tests).
  const shot = path.join(h.dir, 'artifacts', 'screen-1.png');
  assert.deepEqual(await c.ok('screenUpdate', { text: 'TOTAL 4,200 secret', screenshot: shot, title: '  Pricing  ' }), { changed: true });
  assert.deepEqual(await c.ok('screenUpdate', { text: 'TOTAL 9', title: null }), { changed: false, ignored: true }, 'too soon after the last one');
  await new Promise((r) => setTimeout(r, SCREEN_MIN_MS + 50));
  assert.deepEqual(await c.ok('screenUpdate', { text: 'TOTAL 4,200 secret' }), { changed: false });
  const a = h.sockets.get('a')!;
  await c.ok('say', { text: 'What is the total?' });
  assert.ok(a.said().includes('[Screen]: Safari: "Pricing" shows:\nTOTAL 4,200 secret'));
  // The window turns into a password manager: sharing stops.
  await new Promise((r) => setTimeout(r, SCREEN_MIN_MS + 50));
  await c.fails('screenUpdate', { text: 'vault', title: '1Password — Personal' }, /Sharing stopped: the shared window now shows a password manager/);
  await c.next((m) => m.t === 'view' && m.view.screen === null, true);
  assert.equal(await c.ok('screenStop'), null);
  // The call log has sizes, not the screen's text.
  const logs = fs.readdirSync(path.join(h.dir, 'logs')).filter((f) => f.startsWith('call-'));
  const appLines = logs.flatMap((f) => fs.readFileSync(path.join(h.dir, 'logs', f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l)).filter((e) => e.kind === 'app' && e.op === 'screenUpdate');
  assert.ok(appLines.length >= 3);
  assert.ok(appLines.every((e) => !JSON.stringify(e).includes('secret')));
});
