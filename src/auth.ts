import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface Auth {
  accessToken: string;
  refreshToken: string | null;
  /** Random id sent in the client checksum header, like the Grok Bot app does. */
  machineId: string;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Keeps the sign-in in <dataDir>/auth.json, readable only by you. */
export class AuthStore {
  readonly dir: string;
  readonly file: string;

  constructor(dir: string) {
    this.dir = dir;
    this.file = path.join(dir, 'auth.json');
  }

  read(): Auth | null {
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
    if (!nonEmpty(raw?.accessToken) || !nonEmpty(raw.machineId)) return null;
    return {
      accessToken: raw.accessToken,
      refreshToken: nonEmpty(raw.refreshToken) ? raw.refreshToken : null,
      machineId: raw.machineId,
    };
  }

  write(auth: Auth): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(auth), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}

export type LoginState = 'signed-out' | 'signing-in' | 'signed-in';

export interface LoginOptions {
  store: AuthStore;
  apiUrl: string;
  siteUrl: string;
  fetch?: typeof fetch;
  pollMs?: number;
  timeoutMs?: number;
}

/** PKCE pair and request id, the same shape the Grok Bot desktop app uses. */
export function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, uuid: crypto.randomUUID() };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}

/**
 * Browser sign-in: open the login page, then poll until the account
 * hands back tokens. Only one attempt runs at a time.
 */
export class Login {
  private pending: AbortController | null = null;
  private error: string | null = null;
  private readonly fetch: typeof fetch;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly opts: LoginOptions;

  constructor(opts: LoginOptions) {
    this.opts = opts;
    this.fetch = opts.fetch ?? fetch;
    this.pollMs = opts.pollMs ?? 1500;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  }

  state(): { state: LoginState; error: string | null } {
    if (this.opts.store.read()) return { state: 'signed-in', error: null };
    return { state: this.pending ? 'signing-in' : 'signed-out', error: this.error };
  }

  /** Starts a sign-in and returns the page to open. */
  start(): string {
    this.cancel();
    this.error = null;
    const { verifier, challenge, uuid } = pkce();
    const url = new URL('/loginDeepControl', this.opts.siteUrl);
    url.searchParams.set('challenge', challenge);
    url.searchParams.set('uuid', uuid);
    url.searchParams.set('mode', 'login');
    url.searchParams.set('redirectTarget', 'sand');
    url.searchParams.set('supportsSelectedTeamLogin', 'true');
    const ac = new AbortController();
    this.pending = ac;
    void this.poll(uuid, verifier, ac);
    return url.toString();
  }

  cancel(): void {
    this.pending?.abort();
    this.pending = null;
  }

  private async poll(uuid: string, verifier: string, ac: AbortController): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    const pollUrl = `${this.opts.apiUrl}/auth/poll?uuid=${uuid}&verifier=${verifier}`;
    while (!ac.signal.aborted) {
      if (Date.now() > deadline) {
        this.error = 'Sign-in timed out. Try again.';
        break;
      }
      try {
        const res = await this.fetch(pollUrl, { signal: ac.signal });
        const body: any = res.ok ? await res.json().catch(() => null) : null;
        if (nonEmpty(body?.accessToken)) {
          this.opts.store.write({
            accessToken: body.accessToken,
            refreshToken: nonEmpty(body.refreshToken) ? body.refreshToken : null,
            machineId: crypto.randomBytes(32).toString('hex'),
          });
          break;
        }
      } catch {
        // network blip or abort: try again until the deadline
      }
      await sleep(this.pollMs, ac.signal);
    }
    if (this.pending === ac) this.pending = null;
  }
}
