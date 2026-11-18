import fs from 'node:fs';
import path from 'node:path';
import { callFileName } from '../memory.ts';
import type { OverlayMemory } from './call.ts';
import { parseTasks } from './tasks.ts';

export const SUMMARY_MAX = 2000;
/** Past calls listed in the app, newest first. */
export const CALLS_LISTED = 50;
const CALL_FILE = /^call-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?\.md$/;
// The "Full log" line a saved call ends with (call.ts): only a plain log file name in logs/ is accepted.
const LOG_LINK = /^Full log: `logs\/(call-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:-\d+)?\.jsonl)`$/m;

export interface PastCall {
  file: string;
  /** When the call was saved, from its file name (ms). */
  at: number;
  /** The call's summary (first 300 characters), or '' if none was saved. */
  summary: string;
}

/** Reads a saved memory file. Throws on anything malformed. */
export function parseOverlayMemory(raw: unknown): OverlayMemory {
  const m = raw as Record<string, unknown> | null;
  if (!m || typeof m !== 'object') throw new Error('memory must be an object');
  if (typeof m.summary !== 'string') throw new Error('summary must be text');
  return { summary: m.summary.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX), tasks: parseTasks(m.tasks) };
}

/** call-…Z.md is 1, call-…Z-2.md is 2: later saves in the same second. */
const copyNumber = (file: string) => Number(/-(\d+)\.md$/.exec(file)?.[1] ?? 1);

/** The summary section of a saved call's Markdown. */
export function summaryOf(markdown: string): string {
  const m = /\n## Summary\n\n([\s\S]*?)\n\n## /.exec(markdown);
  const s = m ? m[1].trim() : '';
  return s === '_No summary was saved._' ? '' : s.slice(0, 300);
}

/** Keeps <dir>/overlay-memory.json (summary and open tasks for the next call) and <dir>/calls/*.md. */
export class OverlayStore {
  readonly dir: string;
  readonly memoryFile: string;
  readonly callsDir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.memoryFile = path.join(dir, 'overlay-memory.json');
    this.callsDir = path.join(dir, 'calls');
  }

  /** The saved memory, or null if there is none or it can't be read. */
  readMemory(): OverlayMemory | null {
    try {
      return parseOverlayMemory(JSON.parse(fs.readFileSync(this.memoryFile, 'utf8')));
    } catch {
      return null;
    }
  }

  /** Writes memory atomically (tasks changed outside a call land here too). */
  writeMemory(memory: OverlayMemory) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.memoryFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(memory), { mode: 0o600 });
    fs.renameSync(tmp, this.memoryFile);
  }

  /** Saves a finished call and the memory for the next one. Returns the call's file name. */
  saveCall(memory: OverlayMemory, markdown: string, now = new Date()): string {
    fs.mkdirSync(this.callsDir, { recursive: true, mode: 0o700 });
    const base = callFileName(now);
    let name = `${base}.md`;
    for (let i = 2; fs.existsSync(path.join(this.callsDir, name)); i++) name = `${base}-${i}.md`;
    fs.writeFileSync(path.join(this.callsDir, name), markdown, { mode: 0o600, flag: 'wx' });
    this.writeMemory(memory);
    return name;
  }

  listCalls(): PastCall[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.callsDir).filter((n) => CALL_FILE.test(n));
    } catch {
      return [];
    }
    return names
      .map((file) => {
        const stamp = file.slice(5, 25).replace(/T(\d{2})-(\d{2})-(\d{2})Z/, 'T$1:$2:$3Z');
        return { file, at: Date.parse(stamp), summary: summaryOf(fs.readFileSync(path.join(this.callsDir, file), 'utf8')) };
      })
      .sort((a, b) => b.at - a.at || copyNumber(b.file) - copyNumber(a.file))
      .slice(0, CALLS_LISTED);
  }

  /**
   * Deletes a saved call's file and the full log it links to, which holds its transcript too. Only plain call file
   * names are accepted; a file already gone is fine. The log goes first, so a failure leaves the call to delete again.
   */
  deleteCall(file: string) {
    if (!CALL_FILE.test(file)) throw new Error('not a call file name');
    const target = path.join(this.callsDir, file);
    let text = '';
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch {
      // already gone
    }
    const log = LOG_LINK.exec(text)?.[1];
    if (log) fs.rmSync(path.join(this.dir, 'logs', log), { force: true });
    fs.rmSync(target, { force: true });
  }

  /** A saved call's Markdown. Only plain call file names are accepted. */
  readCall(file: string): string {
    if (!CALL_FILE.test(file)) throw new Error('not a call file name');
    return fs.readFileSync(path.join(this.callsDir, file), 'utf8');
  }
}
