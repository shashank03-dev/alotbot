// Call logs: one JSON-lines file per call in <dataDir>/logs, written as things happen, so a call that
// crashes or is quit still leaves a record of everything that led up to it.

import fs from 'node:fs';
import path from 'node:path';

/** Voice-session messages left out: audio and word-by-word text (the finished transcript is logged). */
export const UNLOGGED = new Set(['input_audio_buffer.append', 'response.output_audio.delta', 'response.output_audio_transcript.delta']);

export class CallLog {
  readonly dir: string;
  readonly name: string;
  readonly file: string;
  private fd: number | null;
  private readonly started: number;
  private readonly now: () => number;

  /** Opens a new log in <dataDir>/logs (only this user can read it). */
  constructor(dataDir: string, now: () => number = Date.now) {
    this.now = now;
    this.started = now();
    this.dir = path.join(dataDir, 'logs');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const stamp = new Date(this.started).toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
    let name = `call-${stamp}.jsonl`;
    for (let n = 2; fs.existsSync(path.join(this.dir, name)); n++) name = `call-${stamp}-${n}.jsonl`;
    this.name = name;
    this.file = path.join(this.dir, name);
    this.fd = fs.openSync(this.file, 'a', 0o600);
  }

  /** One entry: when, how far into the call (ms), what kind, and its details. */
  write(kind: string, data: Record<string, unknown> = {}) {
    if (this.fd === null) return;
    const at = this.now();
    try {
      fs.writeSync(this.fd, `${JSON.stringify({ at: new Date(at).toISOString(), ms: at - this.started, kind, ...data })}\n`);
    } catch {
      this.close(); // a full disk or a removed folder must never break the call
    }
  }

  /** A message to (`out`) or from (`in`) a bot's voice session. Audio and partial text are left out. */
  voice(dir: 'in' | 'out', bot: string, raw: unknown) {
    let msg: unknown;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return this.write('voice', { dir, bot, raw: String(raw).slice(0, 500) });
    }
    if (UNLOGGED.has((msg as { type?: string } | null)?.type ?? '')) return;
    this.write('voice', { dir, bot, msg });
  }

  close() {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      // already gone
    }
    this.fd = null;
  }

  get open() {
    return this.fd !== null;
  }
}

interface SocketLike {
  send(data: string): void;
  close(...args: unknown[]): void;
  onopen: ((...a: any[]) => void) | null;
  onmessage: ((m: { data: unknown }) => void) | null;
  onclose: ((e?: any) => void) | null;
  onerror: ((e?: any) => void) | null;
}

/** Wraps a bot's voice socket so everything sent and received is logged under that bot's name. */
export function loggedSocket(ws: SocketLike, bot: string, log: CallLog) {
  log.write('voice-connect', { bot });
  return {
    send(data: string) {
      log.voice('out', bot, data);
      ws.send(data);
    },
    close(...args: unknown[]) {
      log.write('voice-close', { bot });
      ws.close(...args);
    },
    set onopen(fn: (() => void) | null) {
      ws.onopen = () => {
        log.write('voice-open', { bot });
        fn?.();
      };
    },
    set onmessage(fn: ((m: { data: unknown }) => void) | null) {
      ws.onmessage = (m) => {
        log.voice('in', bot, m.data);
        fn?.(m);
      };
    },
    set onclose(fn: ((e?: any) => void) | null) {
      ws.onclose = (e) => {
        log.write('voice-closed', { bot, code: e?.code ?? null, reason: e?.reason ? String(e.reason) : null });
        fn?.(e);
      };
    },
    set onerror(fn: ((e?: any) => void) | null) {
      ws.onerror = (e) => {
        log.write('voice-error', { bot, error: e?.message ? String(e.message) : null });
        fn?.(e);
      };
    },
  };
}

/** Mic audio over one second: how loud it was, who was hearing it, and whether a bot was playing. */
export class MicStats {
  frames = 0;
  max = 0;
  sum = 0;
  since: number;
  constructor(now: number) {
    this.since = now;
  }
  add(level: number) {
    this.frames++;
    this.sum += level;
    this.max = Math.max(this.max, level);
  }
  /** The summary if a second has passed (and resets), else null. */
  take(now: number): { frames: number; max: number; avg: number } | null {
    if (now - this.since < 1000 || !this.frames) return null;
    const out = { frames: this.frames, max: round(this.max), avg: round(this.sum / this.frames) };
    this.frames = 0;
    this.max = 0;
    this.sum = 0;
    this.since = now;
    return out;
  }
}

const round = (x: number) => Math.round(x * 10000) / 10000;
