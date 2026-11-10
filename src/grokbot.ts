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
}

/** Talks to Grok Bot with your own sign-in. */
export class GrokBotClient {
  private readonly apiUrl: string;
  private readonly fetch: typeof fetch;
  private readonly userName: string;
  private bots = new Map<string, Bot>();
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
    return {
      clientSecret: secret.clientSecret,
      url: url.toString(),
      expiresAt: Number(secret.expiresAtUnixSeconds) || 0,
      instructions: str(harness?.instructions),
    };
  }

  private call(method: string, body: object, auth: Auth): Promise<Response> {
    return this.fetch(`${this.apiUrl}/${SERVICE}/${method}`, {
      method: 'POST',
      headers: clientHeaders(auth),
      body: JSON.stringify(body),
    });
  }

  protected async rpc(method: string, body: object): Promise<any> {
    let auth = this.opts.store.read();
    if (!auth) throw new SignedOutError();
    let res = await this.call(method, body, auth);
    if (res.status === 401) {
      auth = await this.refresh(auth);
      if (auth) res = await this.call(method, body, auth);
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
