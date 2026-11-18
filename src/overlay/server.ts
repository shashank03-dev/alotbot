import { ComputerViewer } from '../computer-viewer.ts';
import { LocalBrowser } from '../browser.ts';
import { LOCAL_TOOLS, localTarget } from '../local-tools.ts';
import { argumentError } from '../validation.ts';
// The Mac app's backend: one local WebSocket that carries commands, the live call (view, transcript,
// tasks) and audio both ways. The app does the mic and speakers; this runs the call engine.

import crypto from 'node:crypto';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { floatTo16, USER } from '../../public/core.js';
import { AuthStore, Login } from '../auth.ts';
import { API_URL, type Bot, NotFoundError, SignedOutError, SITE_URL, type ToolCall } from '../grokbot.ts';
import { OverlayCall, overlayMarkdown } from './call.ts';
import { CallLog, loggedSocket, MicStats } from './log.ts';
import { BadSetting, COLORS, LANGUAGES, OverlayGrokClient, parseNewBot, parseVoiceSettings, PICKER_SHAPES, SHAPES, SPEEDS, VOICES } from './grok.ts';
import { OverlayStore } from './store.ts';
import { CALL_KINDS, CallLibrary, type CallKind, callIdOf, LibraryError } from './library.ts';
import { type ActionView, callbackWhen, IncomingCalls, IncomingError, type Ring } from './incoming.ts';
import { type CallOpening, type MeetingInfo } from './call.ts';
import type { Action } from '../actions.ts';
import { ActionStore } from '../actions.ts';
import { CallActions } from '../dispatch.ts';
import { JobWatcher } from '../jobs.ts';
import { STATUSES, TaskBoard, TaskError, type TaskStatus } from './tasks.ts';

export const PROTOCOL_VERSION = 1;
/** Bot audio is scheduled this far ahead, so it reaches the app before it is due. */
export const AUDIO_LEAD_S = 0.06;
/** How often the live call view is pushed (only when it changed). */
export const VIEW_MS = 66;
/** Largest message the app may send (a mic frame is ~2 KB; commands are small). */
export const MAX_MESSAGE = 256 * 1024;
export const MSG = { mic: 1, botAudio: 2 } as const;
/** Newest actions the app is sent. */
export const ACTIONS_SHOWN = 200;

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
  /** Opens the call library (tests use this to make it fail). */
  openLibrary?: (dataDir: string) => CallLibrary;
  /** Wall clock and timers for incoming calls (default: Date.now and setTimeout). */
  incomingClock?: { now: () => number; setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (t: unknown) => void };
  /** The Mac's time zone (default: the system's). */
  zone?: () => string;
}

/** What incoming calls need to know about an action. */
export function actionView(a: Action): ActionView {
  return {
    id: a.id, botId: a.botId, botName: a.botName, callId: a.callId, target: a.target, tool: a.tool, status: a.status, summary: a.summary, error: a.error,
    approvalSummary: a.approval?.status === 'pending' ? a.approval.summary : null,
  };
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

/**
 * The meeting a call listens to, from the app: its app name, and the host's confirmation that the people in it know
 * they are being transcribed. Null for a normal call.
 */
export function parseMeeting(raw: unknown): MeetingInfo | null {
  if (raw === undefined || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ClientError('meeting must be an object');
  const app = typeof r.app === 'string' ? r.app.replace(/\s+/g, ' ').trim() : '';
  if (!app || app.length > 100) throw new ClientError('meeting.app must name the meeting app (up to 100 characters)');
  if (r.consent !== true) throw new ClientError('Confirm that the people in the meeting know it is being transcribed.');
  return { app };
}

export function createOverlayServer(opts: OverlayOptions) {
  const store = new AuthStore(opts.dataDir);
  const apiUrl = opts.apiUrl ?? API_URL;
  const login = new Login({ store, apiUrl, siteUrl: opts.siteUrl ?? SITE_URL, fetch: opts.fetch, pollMs: opts.pollMs, timeoutMs: opts.loginTimeoutMs });
  const grok = new OverlayGrokClient({ store, apiUrl, fetch: opts.fetch });
  const calls = new OverlayStore(opts.dataDir);
  // Saved calls, searchable. The app still works without it (a broken disk or SQLite): search is then reported unavailable.
  let library: CallLibrary | null = null;
  let libraryProblem = '';
  try {
    library = (opts.openLibrary ?? ((d: string) => new CallLibrary(d)))(opts.dataDir);
    library.backfill(calls.callsDir);
  } catch (err) {
    library?.close();
    library = null;
    libraryProblem = (err as Error).message;
  }
  const needLibrary = (): CallLibrary => {
    if (!library) throw new ClientError(`Call history search is unavailable: ${libraryProblem}`);
    return library;
  };
  // Every bot action, kept across calls and relaunches; jobs are watched until their agents answer.
  const actionStore = new ActionStore(opts.dataDir);
  actionStore.recoverInterrupted();
  const watcher = new JobWatcher({
    grok, store: actionStore, setTimer: (fn, ms) => setTimeout(fn, ms).unref(), clearTimer: (t) => clearTimeout(t), now: Date.now,
    onChange: (botId) => {
      observeBot(botId);
      client?.actionsChanged(botId);
    },
    log: (kind, data) => client?.log?.write(kind, data as Record<string, unknown>),
  });
  const zone = opts.zone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const iclock = opts.incomingClock ?? { now: Date.now, setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms).unref(), clearTimer: (t: unknown) => clearTimeout(t as NodeJS.Timeout) };
  // Standing calls, bot call backs and rings when bot work finishes after its call.
  const incoming = new IncomingCalls({
    dir: opts.dataDir,
    now: iclock.now,
    setTimer: iclock.setTimer,
    clearTimer: iclock.clearTimer,
    busy: () => client?.call != null,
    zone,
    changed: () => client?.send({ t: 'incoming', state: incoming.state() }),
  });
  incoming.seed(actionStore.list({ limit: 2000 }).map(actionView));
  /** A bot's agent sent something: maybe a ring. The live call's own actions reach the call instead. */
  function observeBot(botId: string) {
    incoming.observe(actionStore.list({ limit: 500 }).filter((a) => a.botId === botId).map(actionView), client?.call?.callId ?? null);
  }
  incoming.start();
  watcher.resume();
  const actions: CallActions = new CallActions({ harnessTool: (id, call) => localTarget(call.name)
    ? client!.localTool(id, call.name, call.input)
    : grok.harnessTool(id, call) }, actionStore, watcher);
  const clock = opts.clock ?? (() => performance.now() / 1000);
  const openSocket = opts.openSocket ?? defaultOpenSocket;

  const http_ = http.createServer((req, res) => {
    void (async () => {
      if (client && await client.viewers.handle(req, res)) return;
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not here');
    })().catch(() => { res.destroy(); });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  let client: Session | null = null;

  http_.on('upgrade', (req, socket, head) => {
    if (client?.viewers.upgrade(req, socket, head)) return;
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
    /** This call's log (logs/call-<time>.jsonl), open while the call is. */
    log: CallLog | null = null;
    mic = new MicStats(0);
    browser = new LocalBrowser(opts.dataDir);
    connections = grok.createConnections();
    runtime = this.createRuntime();
    viewers = this.createViewers();
    localPending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

    private createRuntime() {
      return grok.createRuntime({
        loadActivity:(id,before)=>actionStore.workspaceCards(id,before),
        saveActivity:(id,cards)=>actionStore.saveWorkspaceCards(id,cards),
        onChanged:()=>this.send({t:'workspaceChanged'}),
      });
    }
    private createViewers() {
      return new ComputerViewer(this.runtime, {origin:()=>`http://127.0.0.1:${(http_.address() as import('node:net').AddressInfo).port}`,fetch:opts.fetch});
    }

    async localTool(botId: string, name: string, input: Record<string, unknown>) {
      const tool = LOCAL_TOOLS.find((t) => t.name === name)!;
      const invalid = argumentError(tool.parameters, input);
      if (invalid) return { kind: 'served' as const, output: { error: invalid } };
      if (name === 'list_call_actions') return { kind: 'served' as const, output: { actions: actionStore.list().filter((a) => a.botId === botId && a.tool !== 'list_call_actions').map(({ input, result, ...a }) => a) } };
      if (name === 'resolve_call_approval') {
        const a = actionStore.get(String(input.id));
        if (a?.botId !== botId) return { kind: 'served' as const, output: { error: 'This approval does not belong to you.' } };
        const action = await actions.resolve(String(input.id), input.decision as 'approve' | 'deny', (id, approval, decision) => grok.resolveApproval(id, approval, decision));
        this.actionsChanged(botId);
        return { kind: 'served' as const, output: { id: action.id, status: action.status, approval: action.approval } };
      }
      if (name === 'mac_browser') return { kind: 'served' as const, output: await this.browser.run(input) };
      const id = crypto.randomUUID();
      const output = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.localPending.delete(id); reject(new Error('This Mac did not answer; outcome unknown. Do not retry a press automatically.')); }, name === 'mac_observe' ? 60_000 : 15_000);
        this.localPending.set(id, { resolve, reject, timer });
        this.send({ t: 'localTool', id, tool: name, input });
      });
      return { kind: 'served' as const, output };
    }

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
      this.connections.close();
      this.viewers.closeAll(); this.runtime.close();
      void this.browser.close();
      for (const p of this.localPending.values()) { clearTimeout(p.timer); p.reject(new Error('The Mac app disconnected; outcome unknown.')); }
      this.localPending.clear();
      if (client === this) client = null;
      this.stopCall();
    }

    onMessage(data: RawData, isBinary: boolean) {
      if (isBinary) {
        const mic = decodeMic(data as Buffer);
        if (mic && this.call) {
          this.call.micAudio(mic.pcm, mic.level);
          this.logMic(mic.level);
        }
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
      const op = String(msg?.op);
      const { op: _op, req: _req, ...args } = msg ?? {};
      this.log?.write('app', { op, args: ['connections', 'workspace'].includes(op) ? { action: msg.action } : args });
      Promise.resolve()
        .then(() => this.run(op, msg ?? {}))
        .then(
          (result) => this.send({ t: 'reply', req, ok: true, result: result ?? null }),
          (err) => {
            this.log?.write('app-error', { op, error: ['connections', 'workspace'].includes(op) ? 'Connection command failed' : (err as Error).message });
            const signedOut = err instanceof SignedOutError;
            if(signedOut){
              this.viewers.closeAll();this.runtime.close();this.runtime=this.createRuntime();
              this.viewers=this.createViewers();
            }
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
        case 'localConfig':
          this.browser.enabled = m.browser === true;
          if (!this.browser.enabled) await this.browser.close();
          return;
        case 'localResult': {
          const pending = this.localPending.get(str(m.id, 'id'));
          if (!pending) throw new ClientError('That local request expired.');
          this.localPending.delete(String(m.id));
          clearTimeout(pending.timer);
          pending.resolve(m.error ? { error: String(m.error) } : { text: String(m.text ?? '') });
          return;
        }
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
          this.connections.close();
          this.viewers.closeAll(); this.runtime.close(); this.runtime = this.createRuntime();
          this.viewers = this.createViewers();
          store.clear();
          this.bots = [];
          return login.state();
        case 'workspace': {
          const botId = str(m.botId, 'botId'), action = str(m.action, 'action');
          if (action === 'computerOpen') return this.viewers.open(botId, typeof m.monitor === 'string' ? m.monitor : undefined);
          if (action === 'computerControl') return this.viewers.control(str(m.viewerId, 'viewerId'), m.enabled === true, botId);
          if (action === 'computerViewState') return this.viewers.validateState(str(m.viewerId, 'viewerId'), botId);
          if (action === 'computerClose') return this.viewers.disconnect(str(m.viewerId, 'viewerId'), botId);
          const writes = ['cardControl','routineCreate','routineUpdate','routineDelete','routineEnable','routineRun','skillCreate','skillUpdate','skillDelete','skillEnable','memoryShare','libraryPin','pluginEnable','cardDecision','cardRespond','draftSend','draftDiscard','phoneControl','mcpCall','paymentBegin','paymentFinish','teachStart','teachStop','fileUploadFinish','handBack'];
          if (!writes.includes(action)) return this.runtime.command(botId, action, m);
          const identity = await this.runtime.identity(botId);
          const requestAction = ['cardControl','draftSend','draftDiscard','cardRespond','cardDecision','paymentFinish'].includes(action);
          const dedupeKey = requestAction && typeof m.id==='string' ? `workspace-request:${identity.agentId}:${m.id}` : null;
          if(dedupeKey&&actionStore.dedupe(dedupeKey,0))throw new Error('This request was already submitted or its outcome is unknown. Refresh this bot’s activity before trying again.');
          const record = actionStore.create({dedupeKey,callId: this.call ? `${this.call.callId}-${botId}` : 'workspace', botId, botName: identity.name, target: 'app', tool: action, input: {action,...(typeof m.id==='string'?{entryId:m.id}:{})}});
          try {
            const result = await this.runtime.command(botId, action, m);
            actionStore.update(record.id, {status:'completed', summary:'The provider accepted the workspace request.'});
            this.actionsChanged(botId);
            return result;
          } catch (error) {
            const uncertain = /outcome unknown|did not answer|network|fetch failed|timeout/i.test((error as Error).message);
            actionStore.update(record.id, {status:uncertain?'unknown':'failed', error:uncertain?'Outcome unknown. Inspect this bot’s activity before retrying.':'The workspace request failed. Refresh its state before retrying.'});
            this.actionsChanged(botId);
            throw error;
          }
        }
        case 'connections':
          return this.connections.command(str(m.action, 'action'), m);
        case 'bots':
          return { bots: await this.refreshBots() };
        case 'join':
          return this.join(m.botIds, m.continueFrom, null, parseMeeting(m.meeting));
        case 'meetingLine': {
          const call = this.inCall();
          if (call.kind !== 'meeting') throw new ClientError('this call is not listening to a meeting');
          if (m.who !== 'meeting' && m.who !== 'host') throw new ClientError('who must be meeting or host');
          if (typeof m.text !== 'string') throw new ClientError('text must be text');
          return { kept: call.meetingLine(m.who, m.text) };
        }
        case 'setWhisper': {
          const call = this.inCall();
          if (call.kind !== 'meeting') throw new ClientError('this call is not listening to a meeting');
          if (m.mode !== 'text' && m.mode !== 'voice') throw new ClientError('mode must be text or voice');
          call.setWhisper(m.mode);
          return { whisper: m.mode };
        }
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
        // While leaving, the bots are already quiet and the mic is ignored: nothing to do, and not an error.
        case 'stop':
          return void (this.ending || this.inCall().stopAll());
        case 'mute':
          return void (this.ending || this.inCall().setMuted(m.muted === true));
        case 'setVoice':
          return this.setVoice(str(m.botId, 'botId'), parseVoiceSettings(m.settings));
        case 'createBot': {
          const bot = await grok.createBot(parseNewBot(m.bot));
          await this.refreshBots();
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
        case 'botResources': {
          const id = str(m.botId, 'botId');
          await this.freshBots();
          const meta = grok.botMeta(id);
          const [skills, routines, files] = await Promise.all([grok.skills(meta.uuid), grok.routines(meta.uuid), grok.files(id)]);
          return { text: JSON.stringify({ skills, routines, files }, null, 2) };
        }
        case 'actions':
          return { actions: actionStore.list({ limit: ACTIONS_SHOWN }).map(({ result, input, ...a }) => a) };
        case 'action':
          return { action: actionStore.get(str(m.id, 'id')) };
        case 'resolveApproval': {
          if (m.decision !== 'approve' && m.decision !== 'deny') throw new ClientError('decision must be approve or deny');
          const action = await actions.resolve(str(m.id, 'id'), m.decision, (id, approval, decision) => grok.resolveApproval(id, approval, decision));
          this.actionsChanged(action.botId);
          return { action };
        }
        case 'calls':
          return { calls: calls.listCalls() };
        case 'library': {
          if (m.query !== undefined && m.query !== null && typeof m.query !== 'string') throw new ClientError('query must be text');
          if (m.kind !== undefined && m.kind !== null && !CALL_KINDS.includes(m.kind as CallKind)) throw new ClientError('kind must be call or meeting');
          const limit = m.limit === undefined || m.limit === null ? undefined : int(m.limit, 'limit');
          const before = m.before === undefined || m.before === null ? undefined : int(m.before, 'before');
          return { ...needLibrary().list({ query: (m.query as string | null) ?? '', limit, before, kind: (m.kind as CallKind | null) ?? undefined }), total: needLibrary().count() };
        }
        case 'libraryCall': {
          const found = this.libraryGet(str(m.id, 'id'));
          let markdown: string | null = null;
          try {
            markdown = calls.readCall(found.call.file);
          } catch {
            // the file was removed outside the app: the index still has its words
          }
          return { ...found, markdown };
        }
        case 'libraryDelete':
          return this.libraryDelete(str(m.id, 'id'));
        case 'incoming':
          return incoming.state();
        case 'scheduleSave': {
          const known = new Set((await this.refreshBots()).map((b) => b.id));
          let schedule: unknown = null;
          const state = this.incomingDo(() => (schedule = incoming.saveSchedule(m.schedule, known)));
          return { schedule, ...state };
        }
        case 'scheduleDelete':
          return this.incomingDo(() => incoming.deleteSchedule(str(m.id, 'id')));
        case 'scheduleRingNow':
          return this.incomingDo(() => incoming.ringNow(str(m.id, 'id')));
        case 'incomingSettings':
          return this.incomingDo(() => incoming.setSettings(m.settings));
        case 'ringAnswer':
          return this.answer(str(m.id, 'id'));
        case 'ringDecline':
          return this.incomingDo(() => incoming.decline(str(m.id, 'id')));
        case 'ringSnooze':
          return this.incomingDo(() => incoming.snooze(str(m.id, 'id'), m.minutes));
        case 'callbackCancel':
          return this.incomingDo(() => incoming.cancelCallback(str(m.id, 'id')));
        case 'missedClear':
          return this.incomingDo(() => incoming.clearMissed());
        case 'callFile':
          return { markdown: calls.readCall(str(m.file, 'file')) };
        default:
          throw new ClientError(`unknown op "${op}"`);
      }
    }

    /** Reloads the bot list; a call in progress learns about new bots too. */
    async refreshBots(): Promise<Bot[]> {
      this.bots = await grok.listBots();
      this.call?.setAvailable(this.bots);
      // Bots deleted in Grok Bot no longer call or are called (an empty list may be a hiccup, so it changes nothing).
      if (this.bots.length) incoming.forgetBots(new Set(this.bots.map((b) => b.id)));
      return this.bots;
    }

    async freshBots(): Promise<Bot[]> {
      if (!this.bots.length) this.bots = await grok.listBots();
      return this.bots;
    }

    /** Runs an incoming-call change; its refusals are the app's mistakes. Replies with the new state. */
    incomingDo(fn: () => unknown) {
      try {
        fn();
      } catch (err) {
        if (err instanceof IncomingError) throw new ClientError(err.message);
        throw err;
      }
      return incoming.state();
    }

    /** You picked up a ring (or called back a missed one): its bots join, and the one that called opens. */
    async answer(id: string) {
      if (this.call) throw new ClientError('Leave the current call first.');
      let ring: Ring;
      try {
        ring = incoming.answer(id);
      } catch (err) {
        throw err instanceof IncomingError ? new ClientError(err.message) : err;
      }
      try {
        const all = await grok.listBots();
        const ids = ring.botIds.filter((b) => all.some((x) => x.id === b));
        if (!ids.length) throw new ClientError('The bots in that call are not on this account any more.');
        const opening: CallOpening = {
          source: ring.source,
          // A bot's own ring has just that bot, and it is still on the account (ids is not empty).
          botId: ring.source === 'schedule' ? null : ring.botIds[0],
          callerName: ring.source === 'schedule' ? null : all.find((b) => b.id === ring.botIds[0])!.name,
          title: ring.title,
          reason: ring.reason,
          agenda: ring.agenda,
        };
        return { ...(await this.join(ids, null, opening)), ring: ring.id };
      } catch (err) {
        incoming.answerFailed(id, (err as Error).message);
        throw err;
      }
    }

    /** A saved call by id; a bad or unknown id is the app's mistake. */
    libraryGet(id: string) {
      try {
        const found = needLibrary().get(id);
        if (found) return found;
      } catch (err) {
        if (!(err instanceof LibraryError)) throw err;
      }
      throw new ClientError('That call is not in your call history any more.');
    }

    /** Forgets a call: its file, its index entry, and its summary if the next call would start from it. */
    libraryDelete(id: string) {
      const { call: c } = this.libraryGet(id);
      calls.deleteCall(c.file);
      needLibrary().remove(c.id);
      const memory = calls.readMemory();
      if (memory?.summary && c.summary && memory.summary === c.summary) calls.writeMemory({ ...memory, summary: '' });
      return { deleted: c.id };
    }

    async join(raw: unknown, continueFrom: unknown = undefined, opening: CallOpening | null = null, meeting: MeetingInfo | null = null) {
      if (this.call) throw new ClientError('already in a call');
      if (!Array.isArray(raw) || !raw.length || !raw.every((x) => typeof x === 'string')) throw new ClientError('botIds must be a list of bot ids');
      const continued = continueFrom === undefined || continueFrom === null ? null : this.libraryGet(str(continueFrom, 'continueFrom')).call;
      const all = await grok.listBots();
      this.bots = all;
      const picked = all.filter((b) => raw.includes(b.id));
      if (picked.length !== new Set(raw).size) throw new NotFoundError('Some of those bots are not on this account any more.');
      const log = new CallLog(opts.dataDir);
      // Sessions and tool calls only happen for a bot that is in the call, so it always has a link.
      const name = (id: string): string => call.links.get(id)!.bot.name;
      log.write('join', { bots: picked.map((b) => b.name) });
      const call = new OverlayCall({
        mintVoice: async (id: string) => { const voice = await grok.voiceSession(id); return { ...voice, tools: [...voice.tools, ...LOCAL_TOOLS] }; },
        // A bot used one of its own Grok Bot call tools (send_task, search_conversations): Grok Bot runs it.
        callTool: async (id: string, req: ToolCall) => {
          log.write('grok-tool', { bot: name(id), req });
          try {
            const r = await actions.tool(id, name(id), req);
            log.write('grok-tool-result', { bot: name(id), result: r });
            return r;
          } catch (err) {
            log.write('grok-tool-failed', { bot: name(id), error: (err as Error).message });
            throw err;
          }
        },
        // What a bot's agent sent back about its jobs: Grok Bot's work_landed, which the bot then tells Shashank.
        landedWork: async (id: string, callId: string, after: number) => {
          const work = actions.updates(id, callId, after);
          if (work.length) log.write('landed', { bot: name(id), work });
          return work;
        },
        // Everything sent and received on a bot's voice socket is logged under its name.
        openSocket: (url: string, protocols: string[], botId: string) => loggedSocket(openSocket(url, protocols) as any, name(botId), log),
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
      call.log = log;
      call.pastCalls = library;
      call.callBacks = {
        callBack: (botId, botName, args) => {
          const when = callbackWhen(args, iclock.now(), zone());
          // when_job_done waits for this bot's jobs from this call that are still under way.
          const waitsFor = when.jobs
            ? actionStore.list({ callId: `${call.callId}-${botId}` }).filter((a) => a.target === 'agent' && (a.status === 'running' || a.status === 'waiting_approval')).sort((x, y) => x.createdAt - y.createdAt).map((a) => a.id)
            : [];
          const c = incoming.addCallback(botId, botName, typeof args.reason === 'string' ? args.reason : '', { at: when.at, waitsFor });
          if (c.at === null) return `Call back set: Grok Call rings ${USER} once your ${c.waitsFor.length === 1 ? 'job finishes' : `${c.waitsFor.length} jobs finish`}, and you open that call with the result.`;
          const at = new Date(c.at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: zone() });
          return `Call back set: Grok Call rings ${USER} at ${at}, and you open that call. Tell him in a few words.`;
        },
      };
      this.log = log;
      this.mic = new MicStats(Date.now());
      call.joinWith(picked, all, calls.readMemory(), { continued, opening, meeting });
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
      let file: string | null = null;
      try {
        if (data.saveWorthy) file = calls.saveCall(data.memory, overlayMarkdown(data, (ms) => new Date(ms).toLocaleString()));
        this.log?.write('saved', { file, logFile: data.logFile });
        // The file is saved either way; a failed index is rebuilt from it at the next start.
        if (file && library) {
          try {
            library.index({ file, kind: data.kind, startedAt: data.startedAt, endedAt: data.endedAt, bots: data.bots, summary: data.summary, decisions: data.decisions, actionItems: data.actionItems, lines: data.lines });
          } catch (err) {
            this.log?.write('library-error', { error: (err as Error).message });
          }
        }
      } finally {
        // Even if saving fails, the call ends: the bots hang up and a new call can start.
        this.stopCall();
        this.send({ t: 'ended' });
      }
      return { file, id: file ? callIdOf(file) : null, summary: data.summary, decisions: data.decisions, actionItems: data.actionItems };
    }

    /** A bot's agent sent something: the call hears it now (not at its next check), and the app's list refreshes. */
    actionsChanged(botId: string) {
      const link = this.call?.links.get(botId);
      if (link && link.landedTimer !== null) {
        this.call!.d.clearTimer(link.landedTimer);
        link.landedTimer = null;
        void link.checkLanded();
      }
      this.send({ t: 'actions', actions: actionStore.list({ limit: ACTIONS_SHOWN }).map(({ result, input, ...a }) => a) });
    }

    stopCall() {
      const ended = this.call;
      for (const id of ended?.links.keys() ?? []) {
        actions.callEnded(id);
        // Its jobs still under way are remembered, so finishing after the call can ring.
        incoming.observe(actionStore.list({ callId: `${ended!.callId}-${id}` }).map(actionView), ended!.callId);
      }
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.call?.leave(); // closing the bots' sockets is logged too, so the log ends after it
      this.call = null;
      this.ending = null;
      this.log?.write('end');
      this.log?.close();
      this.log = null;
      if (ended) incoming.freed();
    }

    /** Once a second during a call: how loud the mic was, who heard it, and whether a bot was playing. */
    logMic(level: number) {
      const call = this.call!;
      this.mic.add(level);
      const s = this.mic.take(Date.now());
      if (s) {
        this.log!.write('mic', { ...s, ear: call.ear?.bot.name ?? null, botPlaying: call.player.remainingMs() > 0, userSpeaking: call.userSpeaking, muted: call.muted });
      }
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
      watcher.stop();
      actionStore.recoverInterrupted();
      actionStore.close();
      library?.close();
      incoming.stop();
    },
  };
}

export { BadSetting, ClientError };
