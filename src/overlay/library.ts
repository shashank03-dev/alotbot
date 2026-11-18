// Every saved call, searchable: summaries, decisions, action items and every transcript line, in SQLite with full-text
// search (FTS5). The Markdown files in calls/ stay the source a person reads and downloads; this index is rebuilt from
// them when it is missing or damaged, so losing it never loses a call.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const LIBRARY_FILE = 'call-library.sqlite';
/** Bumped when the schema changes: an index with another version is rebuilt from the Markdown files. */
export const LIBRARY_VERSION = 1;
export const CALL_KINDS = ['call', 'meeting'] as const;
export type CallKind = (typeof CALL_KINDS)[number];
/** Longest transcript line kept in the index (a saved line is already capped far below this). */
export const LINE_MAX = 4000;
export const LIST_MAX = 100;
export const QUERY_MAX = 200;
/** Words of a query that are searched; more are ignored. */
export const QUERY_WORDS = 12;
export const HITS_MAX = 20;

export interface LibraryLine {
  seq: number;
  who: string;
  text: string;
  cut: boolean;
}

export interface CallRecord {
  /** The Markdown file name without ".md". */
  id: string;
  file: string;
  kind: CallKind;
  startedAt: number;
  endedAt: number;
  bots: string[];
  summary: string;
  decisions: string[];
  actionItems: string[];
  lineCount: number;
}

export interface NewCallRecord {
  file: string;
  kind: CallKind;
  startedAt: number;
  endedAt: number;
  bots: string[];
  summary: string;
  decisions: string[];
  actionItems: string[];
  lines: { who: string; text: string; cut?: boolean }[];
}

export interface Hit {
  callId: string;
  startedAt: number;
  kind: CallKind;
  /** summary, decision, action or line. */
  field: string;
  who: string | null;
  /** The matching text, with the matched words marked «like this». */
  snippet: string;
}

export interface ListedCall extends CallRecord {
  /** The best matching snippet when the list was searched. */
  match: Hit | null;
}

export class LibraryError extends Error {}

const CALL_FILE = /^call-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?\.md$/;
export const isCallFile = (file: string) => CALL_FILE.test(file);
export const callIdOf = (file: string) => file.slice(0, -3);
export const fileOfId = (id: string) => {
  const file = `${id}.md`;
  if (!isCallFile(file)) throw new LibraryError('not a saved call id');
  return file;
};
/** When a call was saved, from its file name (ms). */
export const fileTime = (file: string) => Date.parse(file.slice(5, 25).replace(/T(\d{2})-(\d{2})-(\d{2})Z/, 'T$1:$2:$3Z'));

const oneLine = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const texts = (v: unknown, max: number, count: number) => (Array.isArray(v) ? v : []).map((x) => oneLine(x, max)).filter(Boolean).slice(0, count);

/**
 * A search for FTS5 built only from the words in `query`, so nothing in it is ever read as FTS syntax. Every word must
 * match (the last one as a prefix, as people type); `any` asks for any word instead. Null when there are no words.
 */
export function ftsQuery(query: string, any = false): string | null {
  const words = (String(query).slice(0, QUERY_MAX).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, QUERY_WORDS);
  if (!words.length) return null;
  return words.map((w, i) => (i === words.length - 1 && w.length >= 2 ? `"${w}"*` : `"${w}"`)).join(any ? ' OR ' : ' ');
}

/**
 * Reads a saved call's Markdown (what overlayMarkdown writes) back into a record. Parts it can't find are left
 * empty: an old or hand-edited file still becomes searchable.
 */
export function parseCallMarkdown(file: string, markdown: string): NewCallRecord {
  const sections = new Map<string, string>();
  const parts = markdown.split(/^## /m);
  for (const p of parts.slice(1)) {
    const nl = p.indexOf('\n');
    const title = (nl < 0 ? p : p.slice(0, nl)).trim();
    if (!sections.has(title)) sections.set(title, nl < 0 ? '' : p.slice(nl + 1));
  }
  const head = parts[0];
  const startedAt = fileTime(file);
  const minutes = Number(/^Length: (\d+) min/m.exec(head)?.[1] ?? 0);
  const bots = (/^Bots: (.*?)\s*$/m.exec(head)?.[1] ?? '').split(',').map((b) => b.trim()).filter((b) => b && b !== 'none');
  const kind: CallKind = /^Kind: meeting\s*$/m.test(head) ? 'meeting' : 'call';
  const list = (name: string) =>
    (sections.get(name) ?? '').split('\n').map((l) => /^- (?:\[[ x]\] )?(.+)$/.exec(l)?.[1]?.trim() ?? '').filter(Boolean);
  const summary = (sections.get('Summary') ?? '').trim();
  const lines: NewCallRecord['lines'] = [];
  for (const l of (sections.get('Transcript') ?? '').split('\n')) {
    const m = /^\*\*(.+?):\*\* (.*?)\s*$/.exec(l);
    if (!m) continue;
    const cut = / \(cut off by the host\)$/.test(m[1]);
    lines.push({ who: cut ? m[1].replace(/ \(cut off by the host\)$/, '') : m[1], text: m[2], cut });
  }
  return {
    file,
    kind,
    startedAt,
    endedAt: startedAt + minutes * 60_000,
    bots,
    summary: summary === '_No summary was saved._' ? '' : summary,
    decisions: list('Decisions'),
    actionItems: list('Action items'),
    lines,
  };
}

const SCHEMA = `
CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  bots TEXT NOT NULL,
  summary TEXT NOT NULL,
  decisions TEXT NOT NULL,
  action_items TEXT NOT NULL,
  line_count INTEGER NOT NULL
);
CREATE INDEX calls_started ON calls(started_at DESC, id DESC);
CREATE TABLE lines (
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  who TEXT NOT NULL,
  text TEXT NOT NULL,
  cut INTEGER NOT NULL,
  PRIMARY KEY (call_id, seq)
);
CREATE VIRTUAL TABLE docs USING fts5(call_id UNINDEXED, field UNINDEXED, who UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2');
INSERT INTO docs(docs, rank) VALUES('secure-delete', 1);
`;

interface CallRow {
  id: string;
  file: string;
  kind: string;
  started_at: number;
  ended_at: number;
  bots: string;
  summary: string;
  decisions: string;
  action_items: string;
  line_count: number;
}

const record = (r: CallRow): CallRecord => ({
  id: r.id,
  file: r.file,
  kind: r.kind === 'meeting' ? 'meeting' : 'call',
  startedAt: r.started_at,
  endedAt: r.ended_at,
  bots: JSON.parse(r.bots),
  summary: r.summary,
  decisions: JSON.parse(r.decisions),
  actionItems: JSON.parse(r.action_items),
  lineCount: r.line_count,
});

/** The library of saved calls in `<dir>/call-library.sqlite`. Owns the calls/ folder's index, never its files' content. */
export class CallLibrary {
  readonly file: string;
  private db: DatabaseSync;
  /** Set when a damaged index was moved aside at open; the next backfill rebuilds it. */
  readonly recovered: string | null;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, LIBRARY_FILE);
    let recovered: string | null = null;
    try {
      this.db = this.open();
    } catch {
      // A damaged or foreign file: keep it for inspection and start an empty index (the Markdown files remain).
      recovered = `${this.file}.damaged-${Date.now()}`;
      fs.renameSync(this.file, recovered);
      this.db = this.open();
    }
    this.recovered = recovered;
  }

  private open(): DatabaseSync {
    const exists = fs.existsSync(this.file);
    const db = new DatabaseSync(this.file);
    try {
      if (!exists) fs.chmodSync(this.file, 0o600);
      // A removed call's text is overwritten, not just unlinked: secure_delete for the tables, and the full-text
      // index's own secure-delete (set in SCHEMA) for its words.
      db.exec('PRAGMA secure_delete = ON; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (version !== LIBRARY_VERSION) {
        // An empty or older index: the calls are rebuilt from their Markdown files by backfill.
        db.exec('DROP TABLE IF EXISTS lines; DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS calls;');
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version = ${LIBRARY_VERSION}`);
      }
      db.prepare('SELECT count(*) FROM docs').get();
      // An index made before removed calls were overwritten: wipe what earlier removes left behind, once.
      const secure = db.prepare("SELECT v FROM docs_config WHERE k = 'secure-delete'").get() as { v: number } | undefined;
      if (secure?.v !== 1) {
        db.exec("INSERT INTO docs(docs, rank) VALUES('secure-delete', 1); INSERT INTO docs(docs) VALUES('optimize'); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
      }
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }

  private tx<T>(fn: () => T): T {
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

  /** Adds or replaces a call. Returns its id. */
  index(c: NewCallRecord): string {
    if (!isCallFile(c.file)) throw new LibraryError('not a call file name');
    if (!CALL_KINDS.includes(c.kind)) throw new LibraryError('kind must be call or meeting');
    if (!Number.isFinite(c.startedAt) || !Number.isFinite(c.endedAt)) throw new LibraryError('call times must be numbers');
    const id = callIdOf(c.file);
    const bots = texts(c.bots, 100, 50);
    const decisions = texts(c.decisions, 500, 50);
    const actions = texts(c.actionItems, 500, 200);
    const summary = String(c.summary ?? '').trim().slice(0, 4000);
    const lines = (Array.isArray(c.lines) ? c.lines : [])
      .map((l) => ({ who: oneLine(l?.who, 200), text: oneLine(l?.text, LINE_MAX), cut: l?.cut === true }))
      .filter((l) => l.who && l.text);
    return this.tx(() => {
      this.removeRows(id);
      this.db
        .prepare('INSERT INTO calls (id, file, kind, started_at, ended_at, bots, summary, decisions, action_items, line_count) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, c.file, c.kind, Math.round(c.startedAt), Math.round(Math.max(c.startedAt, c.endedAt)), JSON.stringify(bots), summary, JSON.stringify(decisions), JSON.stringify(actions), lines.length);
      const doc = this.db.prepare('INSERT INTO docs (call_id, field, who, text) VALUES (?,?,?,?)');
      const line = this.db.prepare('INSERT INTO lines (call_id, seq, who, text, cut) VALUES (?,?,?,?,?)');
      if (summary) doc.run(id, 'summary', null, summary);
      for (const d of decisions) doc.run(id, 'decision', null, d);
      for (const a of actions) doc.run(id, 'action', null, a);
      lines.forEach((l, i) => {
        line.run(id, i + 1, l.who, l.text, l.cut ? 1 : 0);
        doc.run(id, 'line', l.who, l.text);
      });
      return id;
    });
  }

  private removeRows(id: string) {
    this.db.prepare('DELETE FROM docs WHERE call_id = ?').run(id);
    this.db.prepare('DELETE FROM lines WHERE call_id = ?').run(id);
    return this.db.prepare('DELETE FROM calls WHERE id = ?').run(id).changes > 0;
  }

  remove(id: string): boolean {
    fileOfId(id);
    const removed = this.tx(() => this.removeRows(id));
    // The write-ahead log still holds the call's pages as they were: empty it now, not at the next close.
    if (removed) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return removed;
  }

  has(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM calls WHERE id = ?').get(id) !== undefined;
  }

  count(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM calls').get() as { n: number }).n;
  }

  /**
   * Indexes every call file in `callsDir` that isn't indexed yet, and drops index entries whose file is gone.
   * A file that can't be read is skipped and reported, so one bad file never blocks the rest.
   */
  backfill(callsDir: string): { added: number; removed: number; failed: string[] } {
    let names: string[];
    try {
      names = fs.readdirSync(callsDir).filter(isCallFile);
    } catch {
      names = [];
    }
    const present = new Set(names.map(callIdOf));
    let removed = 0;
    for (const { id } of this.db.prepare('SELECT id FROM calls').all() as { id: string }[]) {
      if (!present.has(id) && this.remove(id)) removed++;
    }
    let added = 0;
    const failed: string[] = [];
    for (const name of names) {
      if (this.has(callIdOf(name))) continue;
      try {
        this.index(parseCallMarkdown(name, fs.readFileSync(path.join(callsDir, name), 'utf8')));
        added++;
      } catch {
        failed.push(name);
      }
    }
    return { added, removed, failed };
  }

  get(id: string): { call: CallRecord; lines: LibraryLine[] } | null {
    fileOfId(id);
    const row = this.db.prepare('SELECT * FROM calls WHERE id = ?').get(id) as CallRow | undefined;
    if (!row) return null;
    const lines = (this.db.prepare('SELECT seq, who, text, cut FROM lines WHERE call_id = ? ORDER BY seq').all(id) as { seq: number; who: string; text: string; cut: number }[]).map(
      (l) => ({ seq: l.seq, who: l.who, text: l.text, cut: l.cut === 1 }),
    );
    return { call: record(row), lines };
  }

  /** The newest call, or null. */
  latest(): CallRecord | null {
    const row = this.db.prepare('SELECT * FROM calls ORDER BY started_at DESC, id DESC LIMIT 1').get() as CallRow | undefined;
    return row ? record(row) : null;
  }

  /** Matching passages, best first. Every query word must match; if nothing does, any word may. */
  search(query: string, limit = 8, opts: { excludeId?: string } = {}): Hit[] {
    const n = Math.max(1, Math.min(HITS_MAX, Math.trunc(limit) || 1));
    for (const any of [false, true]) {
      const q = ftsQuery(query, any);
      if (!q) return [];
      const rows = this.db
        .prepare(
          `WITH m AS (SELECT call_id, field, who, snippet(docs, 3, '«', '»', '…', 24) AS snippet, rank FROM docs WHERE docs MATCH ?)
           SELECT m.call_id AS callId, m.field AS field, m.who AS who, m.snippet AS snippet, c.started_at AS startedAt, c.kind AS kind
           FROM m JOIN calls c ON c.id = m.call_id
           WHERE m.call_id != ?
           ORDER BY m.rank, c.started_at DESC LIMIT ?`,
        )
        .all(q, opts.excludeId ?? '', n) as unknown as Hit[];
      if (rows.length) return rows.map((r) => ({ ...r, kind: r.kind === 'meeting' ? 'meeting' : 'call' }));
    }
    return [];
  }

  /**
   * Calls newest first. `before` and `beforeId` (the last call shown) page back; calls that started in the same
   * millisecond are told apart by id. With a query, only calls that match, each with its best passage, newest first.
   */
  list(opts: { query?: string; limit?: number; before?: number; beforeId?: string; kind?: CallKind } = {}): { calls: ListedCall[]; hasMore: boolean } {
    const limit = Math.max(1, Math.min(LIST_MAX, Math.trunc(opts.limit ?? 30) || 1));
    const before = opts.before ?? Number.MAX_SAFE_INTEGER;
    // No id: every call that started at `before` is after the page ('' sorts before every id).
    const beforeId = opts.beforeId ?? '';
    const kind = opts.kind ?? null;
    const query = opts.query?.trim() ? opts.query : '';
    let rows: (CallRow & { field?: string; who?: string | null; snippet?: string })[];
    if (!query) {
      rows = this.db
        .prepare('SELECT * FROM calls WHERE (started_at < ? OR (started_at = ? AND id < ?)) AND (? IS NULL OR kind = ?) ORDER BY started_at DESC, id DESC LIMIT ?')
        .all(before, before, beforeId, kind, kind, limit + 1) as unknown as CallRow[];
    } else {
      rows = [];
      for (const any of [false, true]) {
        const q = ftsQuery(query, any);
        if (!q) break;
        rows = this.db
          .prepare(
            `WITH m AS (SELECT call_id, field, who, snippet(docs, 3, '«', '»', '…', 16) AS snippet, rank FROM docs WHERE docs MATCH ?),
             hits AS (SELECT m.*, row_number() OVER (PARTITION BY call_id ORDER BY rank) AS r FROM m)
             SELECT c.*, h.field AS field, h.who AS who, h.snippet AS snippet
             FROM hits h JOIN calls c ON c.id = h.call_id
             WHERE h.r = 1 AND (c.started_at < ? OR (c.started_at = ? AND c.id < ?)) AND (? IS NULL OR c.kind = ?)
             ORDER BY c.started_at DESC, c.id DESC LIMIT ?`,
          )
          .all(q, before, before, beforeId, kind, kind, limit + 1) as unknown as typeof rows;
        if (rows.length) break;
      }
    }
    const hasMore = rows.length > limit;
    return {
      hasMore,
      calls: rows.slice(0, limit).map((r) => {
        const c = record(r);
        return { ...c, match: r.snippet === undefined ? null : { callId: c.id, startedAt: c.startedAt, kind: c.kind, field: r.field!, who: r.who ?? null, snippet: r.snippet } };
      }),
    };
  }
}
