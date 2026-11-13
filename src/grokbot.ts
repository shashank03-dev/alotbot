import type { Approval } from './actions.ts';
import crypto from 'node:crypto';
import type { Auth, AuthStore } from './auth.ts';
import { BotRuntime, type RuntimeOptions } from './bot-runtime.ts';
import { ConnectionsManager } from './connections.ts';
import { APP_TOOLS, ConnectedApps } from './apps.ts';

/** Endpoints and client identity used by the Grok Bot desktop app (v0.79.4). */
export const API_URL = 'https://api2.cursor.sh';
export const SITE_URL = 'https://cursor.com';
export const CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
export const CLIENT_VERSION = '0.79.4';
const SERVICE = 'aiserver.v1.GrokBotService';
const AGENT_KIND = 'GROK_BOT_AGENT_KIND_AGENT';

export class SignedOutError extends Error {
  constructor() {
    super('Signed out. Sign in with your Grok Bot account.');
    this.name = 'SignedOutError';
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
  /** The account's connected apps when the session was made, so the bot can skip listing them (empty if unknown). */
  apps: { id: string; name: string; status: string; account?: string }[];
  /** How Grok opens the call: plainly, or when work has landed for the caller (null if Grok gave none). */
  greeting: { direction: string; withLandedWork: string } | null;
  /** What a job's tool call returns at once, and how the bot speaks it (null if Grok gave none). */
  receipt: { output: unknown; instructions: string } | null;
  /** The bot's skills and routines, and Shashank's computers, when the session was made (empty if unknown). */
  skills: { name: string; description: string }[];
  routines: { name: string; trigger: string; enabled: boolean; nextRunAtMs: number | null }[];
  computers: { label: string; online: boolean; lastSeenAtMs: number }[];
}

/** A computer seen this recently is online (Grok Bot's desktop app reports in every few seconds). */
export const COMPUTER_ONLINE_MS = 120_000;

/** "hi" -> "Hindi", "pt-BR" -> "Portuguese (Brazil)", as the Grok Bot app names a call's language. */
export function spokenLanguage(code: string | null): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames('en', { type: 'language', languageDisplay: 'standard' }).of(code)!;
  } catch {
    return null;
  }
}

/** How long each of a voice setup's requests to Grok Bot may take, so a dead connection fails instead of hanging. */
export const VOICE_SETUP_TIMEOUT_MS = 10_000;
/** How much longer than the rest of the voice setup joining waits for the app list. */
export const APPS_GRACE_MS = 250;
/** How old a remembered app list may be, when the fresh one is late or fails. */
export const APPS_REMEMBERED_MS = 10 * 60_000;

/** One update a bot's agent sent back to a voice call: Grok Bot's own calls speak these as work_landed. */
export interface LandedWork {
  /** Its place in the bot's chat; later updates have higher numbers. */
  seq: number;
  /** When the agent sent it (ms since 1970), or 0 if unknown. */
  at: number;
  /** What it says, in words the bot can say on the call. */
  text: string;
}
/** Chat entries read per page (Grok Bot's own page size). */
export const LANDED_SCAN = 50;

/** One entry of a bot's chat: its place and its decoded body (kind, message, role, channel, requestId, ...). */
export interface TranscriptEntry {
  seq: number;
  body: any;
}

/** Oldest first, one per seq. */
function unique(entries: TranscriptEntry[]): TranscriptEntry[] {
  const seen = new Map<number, TranscriptEntry>();
  for (const e of entries) seen.set(e.seq, e);
  return [...seen.values()].sort((a, b) => a.seq - b.seq);
}
/** Longest update passed to a bot (its voice session gets it as text). */
export const LANDED_TEXT_MAX = 1500;

/** What an agent's chat message says, for the bot on the call to tell; null if it says nothing. */
export function landedText(message: any): string | null {
  const type = str(message?.type);
  if (type === 'text') return str(message.content).trim() || null;
  if (type === 'auto-review-approval') return `It is waiting for approval in Grok Call’s Activity: ${str(message.approval?.summary).trim() || 'an action it wants to take'}.`;
  if (type === 'connector') {
    const app = str(message.connector).trim() || 'an app';
    return `It needs ${app} ${message.variant === 'connect' ? 'connected' : 'signed in again'} in Grok Call’s Connections first.`;
  }
  if (type === 'widget') {
    const options = Array.isArray(message.widget?.options) ? message.widget.options.map((o: any) => str(o?.label).trim()).filter(Boolean) : [];
    const prompt = str(message.widget?.prompt).trim() || 'It asks a question';
    return options.length ? `${prompt} Options: ${options.join(', ')}.` : prompt;
  }
  if (['user-form', 'secret-request', 'email-draft', 'slack-draft', 'imessage-draft', 'meeting-chat-draft'].includes(type)) return `It sent a ${type} request. Review it in this bot’s Activity in Grok Call; do not read or speak secret values.`;
  return type ? `It sent a ${type} card, which only shows in the Grok Bot app chat.` : null;
}

function decodeEntry(body: unknown): any {
  try {
    const value = JSON.parse(Buffer.from(str(body), 'base64').toString('utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
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
  /** Clock, for tests (default Date.now). */
  now?: () => number;
  /** How long each voice setup request may take (default VOICE_SETUP_TIMEOUT_MS). */
  setupTimeoutMs?: number;
}

/** Talks to Grok Bot with your own sign-in. */
export class GrokBotClient {
  private readonly apiUrl: string;
  private readonly fetch: typeof fetch;
  private readonly userName: string;
  private bots = new Map<string, Bot>();
  /** Per bot: its UUID (routines, skills and files need it) and its description (its calls are told it). */
  private meta = new Map<string, { uuid: string | null; description: string | null }>();
  /** Harness tool names each bot was given, so only those are forwarded. */
  private toolNames = new Map<string, Set<string>>();
  private readonly opts: ClientOptions;
  private readonly now: () => number;
  private readonly apps: ConnectedApps;
  private refreshing: Promise<Auth | null> | null = null;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.apps = new ConnectedApps((service, method, body) => this.rpc(method, body, opts.toolTimeoutMs ?? HARNESS_TOOL_TIMEOUT_MS, service), opts.now);
    this.apiUrl = opts.apiUrl ?? API_URL;
    this.fetch = opts.fetch ?? fetch;
    this.userName = opts.userName ?? 'Shashank';
  }

  /** Your Grok Bots (agents only, not group chats). */
  async listBots(): Promise<Bot[]> {
    const j = await this.rpc('ListGrokBotAgents', {});
    const agents: any[] = Array.isArray(j?.agents) ? j.agents : [];
    const usable = agents.filter((a) => a?.kind === AGENT_KIND && str(a.id) && str(a.name));
    const bots = usable.map(toBot);
    this.bots = new Map(bots.map((b) => [b.id, b]));
    this.meta = new Map(usable.map((a) => [a.id, { uuid: str(a.agentId).trim() || null, description: str(a.description).trim() || null }]));
    return bots;
  }

  /** A bot as of the last bot list. */
  bot(botId: string): Bot | undefined {
    return this.bots.get(botId);
  }

  /** A bot's UUID and description, as of the last bot list (nulls when unknown). */
  botMeta(botId: string): { uuid: string | null; description: string | null } {
    return this.meta.get(botId) ?? { uuid: null, description: null };
  }

  /** Mints a voice session for one bot: its call instructions plus a realtime socket secret. */
  async voiceSession(botId: string): Promise<VoiceSession> {
    if (!this.bots.has(botId)) await this.listBots();
    const bot = this.bots.get(botId);
    if (!bot) throw new NotFoundError(`No Grok Bot with id ${botId} on this account.`);
    const limit = this.opts.setupTimeoutMs ?? VOICE_SETUP_TIMEOUT_MS;
    const meta = this.botMeta(bot.id);
    const language = spokenLanguage(bot.language);
    // Asked the way the Grok Bot app asks: with the bot's description, its call language and that a speed setting exists.
    const ask = { agentId: bot.id, agentName: bot.name, userName: this.userName, ...(meta.description ? { description: meta.description } : {}), ...(language ? { spokenLanguage: language } : {}), hasSpeedSetting: true };
    const setup = [this.rpc('VoiceCallHarnessSession', ask, limit), this.rpc('MintSandVoiceCallSecret', {}, limit)];
    // The app list never fails a join, and adds at most APPS_GRACE_MS to it: a late or failed list falls back to
    // the last one that loaded (a hint only: every app action checks the app fresh), else the bot lists apps itself.
    const late = Promise.all(setup).then(() => new Promise<null>((resolve) => setTimeout(() => resolve(null), APPS_GRACE_MS).unref()));
    const fresh = this.apps.call(bot.id, 'list_connected_apps', {}).then((r: any) => r.apps, () => null);
    const extra = <T>(p: Promise<T>) => Promise.race([p.catch(() => null), late]);
    const [harness, secret, listed, skills, routines, computers] = await Promise.all([
      ...setup, Promise.race([fresh, late]), extra(this.skills(meta.uuid)), extra(this.routines(meta.uuid)), extra(this.computers()),
    ]);
    const apps = listed ?? this.apps.remembered(APPS_REMEMBERED_MS) ?? [];
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
    const tools = [...harnessTools(harness?.tools).filter((t) => !APP_TOOLS.some((a) => a.name === t.name)), ...APP_TOOLS];
    this.toolNames.set(bot.id, new Set(tools.map((t) => t.name)));
    return {
      clientSecret: secret.clientSecret,
      url: url.toString(),
      expiresAt: Number(secret.expiresAtUnixSeconds) || 0,
      // Grok's instructions already end with its "# Current time" block, as in the Grok Bot app.
      instructions: str(harness?.instructions),
      tools,
      apps,
      greeting: str(harness?.greeting?.direction) ? { direction: harness.greeting.direction, withLandedWork: str(harness.greeting.withLandedWork) || harness.greeting.direction } : null,
      receipt: harness?.receipt && str(harness.receipt.instructions) ? { output: harness.receipt.output ?? null, instructions: harness.receipt.instructions } : null,
      skills: (skills as VoiceSession['skills'] | null) ?? [],
      routines: (routines as VoiceSession['routines'] | null) ?? [],
      computers: (computers as VoiceSession['computers'] | null) ?? [],
    };
  }

  /** A bot's skills (by its UUID). */
  async skills(uuid: string | null): Promise<VoiceSession['skills']> {
    if (!uuid) return [];
    const j = await this.rpc('ListGrokBotAgentSkills', { agentId: uuid });
    return (Array.isArray(j?.skills) ? j.skills : []).filter((s: any) => str(s?.name).trim()).map((s: any) => ({ name: s.name.trim(), description: str(s.description).trim().slice(0, 300) }));
  }

  /** A bot's routines (by its UUID). */
  async routines(uuid: string | null): Promise<VoiceSession['routines']> {
    if (!uuid) return [];
    const j = await this.rpc('ListGrokBotAgentRoutines', { agentId: uuid });
    return (Array.isArray(j?.routines) ? j.routines : []).filter((r: any) => str(r?.name).trim()).map((r: any) => ({
      name: r.name.trim(), trigger: str(r.triggerDescription).trim() || str(r.schedule).trim(), enabled: r.isEnabled === true,
      nextRunAtMs: Number(r.nextRunAtMs) > 0 ? Number(r.nextRunAtMs) : null,
    }));
  }

  /** Shashank's computers registered with Grok Bot, and whether each is online now. */
  async computers(): Promise<VoiceSession['computers']> {
    const j = await this.rpc('ListGrokBotUserComputers', {});
    return (Array.isArray(j?.computers) ? j.computers : []).map((c: any) => {
      const seen = Number(c?.lastSeenAtMs) || 0;
      return { label: str(c?.hello?.label).trim() || 'a computer', online: seen > 0 && this.now() - seen < COMPUTER_ONLINE_MS, lastSeenAtMs: seen };
    });
  }

  async files(botId: string): Promise<{ name: string; path: string; sizeBytes: number; source: string }[]> {
    if (!this.bots.has(botId)) await this.listBots();
    const agentId = this.botMeta(botId).uuid;
    if (!agentId) throw new NotFoundError('This bot has no agent UUID for files.');
    const [agent, store] = await Promise.all([
      this.rpc('ListGrokBotAgentFiles', { agentId, pageToken: '' }, VOICE_SETUP_TIMEOUT_MS),
      this.rpc('ListGrokBotUserStoreFiles', { agentId }, VOICE_SETUP_TIMEOUT_MS),
    ]);
    return [[agent, 'agent'], [store, 'store']].flatMap(([list, source]: any) => (Array.isArray(list?.files) ? list.files : []).filter((f: any) => str(f?.name) && str(f?.path)).map((f: any) => ({ name: f.name, path: f.path, sizeBytes: Number(f.sizeBytes) || 0, source })));
  }

  // Both protobuf resolution enums use 1 for approve/allow-once and 2 for deny.
  // ProtoJSON accepts numeric values; shorthand names are not the wire enum names.
  async resolveApproval(botId: string, approval: Approval, decision: 'approve' | 'deny'): Promise<void> {
    if (!this.bots.has(botId)) await this.listBots();
    const agentId = this.botMeta(botId).uuid;
    if (!agentId) throw new NotFoundError('This bot has no agent UUID for approvals.');
    if (approval.kind === 'local_tool') {
      if (!approval.entryId) throw new Error('The Mac approval has no entry ID. Open it in Grok Bot.');
      await this.rpc('ResolveGrokBotLocalToolPermission', { agentId, entryId: approval.entryId, requestId: approval.requestId, resolution: decision === 'approve' ? 1 : 2 });
    } else if (approval.kind === 'auto_review') {
      await this.rpc('ResolveGrokBotAutoReviewApproval', { agentId, requestId: approval.requestId, resolution: decision === 'approve' ? 1 : 2, approvalPlatform: 'desktop' });
    } else throw new Error('Connect this app in Grok Bot.');
  }

  /**
   * Runs one of a bot's harness tools on Grok Bot (send_task hands a job to the bot's agent; search_conversations
   * searches its chat history). Only tools that bot's voice session was given are forwarded.
   */
  async harnessTool(botId: string, call: ToolCall): Promise<ToolOutcome> {
    if (!this.toolNames.has(botId)) throw new ToolRefusedError('Start a voice session with this bot first.');
    if (!this.toolNames.get(botId)!.has(call.name)) throw new ToolRefusedError(`"${call.name}" is not one of this bot's call tools.`);
    if (APP_TOOLS.some((t) => t.name === call.name)) return { kind: 'served', output: await this.apps.call(botId, call.name, call.input) };
    const j = await this.rpc('VoiceCallHarnessTool', { agentId: botId, ...call }, this.opts.toolTimeoutMs ?? HARNESS_TOOL_TIMEOUT_MS);
    const kind = OUTCOMES[str(j?.kind)];
    if (!kind) throw new Error('Grok Bot VoiceCallHarnessTool returned an unusable answer');
    return { kind, output: j.output ?? null };
  }

  /**
   * The bot's chat entries after `afterSeq`, oldest first, read page by page (newest first, `beforeSeq` for older)
   * until the page reaches `afterSeq`. `afterSeq` null reads only the newest page. `newest` is the newest seq seen.
   * `gap` is true if the server repeats or reverses its paging cursor.
   */
  async transcript(botId: string, afterSeq: number | null): Promise<{ entries: TranscriptEntry[]; newest: number | null; gap: boolean }> {
    const timeout = this.opts.toolTimeoutMs ?? HARNESS_TOOL_TIMEOUT_MS;
    const out: TranscriptEntry[] = [];
    let newest: number | null = null;
    let before: number | null = null;
    for (;;) {
      const j = await this.rpc('ListGrokBotTranscriptEntries', { agentId: botId, limit: LANDED_SCAN, ...(before === null ? {} : { beforeSeq: String(before) }) }, timeout);
      const rows: TranscriptEntry[] = (Array.isArray(j?.entries) ? j.entries : [])
        .map((e: any) => ({ seq: Number(e?.seq), body: decodeEntry(e?.body) }))
        .filter((e: any) => Number.isSafeInteger(e.seq) && e.body);
      for (const r of rows) if (newest === null || r.seq > newest) newest = r.seq;
      out.push(...rows.filter((r) => afterSeq === null || r.seq > afterSeq));
      const oldest = rows.length ? Math.min(...rows.map((r) => r.seq)) : null;
      // Done: nothing older wanted, this page reached the cursor, or the chat has no more.
      if (afterSeq === null || oldest === null || oldest <= afterSeq + 1 || (Array.isArray(j?.entries) ? j.entries.length : 0) < LANDED_SCAN) {
        return { entries: unique(out), newest, gap: false };
      }
      if (before !== null && oldest >= before) return { entries: unique(out), newest, gap: true };
      before = oldest;
    }
  }

  createRuntime(options: Pick<RuntimeOptions,'loadActivity'|'saveActivity'|'onChanged'> = {}) {
    return new BotRuntime({
      ...options,
      submitRoutine:async(bot,operation,spec,id)=>{
        const text=`${operation==='create'?'Create a new routine':'Update only the existing routine identified by '+id} using your routine-management tool. Apply this exact specification, preserving fields not named here. Do not run the routine, execute its prompt, contact anyone, or perform other work. If this cannot be done, report the refusal. Specification: ${JSON.stringify(spec)}`;
        const result=await this.rpc('SendGrokBotUserMessage',{agentId:bot.agentId,messageId:crypto.randomUUID(),text,sentAtMs:String(this.now()),sessionId:''},20000);
        if(result.refusal||result.dispatched!==true)throw new Error('The bot did not accept the routine change. Check its permissions and Activity.');
        return {accepted:true,queued:true};
      },
      accessToken:()=>{const auth=this.opts.store.read();if(!auth)throw new SignedOutError();return auth.accessToken;},
      rpc: (method, body, service) => this.rpc(method, body, method === 'EnsureSandBox' ? 120000 : 20000, service),
      identity: async (id) => {
        const bots = await this.listBots();
        const bot = bots.find((b) => b.id === id);
        const agentId = bot && this.botMeta(id).uuid;
        if (!bot || !agentId) throw new NotFoundError('This bot is not available in your account.');
        return { id, agentId, name: bot.name };
      }, fetch: this.fetch, now: this.now, siteOrigin: SITE_URL,
    });
  }

  createConnections() {
    return new ConnectionsManager((service, method, body, headers) => this.rpc(method, body, 20_000, service, headers));
  }

  private call(method: string, body: object, auth: Auth, timeoutMs: number, service = SERVICE, headers: Record<string, string> = {}): Promise<Response> {
    return this.fetch(`${this.apiUrl}/${service}/${method}`, {
      method: 'POST',
      headers: { ...clientHeaders(auth), ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  protected async rpc(method: string, body: object, timeoutMs: number = this.opts.setupTimeoutMs ?? VOICE_SETUP_TIMEOUT_MS, service = SERVICE, headers: Record<string, string> = {}): Promise<any> {
    try {
      return await this.rpcOnce(method, body, timeoutMs, service, headers);
    } catch (err) {
      if ((err as Error)?.name === 'TimeoutError') throw new Error(`Grok Bot ${method} did not answer within ${timeoutMs! / 1000} s`);
      // Node's fetch says only "fetch failed" when the server can't be reached: say whose server, and why.
      if (err instanceof TypeError && err.message === 'fetch failed') {
        const cause = (err as any).cause;
        throw new Error(`Could not reach Grok Bot's server (${method}: ${cause?.code || cause?.message || 'network error'})`, { cause: err });
      }
      throw err;
    }
  }

  private async rpcOnce(method: string, body: object, timeoutMs: number, service: string, headers: Record<string, string>): Promise<any> {
    let auth = this.opts.store.read();
    if (!auth) throw new SignedOutError();
    let res = await this.call(method, body, auth, timeoutMs, service, headers);
    if (res.status === 401) {
      auth = await this.refresh(auth);
      if (auth) res = await this.call(method, body, auth, timeoutMs, service, headers);
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

  private refresh(auth: Auth): Promise<Auth | null> {
    const current = this.opts.store.read();
    if (current?.accessToken !== auth.accessToken) return Promise.resolve(current);
    // Several voice/app requests can discover the same expired token together.
    this.refreshing ??= this.refreshOnce(auth).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refreshOnce(auth: Auth): Promise<Auth | null> {
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
