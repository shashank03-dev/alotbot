import { localTarget } from './local-tools.ts';
// Every tool a bot uses from a call goes through here: the action is recorded before it is dispatched, then updated
// with what happened, so the Mac app (and a relaunch) can show it whatever the voice socket does.
import { APP_TOOLS } from './apps.ts';
import { type Action, type ActionStore, type ActionTarget, type Approval } from './actions.ts';
import { type ToolCall, type ToolOutcome } from './grokbot.ts';
import { type JobWatcher, SUMMARY_MAX } from './jobs.ts';

/** Longest tool result passed to a voice session; the rest stays in the action history. */
export const VOICE_RESULT_MAX = 40_000;
/** The same app call by the same bot in the same call within this long runs once. */
export const DEDUPE_MS = 15_000;
/** A call whose page or app has not asked for updates this long is over (for typed chat messages). */
export const LIVE_STALE_MS = 30_000;

export interface Dispatcher {
  harnessTool(botId: string, call: ToolCall): Promise<ToolOutcome>;
}

export interface Update {
  seq: number;
  at: number;
  kind: 'reply' | 'approval' | 'written';
  text: string;
  actionId: string | null;
}

const APP_NAMES = new Set(APP_TOOLS.map((t) => t.name));

/** Same JSON for the same value whatever the key order. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** What a voice session gets for a result: all of it, or a cut with a pointer to the full one. */
export function forVoice(output: unknown, actionId: string): unknown {
  const text = JSON.stringify(output ?? null);
  if (text.length <= VOICE_RESULT_MAX) return output;
  return {
    cut: true,
    note: `The result was ${text.length} characters; this is the first ${VOICE_RESULT_MAX}. The full result is saved in Alotbot (action ${actionId}). Ask again with narrower arguments if you need more.`,
    start: text.slice(0, VOICE_RESULT_MAX),
  };
}

/** True if a connector's answer says the tool itself failed (its error, not ours or the network's). */
export function connectorFailed(output: any): string | null {
  if (output && typeof output === 'object') {
    if (typeof output.error === 'string') return output.error;
    if (output.success?.isError === true) return JSON.stringify(output.success.content ?? 'tool error').slice(0, 500);
    for (const k of ['permissionDenied', 'rejected', 'error']) if (output[k] && typeof output[k] === 'object') return `${k}: ${JSON.stringify(output[k]).slice(0, 500)}`;
  }
  return null;
}

export class CallActions {
  readonly store: ActionStore;
  readonly watcher: JobWatcher;
  private readonly grok: Dispatcher;
  private readonly now: () => number;
  private readonly resolving = new Set<string>();
  private readonly running = new Map<string, Promise<ToolOutcome>>();
  /** Calls that asked for updates lately: bot -> its call id and when. */
  private readonly live = new Map<string, { callId: string; at: number }>();

  constructor(grok: Dispatcher, store: ActionStore, watcher: JobWatcher, now: () => number = Date.now) {
    this.grok = grok;
    this.store = store;
    this.watcher = watcher;
    this.now = now;
  }

  /** Runs one of a bot's Grok Bot or app tools, recorded. Throws like the tool would. */
  async tool(botId: string, botName: string, call: ToolCall): Promise<ToolOutcome> {
    const target: ActionTarget = localTarget(call.name) ?? (APP_NAMES.has(call.name) ? 'app' : 'agent');
    const isWrite = call.name === 'use_app_tool' || call.name === 'mac_browser' || call.name === 'mac_window';
    const key = isWrite ? `${call.callId}|${botId}|${stable(call.input)}` : null;
    if (key) {
      const same = this.store.dedupe(key, this.now() - DEDUPE_MS);
      if (same) {
        const inFlight = this.running.get(same.id);
        if (inFlight) return inFlight;
        return { kind: 'served', output: { duplicate: true, note: 'That exact action already ran a moment ago; it was not run again.', result: same.summary } };
      }
    }
    const action = this.store.create({ callId: call.callId, botId, botName, target, tool: call.name, input: call.input, dedupeKey: key });
    if (call.name === 'send_task') this.watcher.noteJob(action);
    const run = this.dispatch(action, botId, call);
    this.running.set(action.id, run);
    try {
      return await run;
    } finally {
      this.running.delete(action.id);
    }
  }

  private async dispatch(action: Action, botId: string, call: ToolCall): Promise<ToolOutcome> {
    let r: ToolOutcome;
    try {
      r = await this.grok.harnessTool(botId, call);
    } catch (err) {
      const why = (err as Error).message;
      // Once an action was sent, a failure may still have done it: its outcome is unknown, not failed.
      this.store.update(action.id, { status: call.name === 'use_app_tool' || call.name === 'send_task' || localTarget(call.name) ? 'unknown' : 'failed', error: why });
      throw err;
    }
    const text = JSON.stringify(r.output ?? null);
    if (r.kind !== 'served') {
      this.store.update(action.id, { status: 'failed', error: `${r.kind}: ${text.slice(0, 500)}`, result: text });
      return r;
    }
    if (call.name === 'send_task') {
      const accepted = (r.output as any)?.relay === 'accepted';
      this.store.update(action.id, accepted ? { result: null } : { status: 'failed', error: `not accepted: ${text.slice(0, 500)}`, result: text });
      return r;
    }
    const failed = connectorFailed(r.output);
    this.store.update(action.id, failed ? { status: 'failed', error: failed, result: text } : { status: 'completed', summary: text.slice(0, SUMMARY_MAX), result: text });
    return { kind: 'served', output: forVoice(r.output, action.id) };
  }

  /** Resolve the exact approval shown to the user; concurrent clicks cannot send it twice. */
  async resolve(id: string, decision: 'approve' | 'deny', send: (botId: string, approval: Approval, decision: 'approve' | 'deny') => Promise<void>): Promise<Action> {
    const action = this.store.get(id);
    if (!action || action.status !== 'waiting_approval' || action.approval?.status !== 'pending' || action.approval.kind === 'connector') throw new Error('This action has no pending approval.');
    if (this.resolving.has(id)) throw new Error('This approval is already being resolved.');
    this.resolving.add(id);
    try {
      await send(action.botId, action.approval, decision);
      return this.store.update(id, { status: decision === 'approve' ? 'running' : 'failed', approval: { ...action.approval, status: decision === 'approve' ? 'approved' : 'denied' }, error: decision === 'deny' ? 'Denied by the user.' : null });
    } finally { this.resolving.delete(id); }
  }

  /** What reached a bot's call since `afterSeq` (job answers, approvals, typed messages). Marks the call live. */
  updates(botId: string, callId: string, afterSeq: number): Update[] {
    const was = this.live.get(botId);
    if (was?.callId !== callId) this.watcher.callStarted(botId, callId);
    this.live.set(botId, { callId, at: this.now() });
    this.sweep();
    return this.store.eventsForCall(botId, callId, afterSeq).map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, text: e.text, actionId: e.actionId }));
  }

  /** The call (or the bot) left: stop passing typed messages on. */
  callEnded(botId: string) {
    this.live.delete(botId);
    this.watcher.callEnded(botId);
  }

  /** Calls that stopped asking for updates (a closed page, a crashed app) are over. */
  private sweep() {
    for (const [botId, l] of this.live) if (this.now() - l.at > LIVE_STALE_MS) this.callEnded(botId);
  }
}
