// The record of every action a bot takes from a call: written before it is dispatched, updated as it runs, kept after
// the call. SQLite (node:sqlite), so a state change and its deduplication happen in one transaction even when several
// bots finish at once.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ACTION_STATUSES = ['running', 'waiting_approval', 'completed', 'failed', 'unknown'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
/** Where the action runs: the bot's Grok agent, a connected app, a folder on this Mac, the browser, a shared window. */
export const ACTION_TARGETS = ['agent', 'app', 'mac', 'browser', 'screen'] as const;
export type ActionTarget = (typeof ACTION_TARGETS)[number];
/** Longest result kept in full; a longer one is cut with a note. */
export const RESULT_MAX = 2_000_000;

export interface Approval {
  /** auto_review: a Grok approval card; local_tool: an action on this Mac waiting for its OK; connector: connect an app. */
  kind: 'auto_review' | 'local_tool' | 'connector';
  requestId: string;
  /** The chat entry that asked (local tool asks are resolved by entry). */
  entryId: string | null;
  summary: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
}

export interface Action {
  id: string;
  callId: string;
  botId: string;
  botName: string;
  target: ActionTarget;
  tool: string;
  input: unknown;
  status: ActionStatus;
  /** The job's request id in the bot's chat, once found. */
  requestId: string | null;
  /** Short result for voice and the list. */
  summary: string | null;
  /** Full result (text or JSON). */
  result: string | null;
  error: string | null;
  approval: Approval | null;
  createdAt: number;
  updatedAt: number;
}

export interface ActionEvent {
  botId: string;
  /** The chat entry's place in the bot's chat. */
  seq: number;
  callId: string;
  actionId: string | null;
  /** reply: the agent answered a job; approval: it waits for an OK; written: Shashank typed in the bot's chat. */
  kind: 'reply' | 'approval' | 'written';
  text: string;
  at: number;
}

export type NewAction = Pick<Action, 'callId' | 'botId' | 'botName' | 'target' | 'tool' | 'input'> & { dedupeKey?: string | null };
export type ActionPatch = Partial<Pick<Action, 'status' | 'requestId' | 'summary' | 'result' | 'error' | 'approval'>>;

const FILE = 'actions.sqlite';
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS actions (
    id TEXT PRIMARY KEY, call_id TEXT NOT NULL, bot_id TEXT NOT NULL, bot_name TEXT NOT NULL, target TEXT NOT NULL,
    tool TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, request_id TEXT, summary TEXT, result TEXT,
    error TEXT, approval TEXT, dedupe_key TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS actions_open ON actions (status, target, updated_at);
  CREATE INDEX IF NOT EXISTS actions_request ON actions (bot_id, request_id);
  CREATE INDEX IF NOT EXISTS actions_dedupe ON actions (dedupe_key, created_at);
  CREATE TABLE IF NOT EXISTS events (
    bot_id TEXT NOT NULL, seq INTEGER NOT NULL, call_id TEXT NOT NULL, action_id TEXT, kind TEXT NOT NULL,
    text TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (bot_id, seq));
  CREATE INDEX IF NOT EXISTS events_call ON events (bot_id, call_id, seq);
  CREATE TABLE IF NOT EXISTS cursors (bot_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);`;

function cut(text: string | null): string | null {
  if (text === null || text.length <= RESULT_MAX) return text;
  return `${text.slice(0, RESULT_MAX)}\n[cut: the full result was ${text.length} characters]`;
}

export class ActionStore {
  readonly file: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  /** Opens <dir>/actions.sqlite (readable by this user only). A file that is not a usable database is set aside. */
  constructor(dir: string, now: () => number = Date.now) {
    this.now = now;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, FILE);
    this.db = this.open();
    for (const f of [this.file, `${this.file}-wal`, `${this.file}-shm`]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
  }

  private open(): DatabaseSync {
    try {
      return this.prepare(new DatabaseSync(this.file));
    } catch (err) {
      if (![11, 26].includes((err as any).errcode)) throw err;
      // Not a database (or damaged): keep it for inspection and start a fresh history.
      fs.renameSync(this.file, `${this.file}.broken-${this.now()}`);
      for (const f of [`${this.file}-wal`, `${this.file}-shm`]) fs.rmSync(f, { force: true });
      return this.prepare(new DatabaseSync(this.file));
    }
  }

  private prepare(db: DatabaseSync): DatabaseSync {
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;');
      db.exec(SCHEMA);
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  /** Called once by the owning backend at startup; direct tools are never blindly replayed. */
  recoverInterrupted() {
    if (!this.db.isOpen) return;
    this.db.prepare("UPDATE actions SET status = 'unknown', error = 'The app stopped before the result was recorded. Verify the outcome before retrying.', updated_at = ? WHERE status = 'running' AND target != 'agent'").run(this.now());
  }

  /** Runs `fn` in one transaction. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  create(a: NewAction): Action {
    const at = this.now();
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO actions (id, call_id, bot_id, bot_name, target, tool, input, status, dedupe_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, a.callId, a.botId, a.botName, a.target, a.tool, JSON.stringify(a.input ?? null), 'running', a.dedupeKey ?? null, at, at);
    return this.get(id)!;
  }

  update(id: string, patch: ActionPatch): Action {
    const cols: string[] = [];
    const vals: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null) => (cols.push(`${col} = ?`), vals.push(v));
    if (patch.status !== undefined) {
      if (!ACTION_STATUSES.includes(patch.status)) throw new Error(`unknown action status "${patch.status}"`);
      set('status', patch.status);
    }
    if (patch.requestId !== undefined) set('request_id', patch.requestId);
    if (patch.summary !== undefined) set('summary', patch.summary);
    if (patch.result !== undefined) set('result', cut(patch.result));
    if (patch.error !== undefined) set('error', patch.error);
    if (patch.approval !== undefined) set('approval', patch.approval === null ? null : JSON.stringify(patch.approval));
    set('updated_at', this.now());
    const r = this.db.prepare(`UPDATE actions SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
    if (r.changes === 0) throw new Error(`no action ${id}`);
    return this.get(id)!;
  }

  get(id: string): Action | null {
    const row = this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id);
    return row ? toAction(row) : null;
  }

  /** Newest first; optionally one call's. */
  list(opts: { limit?: number; callId?: string } = {}): Action[] {
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
    const rows = opts.callId
      ? this.db.prepare('SELECT * FROM actions WHERE call_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(opts.callId, limit)
      : this.db.prepare('SELECT * FROM actions ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit);
    return rows.map(toAction);
  }

  /**
   * Background jobs (send_task; a search answers at once) still worth watching: running or waiting for approval and younger than `maxAgeMs`, or answered within
   * the last `quietMs` (an agent often says "on it" first and sends the result later).
   */
  watchedJobs(maxAgeMs: number, quietMs: number): Action[] {
    const now = this.now();
    return this.db
      .prepare(
        `SELECT * FROM actions WHERE target = 'agent' AND tool = 'send_task' AND created_at >= ? AND
         (status IN ('running', 'waiting_approval', 'unknown') OR updated_at >= ?) ORDER BY created_at`,
      )
      .all(now - maxAgeMs, now - quietMs)
      .map(toAction);
  }

  byRequest(botId: string, requestId: string): Action | null {
    const row = this.db.prepare('SELECT * FROM actions WHERE bot_id = ? AND request_id = ? ORDER BY created_at DESC LIMIT 1').get(botId, requestId);
    return row ? toAction(row) : null;
  }

  /** The newest action with this dedupe key created since `sinceMs` that did not fail. */
  dedupe(key: string, sinceMs: number): Action | null {
    const row = this.db
      .prepare(`SELECT * FROM actions WHERE dedupe_key = ? AND (created_at >= ? OR status IN ('running', 'unknown')) AND status != 'failed' ORDER BY created_at DESC LIMIT 1`)
      .get(key, sinceMs);
    return row ? toAction(row) : null;
  }

  /** Records one chat entry. False if that entry was already recorded (a replay). */
  addEvent(e: ActionEvent): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO events (bot_id, seq, call_id, action_id, kind, text, at) VALUES (?,?,?,?,?,?,?)')
      .run(e.botId, e.seq, e.callId, e.actionId, e.kind, e.text, e.at);
    return r.changes === 1;
  }

  events(actionId: string): ActionEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE action_id = ? ORDER BY seq').all(actionId).map(toEvent);
  }

  /** What reached one bot's call after `afterSeq`, oldest first. */
  eventsForCall(botId: string, callId: string, afterSeq: number): ActionEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE bot_id = ? AND call_id = ? AND seq > ? ORDER BY seq').all(botId, callId, afterSeq).map(toEvent);
  }

  /** The last chat entry read for a bot, or null if it was never read. */
  cursor(botId: string): number | null {
    const row = this.db.prepare('SELECT seq FROM cursors WHERE bot_id = ?').get(botId) as { seq: number } | undefined;
    return row ? row.seq : null;
  }

  setCursor(botId: string, seq: number) {
    this.db.prepare('INSERT INTO cursors (bot_id, seq) VALUES (?, ?) ON CONFLICT (bot_id) DO UPDATE SET seq = excluded.seq').run(botId, seq);
  }

  /** Closes the file; closing again does nothing. */
  close() {
    if (this.db.isOpen) this.db.close();
  }
}

function json(text: unknown): any {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toAction(r: any): Action {
  return {
    id: r.id, callId: r.call_id, botId: r.bot_id, botName: r.bot_name, target: r.target, tool: r.tool,
    input: json(r.input), status: r.status, requestId: r.request_id, summary: r.summary, result: r.result,
    error: r.error, approval: json(r.approval), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

function toEvent(r: any): ActionEvent {
  return { botId: r.bot_id, seq: Number(r.seq), callId: r.call_id, actionId: r.action_id, kind: r.kind, text: r.text, at: Number(r.at) };
}
