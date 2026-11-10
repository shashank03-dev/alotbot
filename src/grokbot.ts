import crypto from 'node:crypto';
import type { Auth, AuthStore } from './auth.ts';

/** Endpoints and client identity used by the Grok Bot desktop app (v0.79.3). */
export const API_URL = 'https://api2.cursor.sh';
export const SITE_URL = 'https://cursor.com';
export const CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
export const CLIENT_VERSION = '0.79.3';
const SERVICE = 'aiserver.v1.GrokBotService';
const AGENT_KIND = 'GROK_BOT_AGENT_KIND_AGENT';

export class SignedOutError extends Error {
  constructor() {
    super('Signed out. Sign in with your Grok Bot account.');
  }
}

export class NotFoundError extends Error {}

/** A voice tool request we refuse to forward (not a tool this bot's voice harness offers, or bad fields). */
export class ToolRefusedError extends Error {}

/** Voice harness tools a group call never offers: hanging up is the host's Leave button. */
export const SKIPPED_HARNESS_TOOLS = new Set(['end_the_call']);
/** Grok Bot's own app gives a voice tool call this long to answer. */
export const HARNESS_TOOL_TIMEOUT_MS = 20_000;

/** A function tool from Grok Bot's voice harness (e.g. send_task, search_conversations), run by Grok Bot. */
export interface HarnessTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  /** Identifies this voice call to Grok Bot (one per bot per call). */
  callId: string;
  name: string;
  input: Record<string, unknown>;
  /** Where the conversation is, as Grok Bot's app reports it. */
  line: { theyJustTalked: boolean; newsOwed: boolean; receiptOwed: boolean; alreadySpokeThisTurn: boolean };
}

export interface ToolOutcome {
  kind: 'served' | 'unknown_tool' | 'invalid_input';
  output: unknown;
}

const OUTCOMES: Record<string, ToolOutcome['kind']> = {
  VOICE_CALL_HARNESS_TOOL_OUTCOME_KIND_SERVED: 'served',
  VOICE_CALL_HARNESS_TOOL_OUTCOME_KIND_UNKNOWN_TOOL: 'unknown_tool',
  VOICE_CALL_HARNESS_TOOL_OUTCOME_KIND_INVALID_INPUT: 'invalid_input',
};

export interface Bot {
  id: string;
  name: string;
  /** Voice id set in the Grok Bot app, or null for the default voice. */
  voice: string | null;
  speed: number;
  /** Language hint, or null for auto. */
  language: string | null;
  color: string | null;
  shape: string | null;
}

export interface VoiceSession {
  /** Short-lived secret for the realtime voice socket (valid ~5 minutes to connect). */
  clientSecret: string;
  url: string;
  expiresAt: number;
  /** The bot's own voice-call instructions from Grok Bot. */
  instructions: string;
  /** Tools Grok Bot runs for this bot during a call (its agent, with the account's plugins, and its chat history). */
  tools: HarnessTool[];
}

/** The harness tools a group call can use: well-formed function tools, minus hang-up. */
export function harnessTools(raw: unknown): HarnessTool[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (t) =>
        t &&
        t.type === 'function' &&
        str(t.name) &&
        !SKIPPED_HARNESS_TOOLS.has(t.name) &&
        typeof t.description === 'string' &&
        t.parameters &&
        typeof t.parameters === 'object' &&
        !Array.isArray(t.parameters),
    )
    .map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The x-cursor-checksum header: obfuscated time bucket + machine id.
 * Same bytes as the Grok Bot app (its `t>>40` and `t>>32` wrap to shifts of 8 and 0 in JS).
 */
export function checksum(machineId: string, now = Date.now()): string {
  const t = Math.floor(now / 1e6);
  const b = new Uint8Array([(t >> 8) & 255, t & 255, (t >> 24) & 255, (t >> 16) & 255, (t >> 8) & 255, t & 255]);
  let key = 165;
  for (let i = 0; i < b.length; i++) {
    b[i] = (b[i] ^ key) + (i % 256);
    key = b[i];
  }
  return Buffer.from(b).toString('base64url') + machineId;
}

export function clientHeaders(auth: Auth, now = Date.now()): Record<string, string> {
  return {
    'content-type': 'application/json',
    'connect-protocol-version': '1',
    authorization: `Bearer ${auth.accessToken}`,
    'x-cursor-client-type': 'sand',
    'x-cursor-client-version': CLIENT_VERSION,
    'x-cursor-client-os': 'CLIENT_OS_MACOS',
    'x-cursor-client-source': 'sand-desktop',
    'x-cursor-checksum': checksum(auth.machineId, now),
    'x-ghost-mode': 'true',
    'x-request-id': crypto.randomUUID(),
  };
}

/** Pulls a readable reason out of a Connect error body. */
export function errorDetail(status: number, text: string): string {
  let detail = text;
  try {
    const j = JSON.parse(text);
    const debug = j?.details?.[0]?.debug;
    detail = str(debug?.details?.detail) || str(debug?.error) || str(j?.message) || text;
  } catch {
    // not JSON: keep the raw text
  }
  detail = detail.trim().slice(0, 300);
  return `HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

function toBot(a: any): Bot {
  const language = str(a.voiceLanguage);
  return {
    id: a.id,
    name: a.name,
    voice: str(a.voiceId) || null,
    speed: typeof a.voiceSpeed === 'number' && a.voiceSpeed > 0 ? a.voiceSpeed : 1,
    language: language && language !== 'auto' ? language : null,
    color: str(a.avatarColor) || null,
    shape: str(a.avatarShape) || null,
  };
}

export interface ClientOptions {
  store: AuthStore;
  apiUrl?: string;
  fetch?: typeof fetch;
  userName?: string;
  /** How long a call tool may take (default HARNESS_TOOL_TIMEOUT_MS). */
  toolTimeoutMs?: number;
}

/** Talks to Grok Bot with your own sign-in. */
export class GrokBotClient {
  private readonly apiUrl: string;
  private readonly fetch: typeof fetch;
  private readonly userName: string;
  private bots = new Map<string, Bot>();
  /** Harness tool names each bot was given, so only those are forwarded. */
  private toolNames = new Map<string, Set<string>>();
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.apiUrl = opts.apiUrl ?? API_URL;
    this.fetch = opts.fetch ?? fetch;
    this.userName = opts.userName ?? 'Shashank';
  }

  /** Your Grok Bots (agents only, not group chats). */
  async listBots(): Promise<Bot[]> {
    const j = await this.rpc('ListGrokBotAgents', {});
    const agents: any[] = Array.isArray(j?.agents) ? j.agents : [];
    const bots = agents
      .filter((a) => a?.kind === AGENT_KIND && str(a.id) && str(a.name))
      .map(toBot);
    this.bots = new Map(bots.map((b) => [b.id, b]));
    return bots;
  }

  /** Mints a voice session for one bot: its call instructions plus a realtime socket secret. */
  async voiceSession(botId: string): Promise<VoiceSession> {
    if (!this.bots.has(botId)) await this.listBots();
    const bot = this.bots.get(botId);
    if (!bot) throw new NotFoundError(`No Grok Bot with id ${botId} on this account.`);
    const [harness, secret] = await Promise.all([
      this.rpc('VoiceCallHarnessSession', { agentId: bot.id, agentName: bot.name, userName: this.userName }),
      this.rpc('MintSandVoiceCallSecret', {}),
    ]);
    let url: URL | null = null;
    try {
      url = new URL(str(secret?.websocketUrl));
    } catch {
      // checked below
    }
    if (!str(secret?.clientSecret) || !str(secret?.model) || url?.protocol !== 'wss:') {
      throw new Error('Grok Bot returned an unusable voice session.');
    }
    url.searchParams.set('model', secret.model);
    const tools = harnessTools(harness?.tools);
    this.toolNames.set(bot.id, new Set(tools.map((t) => t.name)));
    return {
      clientSecret: secret.clientSecret,
      url: url.toString(),
      expiresAt: Number(secret.expiresAtUnixSeconds) || 0,
      instructions: str(harness?.instructions),
      tools,
    };
  }

  /**
   * Runs one of a bot's harness tools on Grok Bot (send_task hands a job to the bot's agent; search_conversations
   * searches its chat history). Only tools that bot's voice session was given are forwarded.
   */
  async harnessTool(botId: string, call: ToolCall): Promise<ToolOutcome> {
    if (!this.toolNames.has(botId)) throw new ToolRefusedError('Start a voice session with this bot first.');
    if (!this.toolNames.get(botId)!.has(call.name)) throw new ToolRefusedError(`"${call.name}" is not one of this bot's call tools.`);
    const j = await this.rpc('VoiceCallHarnessTool', { agentId: botId, ...call }, this.opts.toolTimeoutMs ?? HARNESS_TOOL_TIMEOUT_MS);
    const kind = OUTCOMES[str(j?.kind)];
    if (!kind) throw new Error('Grok Bot VoiceCallHarnessTool returned an unusable answer');
    return { kind, output: j.output ?? null };
  }

  private call(method: string, body: object, auth: Auth, timeoutMs?: number): Promise<Response> {
    return this.fetch(`${this.apiUrl}/${SERVICE}/${method}`, {
      method: 'POST',
      headers: clientHeaders(auth),
      body: JSON.stringify(body),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  }

  protected async rpc(method: string, body: object, timeoutMs?: number): Promise<any> {
    try {
      return await this.rpcOnce(method, body, timeoutMs);
    } catch (err) {
      if ((err as Error)?.name === 'TimeoutError') throw new Error(`Grok Bot ${method} did not answer within ${timeoutMs! / 1000} s`);
      throw err;
    }
  }

  private async rpcOnce(method: string, body: object, timeoutMs?: number): Promise<any> {
    let auth = this.opts.store.read();
    if (!auth) throw new SignedOutError();
    let res = await this.call(method, body, auth, timeoutMs);
    if (res.status === 401) {
      auth = await this.refresh(auth);
      if (auth) res = await this.call(method, body, auth, timeoutMs);
      if (!auth || res.status === 401) {
        this.opts.store.clear();
        throw new SignedOutError();
      }
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Grok Bot ${method} failed (${errorDetail(res.status, text)})`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Grok Bot ${method} returned invalid JSON`);
    }
  }

  private async refresh(auth: Auth): Promise<Auth | null> {
    if (!auth.refreshToken) return null;
    try {
      const res = await this.fetch(`${this.apiUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: auth.refreshToken }),
      });
      const j: any = res.ok ? await res.json() : null;
      if (j?.shouldLogout === true || !str(j?.access_token)) return null;
      const next: Auth = { ...auth, accessToken: j.access_token, refreshToken: str(j.refresh_token) || auth.refreshToken };
      this.opts.store.write(next);
      return next;
    } catch {
      return null;
    }
  }
}
