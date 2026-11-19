// Watches the chats of bots with background jobs (and of bots in a live call) and records what their agents send back:
// answers, approval cards, actions waiting for an OK on this Mac, and what Shashank types in a bot's chat during a call.
// It runs in the backend, apart from the voice sockets, so a job finishes in the history even after the call ends.
import { type Action, type ActionStore, type Approval } from './actions.ts';
import { LANDED_TEXT_MAX, landedText, type TranscriptEntry } from './grokbot.ts';
import { USER } from '../public/core.js';

/** Checks this often while a bot has a job younger than JOB_FAST_MS, or is in a live call. */
export const JOB_POLL_MS = 3000;
export const JOB_FAST_MS = 120_000;
/** Otherwise this often. */
export const JOB_SLOW_POLL_MS = 15_000;
/** Jobs are watched this long after they start. */
export const JOB_MAX_AGE_MS = 24 * 3600_000;
/** An answered job is still watched this long after its last update (an agent says "on it", then the result). */
export const JOB_QUIET_MS = 30 * 60_000;
/** Short form of a reply for the list and voice. */
export const SUMMARY_MAX = 400;
/** Entries are trusted from this long before a bot's first check (clock skew between here and Grok). */
export const FIRST_READ_SKEW_MS = 5000;

export interface TranscriptSource {
  transcript(botId: string, afterSeq: number | null): Promise<{ entries: TranscriptEntry[]; newest: number | null; gap: boolean }>;
}

export interface WatcherOptions {
  grok: TranscriptSource;
  store: ActionStore;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: any) => void;
  now: () => number;
  /** Something new for this bot was recorded (the call can deliver it now instead of at its next check). */
  onChange?: (botId: string) => void;
  log?: (kind: string, data: object) => void;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** What a Mac tool ask is about, as the Grok Bot app shows it. */
export function askTarget(ask: any): string {
  if (str(ask?.action) === 'use-app' && str(ask?.recipientName)) return str(ask.recipientName);
  return str(ask?.target).trim() || str(ask?.description).trim() || 'an action on this Mac';
}

/** A chat entry's approval request, or null if it is not one. */
export function approvalOf(entry: TranscriptEntry): Approval | null {
  const m = entry.body?.message;
  if (entry.body?.kind !== 'send-message' || !m) return null;
  const status = (s: string): Approval['status'] => (s === 'pending' || !s ? 'pending' : s === 'allowed' || s === 'always' || s === 'approved' ? 'approved' : s === 'denied' || s === 'never' ? 'denied' : 'expired');
  if (m.type === 'local-tool-permission' && str(m.ask?.requestId)) {
    return { kind: 'local_tool', requestId: m.ask.requestId, entryId: str(entry.body.id) || null, summary: askTarget(m.ask), status: status(str(m.ask.status)) };
  }
  if (m.type === 'auto-review-approval' && str(m.approval?.requestId)) {
    return { kind: 'auto_review', requestId: m.approval.requestId, entryId: str(entry.body.id) || null, summary: str(m.approval.summary).trim() || 'an action it wants to take', status: status(str(m.approval.status)) };
  }
  if (m.type === 'connector') {
    return { kind: 'connector', requestId: str(entry.body.requestId) || str(entry.body.id), entryId: str(entry.body.id) || null, summary: `${str(m.connector).trim() || 'an app'} ${m.variant === 'connect' ? 'connected' : 'signed in again'}`, status: 'pending' };
  }
  return null;
}

/** What the bot is told about an approval. */
export function approvalText(a: Approval): string {
  if (a.kind === 'local_tool') return `It is waiting for ${USER}'s OK to run this on their Mac: ${a.summary}. They can allow it in Alotbot or the Grok Bot app.`;
  if (a.kind === 'auto_review') return `It is waiting for ${USER}'s approval: ${a.summary}. They can approve it in Alotbot or the Grok Bot app.`;
  return `It needs ${a.summary} in Alotbot’s Connections first.`;
}

interface Live {
  callId: string;
  since: number;
}

export class JobWatcher {
  private readonly o: WatcherOptions;
  private timers = new Map<string, { t: unknown; due: number }>();
  private busy = new Set<string>();
  /** Bots in a live call: their call id (the bot's own, as Grok Bot knows it) and when the call started. */
  private live = new Map<string, Live>();
  /** When each bot was first watched, for the first read (no cursor yet). */
  private firstSeen = new Map<string, number>();
  private stopped = false;

  constructor(o: WatcherOptions) {
    this.o = o;
  }

  /** On start: keep watching the jobs that were still open when the app last closed. */
  resume() {
    for (const action of this.o.store.watchedJobs(JOB_MAX_AGE_MS, JOB_QUIET_MS)) {
      const seen = this.firstSeen.get(action.botId);
      this.firstSeen.set(action.botId, Math.min(seen ?? action.createdAt, action.createdAt));
      this.schedule(action.botId, 0);
    }
  }

  /** A job was just recorded (before it is dispatched): watch its bot's chat, often. */
  noteJob(action: Action) {
    this.firstSeen.has(action.botId) || this.firstSeen.set(action.botId, this.o.now());
    this.schedule(action.botId, JOB_POLL_MS);
  }

  /** A bot is in a live call: what Shashank types in its chat is passed to the call too. */
  callStarted(botId: string, callId: string) {
    this.live.set(botId, { callId, since: this.o.now() });
    this.firstSeen.has(botId) || this.firstSeen.set(botId, this.o.now());
    this.schedule(botId, 0);
  }

  callEnded(botId: string) {
    this.live.delete(botId);
  }

  stop() {
    this.stopped = true;
    for (const { t } of this.timers.values()) this.o.clearTimer(t);
    this.timers.clear();
  }

  /** Checks the bot in `ms`, or sooner if a check is already due sooner. A check under way schedules the next. */
  private schedule(botId: string, ms: number) {
    if (this.stopped || this.busy.has(botId)) return;
    const due = this.o.now() + ms;
    const pending = this.timers.get(botId);
    if (pending && pending.due <= due) return;
    if (pending) this.o.clearTimer(pending.t);
    const t = this.o.setTimer(() => {
      this.timers.delete(botId);
      void this.check(botId);
    }, ms);
    this.timers.set(botId, { t, due });
  }

  private interval(botId: string): number | null {
    const jobs = this.o.store.watchedJobs(JOB_MAX_AGE_MS, JOB_QUIET_MS).filter((a) => a.botId === botId);
    if (!jobs.length && !this.live.has(botId)) return null;
    const recent = jobs.some((a) => this.o.now() - a.createdAt < JOB_FAST_MS);
    return recent || this.live.has(botId) ? JOB_POLL_MS : JOB_SLOW_POLL_MS;
  }

  /** One check of a bot's chat. Never throws; the next check tries again. */
  async check(botId: string) {
    if (this.stopped || this.busy.has(botId)) return;
    this.busy.add(botId);
    let changed = false;
    try {
      const cursor = this.o.store.cursor(botId);
      const { entries, newest, gap } = await this.o.grok.transcript(botId, cursor ?? (this.o.store.watchedJobs(JOB_MAX_AGE_MS, JOB_QUIET_MS).some((a) => a.botId === botId) ? 0 : null));
      if (this.stopped) return;
      if (gap) {
        this.o.log?.('jobs-gap', { botId, cursor });
        for (const action of this.o.store.watchedJobs(JOB_MAX_AGE_MS, JOB_QUIET_MS).filter((a) => a.botId === botId)) {
          this.o.store.update(action.id, { status: 'unknown', error: 'Grok repeated its transcript cursor; this history could not be reconciled. The previous cursor is retained and the next poll retries.' });
          changed = true;
        }
      } else {
        // First read of this bot: only what came after it was first watched counts; older history is not replayed.
        const since = cursor === null ? (this.firstSeen.get(botId) ?? this.o.now()) - FIRST_READ_SKEW_MS : null;
        this.o.store.tx(() => {
          for (const e of entries) {
            if (since !== null && !(Number(e.body?.timestampMs) >= since)) continue;
            changed = this.take(botId, e) || changed;
          }
          if (newest !== null && (cursor === null || newest > cursor)) this.o.store.setCursor(botId, newest);
        });
      }
    } catch (err) {
      this.o.log?.('jobs-error', { botId, error: (err as Error).message });
    } finally {
      this.busy.delete(botId);
    }
    if (this.stopped) return;
    if (changed) this.o.onChange?.(botId);
    const next = this.interval(botId);
    if (next !== null) this.schedule(botId, next);
  }

  /** Records one chat entry. True if something new was recorded. */
  private take(botId: string, e: TranscriptEntry): boolean {
    const b = e.body;
    const jobs = () => this.o.store.watchedJobs(JOB_MAX_AGE_MS, JOB_QUIET_MS).filter((a) => a.botId === botId);
    const channelCall = (ch: unknown) => (str(ch).startsWith('voice:') ? str(ch).slice('voice:'.length) : '');
    // Our own job message (the call relayed it on the bot's voice channel): learn its request id.
    if (b?.kind === 'message' && channelCall(b.channel) && str(b.requestId)) {
      const callId = channelCall(b.channel);
      const waiting = jobs().filter((a) => a.callId === callId && a.requestId === null);
      const match = waiting.find((a) => str((a.input as any)?.request).trim() === str(b.content).trim()) ?? waiting[0];
      if (match && !this.o.store.byRequest(botId, b.requestId)) this.o.store.update(match.id, { requestId: b.requestId });
      return false;
    }
    // Shashank typed (or attached a file) in the bot's chat while it is in a call.
    const live = this.live.get(botId);
    if (live && !channelCall(b?.channel) && Number(b?.timestampMs) >= live.since && (b?.kind === 'user-attachment' || (b?.kind === 'message' && b?.role === 'user' && !b?.fromAgent))) {
      const text = b.kind === 'user-attachment' ? `(attached a file: ${str(b.file_name) || 'a file'})` : str(b.content).trim();
      if (!text) return false;
      return this.o.store.addEvent({ botId, seq: e.seq, callId: live.callId, actionId: null, kind: 'written', text: text.slice(0, LANDED_TEXT_MAX), at: Number(b.timestampMs) });
    }
    if (b?.kind !== 'send-message') return false;
    // The agent sent something: to which job? By request id, else the newest open job on that voice channel.
    const callId = channelCall(b.message?.channel);
    const byRequest = str(b.requestId) ? this.o.store.byRequest(botId, b.requestId) : null;
    const action = byRequest ?? (callId ? jobs().filter((a) => a.callId === callId).at(-1) ?? null : null);
    if (!action && !callId) return false; // plain chat, not about a call
    const approval = approvalOf(e);
    const text = approval ? approvalText(approval) : landedText(b.message)?.slice(0, LANDED_TEXT_MAX) ?? '';
    if (!text) return false;
    const recorded = this.o.store.addEvent({
      botId, seq: e.seq, callId: action?.callId ?? callId, actionId: action?.id ?? null,
      kind: approval ? 'approval' : 'reply', text, at: Number(b.timestampMs) || this.o.now(),
    });
    if (!recorded || !action) return recorded;
    if (approval) {
      this.o.store.update(action.id, { status: approval.status === 'pending' ? 'waiting_approval' : 'running', approval });
    } else {
      const previous = action.result ? `${action.result}\n\n` : '';
      this.o.store.update(action.id, { status: 'completed', summary: text.slice(0, SUMMARY_MAX), result: previous + text });
    }
    return true;
  }
}
