import { readFileSync } from 'node:fs';
import http from 'node:http';
import { AuthStore, Login } from './auth.ts';
import { API_URL, GrokBotClient, NotFoundError, SignedOutError, SITE_URL, ToolRefusedError, type ToolCall } from './grokbot.ts';
import { BadInput, CallStore, LIMITS, parseMemory } from './memory.ts';
import { ActionStore } from './actions.ts';
import { CallActions } from './dispatch.ts';
import { JobWatcher } from './jobs.ts';

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

/** Reads a JSON request body, refusing other content types and bodies over `limit` bytes. */
export async function readJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
  if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'send JSON (content-type: application/json)');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `body is larger than ${limit} bytes`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

/** Largest tool call body the page may send (send_task requests are capped at 2,000 characters by Grok Bot). */
export const TOOL_BODY_LIMIT = 64_000;
const LINE_KEYS = ['theyJustTalked', 'newsOwed', 'receiptOwed', 'alreadySpokeThisTurn'] as const;

/** Checks a voice tool call from the page. Throws a 400 with the reason. */
export function parseToolCall(raw: unknown): ToolCall {
  const b = raw as Record<string, any> | null;
  const bad = (why: string) => new HttpError(400, why);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body must be an object');
  const { callId, name, input, line } = b;
  if (typeof callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(callId)) throw bad('callId must be 1-128 letters, digits or _.:-');
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw bad('name must be a tool name');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('input must be an object');
  if (!line || typeof line !== 'object' || !LINE_KEYS.every((k) => typeof line[k] === 'boolean')) {
    throw bad(`line must have true/false ${LINE_KEYS.join(', ')}`);
  }
  return { callId, name, input, line: Object.fromEntries(LINE_KEYS.map((k) => [k, line[k]])) as ToolCall['line'] };
}

/** Checks a request for a bot's agent updates on this call. Throws a 400 with the reason. */
export function parseLanded(raw: unknown): { callId: string; after: number } {
  const b = raw as Record<string, any> | null;
  const bad = (why: string) => new HttpError(400, why);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('body must be an object');
  if (typeof b.callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(b.callId)) throw bad('callId must be 1-128 letters, digits or _.:-');
  if (!Number.isSafeInteger(b.after) || b.after < 0) throw bad('after must be a nonnegative whole number');
  return { callId: b.callId, after: b.after };
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
  const calls = new CallStore(opts.dataDir);
  const actionStore = new ActionStore(opts.dataDir);
  actionStore.recoverInterrupted();
  const watcher = new JobWatcher({ grok, store: actionStore, setTimer: (fn, ms) => setTimeout(fn, ms).unref(), clearTimer: (t) => clearTimeout(t), now: Date.now });
  watcher.resume();
  const actions = new CallActions(grok, actionStore, watcher);
  const files = Object.fromEntries(
    Object.entries(STATIC).map(([path, f]) => [path, readFileSync(new URL(`../public/${f.file}`, import.meta.url))]),
  );

  type Handler = (res: http.ServerResponse, match: RegExpExecArray, req: http.IncomingMessage) => Promise<void> | void;
  const routes: { pattern: RegExp; method: string; handler: Handler }[] = [
    { pattern: /^\/api\/actions$/, method: 'GET', handler: (res) => json(res, 200, { actions: actionStore.list().map(({ result, input, ...a }) => a) }) },
    { pattern: /^\/api\/state$/, method: 'GET', handler: (res) => json(res, 200, login.state()) },
    { pattern: /^\/api\/login$/, method: 'POST', handler: (res) => json(res, 200, { loginUrl: login.start() }) },
    { pattern: /^\/api\/bots$/, method: 'GET', handler: async (res) => json(res, 200, { bots: await grok.listBots() }) },
    {
      pattern: /^\/api\/bots\/([A-Za-z0-9_-]{1,64})\/voice$/,
      method: 'POST',
      handler: async (res, m) => json(res, 200, await grok.voiceSession(m[1])),
    },
    {
      // A bot used one of its Grok Bot call tools (send_task, search_conversations): Grok Bot runs it.
      pattern: /^\/api\/bots\/([A-Za-z0-9_-]{1,64})\/tool$/,
      method: 'POST',
      handler: async (res, m, req) => {
        const call = parseToolCall(await readJson(req, TOOL_BODY_LIMIT));
        try {
          json(res, 200, await actions.tool(m[1], grok.bot(m[1])?.name ?? m[1], call));
        } catch (err) {
          if (err instanceof ToolRefusedError) throw new HttpError(400, err.message);
          throw err;
        }
      },
    },
    {
      // What a bot's agent sent back to this call about its jobs since `after`.
      pattern: /^\/api\/bots\/([A-Za-z0-9_-]{1,64})\/landed$/,
      method: 'POST',
      handler: async (res, m, req) => {
        const { callId, after } = parseLanded(await readJson(req, 1_000));
        if (!grok.bot(m[1])) throw new HttpError(400, 'Start a voice session with this bot first.');
        json(res, 200, { work: actions.updates(m[1], callId, after) });
      },
    },
    { pattern: /^\/api\/memory$/, method: 'GET', handler: (res) => json(res, 200, { memory: calls.readMemory() }) },
    {
      // A finished call: memory for the next call, plus its Markdown export.
      pattern: /^\/api\/calls$/,
      method: 'POST',
      handler: async (res, _m, req) => {
        const body = (await readJson(req, LIMITS.markdown * 4 + 1_000_000)) as Record<string, unknown> | null;
        const markdown = body?.markdown;
        if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > LIMITS.markdown) {
          throw new HttpError(400, 'markdown must be non-empty text');
        }
        let memory;
        try {
          memory = parseMemory(body!.memory);
        } catch (err) {
          throw new HttpError(400, (err as BadInput).message);
        }
        json(res, 200, { file: calls.save(memory, markdown) });
      },
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
      await hit.r.handler(res, hit.m, req);
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      if (err instanceof SignedOutError) return json(res, 401, { error: err.message, signedOut: true });
      if (err instanceof NotFoundError) return json(res, 404, { error: err.message });
      // Upstream (Grok Bot) or network failure.
      json(res, 502, { error: (err as Error).message });
    }
  });
  server.on('close', () => login.cancel());
  // Jobs keep being watched while the server runs; closing it stops that and closes the history.
  server.on('close', () => {
    watcher.stop();
    actionStore.close();
  });
  return server;
}
