// The Mac app's backend: one local WebSocket that carries commands, the live call (view, transcript,
// tasks) and audio both ways. The app does the mic and speakers; this runs the call engine.

import crypto from 'node:crypto';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { floatTo16, USER } from '../../public/core.js';
import { AuthStore, Login } from '../auth.ts';
import { API_URL, type Bot, NotFoundError, SignedOutError, SITE_URL } from '../grokbot.ts';
import { OverlayCall, overlayMarkdown } from './call.ts';
import { BadSetting, COLORS, LANGUAGES, OverlayGrokClient, parseNewBot, parseVoiceSettings, PICKER_SHAPES, SHAPES, SPEEDS, VOICES } from './grok.ts';
import { OverlayStore } from './store.ts';
import { STATUSES, TaskBoard, TaskError, type TaskStatus } from './tasks.ts';

export const PROTOCOL_VERSION = 1;
/** Bot audio is scheduled this far ahead, so it reaches the app before it is due. */
export const AUDIO_LEAD_S = 0.06;
/** How often the live call view is pushed (only when it changed). */
export const VIEW_MS = 66;
/** Largest message the app may send (a mic frame is ~2 KB; commands are small). */
export const MAX_MESSAGE = 256 * 1024;
export const MSG = { mic: 1, botAudio: 2 } as const;

export interface OverlayOptions {
  dataDir: string;
  /** The app must present this as `Authorization: Bearer <token>`. */
  token: string;
  apiUrl?: string;
  siteUrl?: string;
  fetch?: typeof fetch;
  pollMs?: number;
  loginTimeoutMs?: number;
  /** Opens the bots' voice sockets (default: Node's WebSocket). */
  openSocket?: (url: string, protocols: string[]) => any;
  /** Seconds on a steady clock (default: performance.now). */
  clock?: () => number;
  viewMs?: number;
}

class ClientError extends Error {}

/** The bots' realtime voice sockets: the secret goes in the subprotocol, as in the browser. */
export const defaultOpenSocket = (url: string, protocols: string[]) => new WebSocket(url, protocols);

const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Only the app may connect: right token, a local Host, and no browser Origin. */
export function upgradeAllowed(req: http.IncomingMessage, token: string): boolean {
  let host: string;
  try {
    host = new URL(`ws://${req.headers.host ?? ''}`).hostname;
  } catch {
    return false;
  }
  if (!LOCAL.has(host) || req.headers.origin !== undefined || new URL(req.url!, 'ws://x').pathname !== '/ws') return false;
  const got = Buffer.from(req.headers.authorization ?? '');
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Bot audio for the app: [2][u32 id][f64 when, server seconds][PCM16 at 24 kHz]. */
export function encodeBotAudio(id: number, when: number, samples: Float32Array): Buffer {
  const pcm = floatTo16(samples) as Int16Array;
  const out = Buffer.alloc(13 + pcm.length * 2);
  out.writeUInt8(MSG.botAudio, 0);
  out.writeUInt32LE(id, 1);
  out.writeDoubleLE(when, 5);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i], 13 + i * 2);
  return out;
}

/** Mic audio from the app: [1][f32 level][PCM16 at 24 kHz]. Null if malformed. */
export function decodeMic(buf: Buffer): { level: number; pcm: Int16Array } | null {
  if (buf.length < 7 || buf[0] !== MSG.mic || (buf.length - 5) % 2 !== 0) return null;
  const level = buf.readFloatLE(1);
  if (!Number.isFinite(level) || level < 0) return null;
  const pcm = new Int16Array((buf.length - 5) / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(5 + i * 2);
  return { level: Math.min(1, level), pcm };
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new ClientError(`${what} is required`);
  return v;
};
const int = (v: unknown, what: string): number => {
  if (!Number.isSafeInteger(v)) throw new ClientError(`${what} must be a whole number`);
  return v as number;
};

export function createOverlayServer(opts: OverlayOptions) {
  const store = new AuthStore(opts.dataDir);
  const apiUrl = opts.apiUrl ?? API_URL;
  const login = new Login({ store, apiUrl, siteUrl: opts.siteUrl ?? SITE_URL, fetch: opts.fetch, pollMs: opts.pollMs, timeoutMs: opts.loginTimeoutMs });
  const grok = new OverlayGrokClient({ store, apiUrl, fetch: opts.fetch });
  const calls = new OverlayStore(opts.dataDir);
  const clock = opts.clock ?? (() => performance.now() / 1000);
  const openSocket = opts.openSocket ?? defaultOpenSocket;

  const http_ = http.createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not here');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  let client: Session | null = null;

  http_.on('upgrade', (req, socket, head) => {
    if (!upgradeAllowed(req, opts.token)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // One app at a time: a new connection replaces the old one (and ends its call).
      client?.close(4000, 'replaced by a newer connection');
      client = new Session(ws);
    });
  });

  class Session {
    ws: WebSocket;
    call: OverlayCall | null = null;
    bots: Bot[] = [];
    linesSent = 0;
    tasksSent = -1;
    lastView = '';
    timer: NodeJS.Timeout | null = null;
    audioId = 0;
    ending: Promise<unknown> | null = null;

    constructor(ws: WebSocket) {
      this.ws = ws;
      ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
      ws.on('close', () => this.onClose());
    }

    send(msg: object) {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    }

    close(code: number, why: string) {
      this.ws.close(code, why);
      this.onClose();
    }

    onClose() {
      if (client === this) client = null;
      this.stopCall();
    }

    onMessage(data: RawData, isBinary: boolean) {
      if (isBinary) {
        const mic = decodeMic(data as Buffer);
        if (mic) this.call?.micAudio(mic.pcm, mic.level);
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return this.send({ t: 'reply', req: null, ok: false, error: 'not JSON' });
      }
      // `req` numbers the request; it is not `id`, which task commands use for the task.
      const req = msg?.req ?? null;
      Promise.resolve()
        .then(() => this.run(String(msg?.op), msg ?? {}))
        .then(
          (result) => this.send({ t: 'reply', req, ok: true, result: result ?? null }),
          (err) => {
            const signedOut = err instanceof SignedOutError;
            this.send({ t: 'reply', req, ok: false, error: (err as Error).message, ...(signedOut ? { signedOut } : {}) });
          },
        );
    }

    inCall(): OverlayCall {
      if (!this.call || this.call.phase !== 'in-call') throw new ClientError('not in a call');
      return this.call;
    }

    async run(op: string, m: Record<string, unknown>): Promise<unknown> {
      switch (op) {
        case 'hello':
          return {
            version: PROTOCOL_VERSION,
            serverNow: clock(),
            user: USER,
            choices: { voices: VOICES, speeds: SPEEDS, languages: LANGUAGES, shapes: SHAPES, pickerShapes: PICKER_SHAPES, colors: COLORS, statuses: STATUSES },
          };
        case 'state':
          return login.state();
        case 'login':
          return { loginUrl: login.start() };
        case 'logout':
          if (this.call) throw new ClientError('leave the call before signing out');
          login.cancel();
          store.clear();
          this.bots = [];
          return login.state();
        case 'bots':
          this.bots = await grok.listBots();
          return { bots: this.bots };
        case 'join':
          return this.join(m.botIds);
        case 'leave':
          return this.leave();
        case 'addBot':
        case 'removeBot': {
          const call = this.inCall();
          const botId = str(m.botId, 'botId');
          if (op === 'removeBot') return void call.removeBot(botId);
          const bot = (await this.freshBots()).find((b) => b.id === botId);
          if (!bot) throw new NotFoundError(`No Grok Bot with id ${botId}.`);
          return void call.addBot(bot);
        }
        case 'say': {
          const call = this.inCall();
          let text = str(m.text, 'text');
          if (m.botId !== undefined && m.botId !== null) {
            const link = call.links.get(str(m.botId, 'botId'));
            if (!link) throw new ClientError('that bot is not in the call');
            text = `${link.bot.name}, ${text}`; // naming the bot makes it a one-on-one: only it answers
          }
          return { sent: call.sendText(text) };
        }
        case 'stop':
          return void this.inCall().stopAll();
        case 'mute':
          return void this.inCall().setMuted(m.muted === true);
        case 'setVoice':
          return this.setVoice(str(m.botId, 'botId'), parseVoiceSettings(m.settings));
        case 'createBot': {
          const bot = await grok.createBot(parseNewBot(m.bot));
          this.bots = await grok.listBots();
          if (m.addToCall === true && this.call?.phase === 'in-call') this.call.addBot(bot);
          return { bot };
        }
        case 'tasks':
          return this.taskList();
        case 'taskAdd':
        case 'taskStatus':
        case 'taskLink':
        case 'taskUnlink':
        case 'taskRemove':
          return this.changeTasks(op, m);
        case 'calls':
          return { calls: calls.listCalls() };
        case 'callFile':
          return { markdown: calls.readCall(str(m.file, 'file')) };
        default:
          throw new ClientError(`unknown op "${op}"`);
      }
    }

    async freshBots(): Promise<Bot[]> {
      if (!this.bots.length) this.bots = await grok.listBots();
      return this.bots;
    }

    async join(raw: unknown) {
      if (this.call) throw new ClientError('already in a call');
      if (!Array.isArray(raw) || !raw.length || !raw.every((x) => typeof x === 'string')) throw new ClientError('botIds must be a list of bot ids');
      const all = await grok.listBots();
      this.bots = all;
      const picked = all.filter((b) => raw.includes(b.id));
      if (picked.length !== new Set(raw).size) throw new NotFoundError('Some of those bots are not on this account any more.');
      const call = new OverlayCall({
        mintVoice: (id: string) => grok.voiceSession(id),
        openSocket,
        audio: {
          now: () => clock() + AUDIO_LEAD_S,
          play: (samples: Float32Array, when: number) => {
            const id = ++this.audioId;
            if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeBotAudio(id, when, samples));
            return { stop: () => this.send({ t: 'stopAudio', id }) };
          },
        },
        setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimer: (t: NodeJS.Timeout) => clearTimeout(t),
        now: () => Date.now(),
      });
      call.joinWith(picked, all, calls.readMemory());
      this.call = call;
      this.linesSent = 0;
      this.tasksSent = -1;
      this.lastView = '';
      this.timer = setInterval(() => this.push(), opts.viewMs ?? VIEW_MS);
      this.push();
      return { joined: picked.map((b) => b.id) };
    }

    /** Pushes what changed: the call view, new transcript lines, and the task list. */
    /** Runs only while a call is up: stopCall clears the timer before dropping the call. */
    push() {
      const call = this.call!;
      const view = JSON.stringify(call.overlayView());
      if (view !== this.lastView) {
        this.lastView = view;
        this.ws.send(`{"t":"view","view":${view}}`);
      }
      if (call.lines.length > this.linesSent) {
        this.send({ t: 'lines', lines: call.linesSince(this.linesSent) });
        this.linesSent = call.lines.length;
      }
      if (call.board.version !== this.tasksSent) {
        this.tasksSent = call.board.version;
        this.send({ t: 'tasks', ...this.taskList() });
      }
    }

    /** Leave: the summary is written (up to 20 s), then the call is saved. */
    async leave() {
      const call = this.call;
      if (!call) throw new ClientError('not in a call');
      if (this.ending) throw new ClientError('already leaving');
      this.ending = call.wrapUp();
      await this.ending;
      const data = call.overlayExport();
      this.stopCall();
      let file: string | null = null;
      if (data.saveWorthy) file = calls.saveCall(data.memory, overlayMarkdown(data, (ms) => new Date(ms).toLocaleString()));
      this.send({ t: 'ended' });
      return { file, summary: data.summary, actionItems: data.actionItems };
    }

    stopCall() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.call?.leave();
      this.call = null;
      this.ending = null;
    }

    async setVoice(botId: string, s: ReturnType<typeof parseVoiceSettings>) {
      const bot = await grok.setVoice(botId, s);
      this.bots = this.bots.map((b) => (b.id === bot.id ? bot : b));
      // A bot in the call speaks with the new settings from its next reply.
      const link = this.call?.links.get(bot.id);
      if (link) {
        link.bot = bot;
        if (link.ready) link.ws.send(JSON.stringify(link.sessionUpdate()));
      }
      return { bot };
    }

    /** The board: the call's while in a call, else the saved one. */
    board(): TaskBoard {
      return this.call ? this.call.board : new TaskBoard(calls.readMemory()?.tasks ?? []);
    }

    taskList() {
      const board = this.board();
      return {
        version: board.version,
        tasks: board.tasks.map((t) => ({ ...t, status: board.statusOf(t), blockedBy: board.blockers(t).map((b) => b.id) })),
      };
    }

    async ownerName(v: unknown): Promise<string | null> {
      if (v === null || v === undefined) return null;
      const name = str(v, 'owner');
      if (name === USER || (await this.freshBots()).some((b) => b.name === name)) return name;
      throw new ClientError(`"${name}" is not you or one of your bots`);
    }

    async changeTasks(op: string, m: Record<string, unknown>) {
      const owner = op === 'taskAdd' ? await this.ownerName(m.owner) : null;
      try {
        if (this.call) this.applyTask(op, m, owner, this.call);
        else {
          const saved = calls.readMemory();
          const board = new TaskBoard(saved?.tasks ?? []);
          this.applyTask(op, m, owner, board);
          calls.writeMemory({ summary: saved?.summary ?? '', tasks: board.tasks });
        }
      } catch (err) {
        if (err instanceof TaskError) throw new ClientError(err.message);
        throw err;
      }
      const list = this.taskList();
      if (!this.call) this.send({ t: 'tasks', ...list });
      return list;
    }

    /** One task change by the host, on the call (so bots are told) or on a board outside a call. */
    applyTask(op: string, m: Record<string, unknown>, owner: string | null, on: OverlayCall | TaskBoard) {
      const id = op === 'taskAdd' ? 0 : int(m.id, 'id');
      const call = on instanceof TaskBoard ? null : on;
      const board = call ? call.board : (on as TaskBoard);
      switch (op) {
        case 'taskAdd': {
          const parent = m.parent === undefined || m.parent === null ? null : int(m.parent, 'parent');
          if (m.waitsOn !== undefined && !Array.isArray(m.waitsOn)) throw new ClientError('waitsOn must be a list of task ids');
          const waitsOn = ((m.waitsOn as unknown[] | undefined) ?? []).map((x) => int(x, 'waitsOn'));
          const n = { title: m.title, owner, parent, waitsOn };
          return call ? call.addTask(n, USER) : board.add({ ...n, by: USER });
        }
        case 'taskStatus': {
          if (!STATUSES.includes(m.status as TaskStatus)) throw new ClientError(`status must be one of ${STATUSES.join(', ')}`);
          return call ? call.setTaskStatus(id, m.status as TaskStatus, USER) : board.setStatus(id, m.status as TaskStatus, USER);
        }
        case 'taskLink':
          return call ? call.linkTasks(id, int(m.on, 'on'), USER) : board.link(id, int(m.on, 'on'));
        case 'taskUnlink':
          return call ? call.unlinkTasks(id, int(m.on, 'on'), USER) : board.unlink(id, int(m.on, 'on'));
        default:
          return call ? call.removeTask(id, USER) : board.remove(id);
      }
    }
  }

  return {
    server: http_,
    /** Ends any call and closes the app's connection. */
    close() {
      client?.close(1001, 'backend stopping');
      login.cancel();
      wss.close();
    },
  };
}

export { BadSetting, ClientError };
