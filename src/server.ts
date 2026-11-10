import { readFileSync } from 'node:fs';
import http from 'node:http';
import { AuthStore, Login } from './auth.ts';
import { API_URL, GrokBotClient, NotFoundError, SignedOutError, SITE_URL } from './grokbot.ts';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface AppOptions {
  /** Where the sign-in is kept (auth.json). */
  dataDir: string;
  apiUrl?: string;
  siteUrl?: string;
  fetch?: typeof fetch;
  pollMs?: number;
  loginTimeoutMs?: number;
}

const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/core.js': { file: 'core.js', type: 'text/javascript; charset=utf-8' },
};

// Mic worklet loads from a blob: URL; the bots' voice sockets are wss://.
const CSP =
  "default-src 'self'; script-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self' wss:; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Blocks other websites and DNS rebinding: the Host must be this machine,
 * and a POST must come from this page (or a non-browser client with no Origin).
 */
export function isAllowed(req: http.IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  let name: string;
  try {
    name = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (!LOCAL_NAMES.has(name)) return false;
  const origin = req.headers.origin;
  return req.method === 'GET' || origin === undefined || origin === `http://${host}`;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function createApp(opts: AppOptions) {
  const store = new AuthStore(opts.dataDir);
  const apiUrl = opts.apiUrl ?? API_URL;
  const login = new Login({
    store,
    apiUrl,
    siteUrl: opts.siteUrl ?? SITE_URL,
    fetch: opts.fetch,
    pollMs: opts.pollMs,
    timeoutMs: opts.loginTimeoutMs,
  });
  const grok = new GrokBotClient({ store, apiUrl, fetch: opts.fetch });
  const files = Object.fromEntries(
    Object.entries(STATIC).map(([path, f]) => [path, readFileSync(new URL(`../public/${f.file}`, import.meta.url))]),
  );

  type Handler = (res: http.ServerResponse, match: RegExpExecArray) => Promise<void> | void;
  const routes: { pattern: RegExp; method: string; handler: Handler }[] = [
    { pattern: /^\/api\/state$/, method: 'GET', handler: (res) => json(res, 200, login.state()) },
    { pattern: /^\/api\/login$/, method: 'POST', handler: (res) => json(res, 200, { loginUrl: login.start() }) },
    { pattern: /^\/api\/bots$/, method: 'GET', handler: async (res) => json(res, 200, { bots: await grok.listBots() }) },
    {
      pattern: /^\/api\/bots\/([A-Za-z0-9_-]{1,64})\/voice$/,
      method: 'POST',
      handler: async (res, m) => json(res, 200, await grok.voiceSession(m[1])),
    },
  ];

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    try {
      if (!isAllowed(req)) throw new HttpError(403, 'forbidden');
      const page = STATIC[path];
      if (page) {
        if (req.method !== 'GET') throw new HttpError(405, `${req.method} not allowed on ${path}`);
        res.writeHead(200, {
          'content-type': page.type,
          'cache-control': 'no-store',
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        return void res.end(files[path]);
      }
      const matches = routes
        .map((r) => ({ r, m: r.pattern.exec(path) }))
        .filter((x): x is { r: (typeof routes)[number]; m: RegExpExecArray } => x.m !== null);
      if (!matches.length) throw new HttpError(404, `no route ${path}`);
      const hit = matches.find((x) => x.r.method === req.method);
      if (!hit) throw new HttpError(405, `${req.method} not allowed on ${path}`);
      await hit.r.handler(res, hit.m);
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      if (err instanceof SignedOutError) return json(res, 401, { error: err.message, signedOut: true });
      if (err instanceof NotFoundError) return json(res, 404, { error: err.message });
      // Upstream (Grok Bot) or network failure.
      json(res, 502, { error: (err as Error).message });
    }
  });
  server.on('close', () => login.cancel());
  return server;
}
