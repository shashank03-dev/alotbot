import fs from 'node:fs';
import path from 'node:path';

/** What the next call starts with: the last call's summary, open action items and notes. */
export interface Memory {
  summary: string;
  actionItems: string[];
  notes: { text: string; by: string }[];
}

/** Same limits as the call page (public/core.js). */
export const LIMITS = { summary: 2000, item: 500, items: 200, by: 100, markdown: 2_000_000 };

export class BadInput extends Error {}

const text = (v: unknown, max: number, what: string): string => {
  if (typeof v !== 'string') throw new BadInput(`${what} must be text`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (t.length > max) throw new BadInput(`${what} is longer than ${max} characters`);
  return t;
};

const list = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new BadInput(`${what} must be a list`);
  if (v.length > LIMITS.items) throw new BadInput(`${what} has more than ${LIMITS.items} entries`);
  return v;
};

/** Checks memory from the page (or a hand-edited file). Throws BadInput with the reason. */
export function parseMemory(raw: unknown): Memory {
  if (!raw || typeof raw !== 'object') throw new BadInput('memory must be an object');
  const m = raw as Record<string, unknown>;
  return {
    summary: text(m.summary, LIMITS.summary, 'summary'),
    actionItems: list(m.actionItems, 'actionItems')
      .map((a) => text(a, LIMITS.item, 'action item'))
      .filter(Boolean),
    notes: list(m.notes, 'notes')
      .map((n) => {
        if (!n || typeof n !== 'object') throw new BadInput('each note must be an object');
        const { text: t, by } = n as Record<string, unknown>;
        return { text: text(t, LIMITS.item, 'note'), by: text(by, LIMITS.by, 'note author') };
      })
      .filter((n) => n.text),
  };
}

/** `2026-11-10T14:05:09.123Z` -> `call-2026-11-10T14-05-09Z`, safe as a file name everywhere. */
export function callFileName(now: Date): string {
  return `call-${now.toISOString().slice(0, 19).replace(/:/g, '-')}Z`;
}

/** Keeps <dataDir>/memory.json (for the next call) and <dataDir>/calls/*.md (one export per call). */
export class CallStore {
  readonly dir: string;
  readonly memoryFile: string;
  readonly callsDir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.memoryFile = path.join(dir, 'memory.json');
    this.callsDir = path.join(dir, 'calls');
  }

  /** The last call's memory, or null if there is none or the file is unreadable. */
  readMemory(): Memory | null {
    try {
      return parseMemory(JSON.parse(fs.readFileSync(this.memoryFile, 'utf8')));
    } catch {
      return null;
    }
  }

  /** Saves a finished call. Returns the export's path relative to dataDir. */
  save(memory: Memory, markdown: string, now = new Date()): string {
    fs.mkdirSync(this.callsDir, { recursive: true, mode: 0o700 });
    const base = callFileName(now);
    let name = `${base}.md`;
    for (let i = 2; fs.existsSync(path.join(this.callsDir, name)); i++) name = `${base}-${i}.md`;
    fs.writeFileSync(path.join(this.callsDir, name), markdown, { mode: 0o600, flag: 'wx' });
    const tmp = `${this.memoryFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(memory), { mode: 0o600 });
    fs.renameSync(tmp, this.memoryFile);
    return path.join('calls', name);
  }
}
