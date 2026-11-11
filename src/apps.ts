// Direct access to the account's Grok-connected apps. No connector credentials leave the backend.
import crypto from 'node:crypto';
import { argumentError } from './validation.ts';
import type { HarnessTool } from './grokbot.ts';

type Rpc = (service: string, method: string, body: object) => Promise<any>;
const DASHBOARD = 'aiserver.v1.DashboardService';
const GROK = 'aiserver.v1.GrokBotService';
const fn = (name: string, description: string, properties: object, required: string[]): HarnessTool => ({
  type: 'function', name, description, parameters: { type: 'object', properties, required },
});
const app = { type: 'string', description: 'The app name or exact id from list_connected_apps.' };
export const APP_TOOLS = [
  fn('list_connected_apps', 'List the apps connected in Grok, with their actual connection status. Use this instead of guessing which apps you can access.', {}, []),
  fn('find_app_tools', 'Find tools for a connected app and read their argument schemas before using them. Search with a short phrase, such as list projects or search emails; tools matching more of its words come first. With no query, or when nothing matches, names lists every tool the app has.', {
    app, query: { type: 'string', description: 'Words to match against tool names and descriptions. Leave empty to browse.' },
    offset: { type: 'integer', minimum: 0, description: 'Use nextOffset to read the next page.' },
  }, ['app']),
  fn('use_app_tool', 'Execute a tool discovered by find_app_tools. Use its exact qualified name and argument schema. The real result returns to this call. Never retry a timed-out action automatically.', {
    app, tool: { type: 'string', description: 'The exact name returned by find_app_tools.' },
    arguments: { type: 'object', additionalProperties: true, description: 'Arguments matching the discovered tool schema.' },
  }, ['app', 'tool', 'arguments']),
];

interface App {
  id: string;
  name: string;
  status: string;
  account?: string;
  permissionIds: string[];
  tools: any[];
}
const text = (v: unknown): string => typeof v === 'string' ? v.trim() : '';
function rows(value: any): any[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value.servers !== undefined && !Array.isArray(value.servers))) throw new Error('Grok returned an unusable app list.');
  return value.servers ?? [];
}
function json(value: unknown): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function schema(tool: any): Record<string, unknown> {
  const value = json(tool.inputSchema ?? tool.inputSchemaJson);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Grok returned an unusable app tool schema.');
  return value;
}

/** How long find_app_tools may reuse an app's tool list. use_app_tool always loads it fresh. */
export const TOOL_LIST_REUSE_MS = 60_000;

export class ConnectedApps {
  private readonly rpc: Rpc;
  private readonly now: () => number;
  /** App ids by lowercased id and unique name, from the last app list, so a tool list can load alongside the next one. */
  private known = new Map<string, string>();
  /** The last app list that loaded, and when. */
  private listed: { at: number; apps: unknown[] } | null = null;
  /** Each app's last tool list row (from ListSandMcpTools) and when it loaded. */
  private lists = new Map<string, { at: number; row: any }>();
  constructor(rpc: Rpc, now: () => number = Date.now) { this.rpc = rpc; this.now = now; }

  /** The last app list that loaded, if it is younger than `maxAgeMs`. */
  remembered(maxAgeMs: number): unknown[] | null {
    return this.listed && this.now() - this.listed.at < maxAgeMs ? this.listed.apps : null;
  }

  private toolList(id: string): Promise<any> {
    return this.rpc(DASHBOARD, 'ListSandMcpTools', { serverIdentifiers: [id] }).then((listed) => {
      const row = rows(listed).find((t) => (text(t.rowServerIdentifier) || t.serverIdentifier) === id);
      this.lists.set(id, { at: this.now(), row });
      return row;
    });
  }

  private recent(id: string) {
    const c = this.lists.get(id);
    // Only a connected app's list: one that needed sign-in is checked again, so signing in mid-call shows at once.
    return c && text(c.row?.status) === 'connected' && this.now() - c.at < TOOL_LIST_REUSE_MS ? c : undefined;
  }

  /**
   * The account's apps, with `wanted`'s tools loaded: 'none' loads no tools, 'reuse' may use a recent tool list,
   * 'fresh' always loads it. Each request used to wait for the one before (about 1-3 s per app action), so the
   * likely app's tool list now loads alongside the app list; the guess is checked against the fresh list.
   */
  private async inventory(wanted: unknown, tools: 'none' | 'reuse' | 'fresh'): Promise<App[]> {
    const guess = tools === 'none' ? undefined : this.known.get(text(wanted).toLowerCase());
    const early = guess && !(tools === 'reuse' && this.recent(guess)) ? this.toolList(guess) : undefined;
    early?.catch(() => {}); // a wrong guess's failure doesn't matter; the right one's is awaited below
    const available = await this.rpc(DASHBOARD, 'GetAvailableMcpServers', {});
    const apps = rows(available).flatMap((s): App[] => {
      if (!text(s?.serverIdentifier) || !text(s?.name)) return [];
      const accounts = Array.isArray(s.accounts) && s.accounts.length ? s.accounts.filter((a: any) => a && typeof a === 'object') : [{}];
      return accounts.map((account: any): App => {
        const credential = account.userHasAccessToken ?? s.userHasAccessToken;
        const supported = ['http', 'sse'].includes(text(s.type).toLowerCase());
        const status = s.enabled === false ? 'disabled' : !supported ? 'unavailable'
          : credential === false && !s.hasStaticCredentialHeaders ? 'needsAuth'
          : credential === true || s.hasStaticCredentialHeaders ? 'connected' : 'available';
        const label = text(account.displayName) || text(account.accountKey);
        return {
          id: text(account.serverIdentifier) || s.serverIdentifier,
          permissionIds: [String(s.id ?? s.serverIdentifier), s.serverIdentifier],
          name: s.name, status, ...(label ? { account: label } : {}), tools: [],
        };
      });
    });
    const names = new Map<string, number>();
    for (const a of apps) names.set(a.name.toLowerCase(), (names.get(a.name.toLowerCase()) ?? 0) + 1);
    this.known = new Map(apps.flatMap((a) => [[a.id.toLowerCase(), a.id], ...(names.get(a.name.toLowerCase()) === 1 ? [[a.name.toLowerCase(), a.id]] : [])] as [string, string][]));
    if (tools === 'none') return apps;
    const key = text(wanted).toLowerCase();
    const exact = apps.find((a) => a.id.toLowerCase() === key);
    const matches = exact ? [exact] : apps.filter((a) => a.name.toLowerCase() === key);
    if (matches.length !== 1 || !['connected', 'available'].includes(matches[0].status)) return apps;
    const a = matches[0];
    const reused = tools === 'reuse' ? this.recent(a.id) : undefined;
    const found = a.id === guess && early ? await early : reused ? reused.row : await this.toolList(a.id);
    a.status = text(found?.status) || 'unavailable';
    a.tools = Array.isArray(found?.tools) ? found.tools : [];
    return apps;
  }

  async call(botId: string, name: string, input: Record<string, unknown>): Promise<unknown> {
    // An action's permission rules load alongside discovery; they are only used after the tool is checked.
    const ruleLoad = name === 'use_app_tool'
      ? Promise.all([this.rpc(GROK, 'GetGrokBotMcpToolPermissions', {}), this.rpc(GROK, 'GetGrokBotUserMcpSettings', {})])
      : undefined;
    ruleLoad?.catch(() => {}); // not needed when the tool is refused first; otherwise awaited (and thrown) below
    const apps = await this.inventory(input.app, name === 'list_connected_apps' ? 'none' : name === 'find_app_tools' ? 'reuse' : 'fresh');
    if (name === 'list_connected_apps') {
      this.listed = { at: this.now(), apps: apps.map(({ permissionIds, tools, ...a }) => a) };
      return { apps: this.listed.apps };
    }
    const wanted = text(input.app).toLowerCase();
    const exact = apps.find((a) => a.id.toLowerCase() === wanted);
    const matches = exact ? [exact] : apps.filter((a) => a.name.toLowerCase() === wanted);
    if (matches.length !== 1) return { error: 'Choose an exact app id from list_connected_apps.', apps: apps.map((a) => ({ id: a.id, name: a.name })) };
    const a = matches[0];
    if (a.status !== 'connected') return { error: `${a.name} is ${a.status}. Check its connection in Grok.`, status: a.status };
    if (name === 'find_app_tools') {
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(offset) || (offset as number) < 0) return { error: 'offset must be a nonnegative whole number.' };
      // Spoken queries are long ("chat threads Asterix status"): rank by words matched instead of requiring all of them.
      const words = text(input.query).toLowerCase().split(/\s+/).filter(Boolean).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
      const scored = a.tools.filter((t) => {
        if (!text(t?.name)) return false;
        try { schema(t); return true; } catch { return false; }
      }).map((t) => {
        const name = String(t.name).toLowerCase();
        const all = `${name} ${text(t.description).toLowerCase()}`;
        return { t, score: words.reduce((s, w) => s + (name.includes(w) ? 2 : all.includes(w) ? 1 : 0), 0) };
      });
      const matches = (words.length ? scored.filter((m) => m.score > 0).sort((x, y) => y.score - x.score) : scored).map((m) => m.t);
      const tools = matches.slice(offset as number, (offset as number) + 10).map((t) => ({
        name: t.name, description: text(t.description), parameters: schema(t),
      }));
      return {
        app: a.id, tools, total: matches.length, nextOffset: (offset as number) + tools.length < matches.length ? (offset as number) + tools.length : null,
        // A first page alone made a bot decide an app had nothing else; list every name when browsing or nothing matched.
        ...(!words.length || !matches.length ? { names: scored.map(({ t }) => t.name) } : {}),
      };
    }
    const tool = a.tools.find((t) => t?.name === input.tool);
    if (!tool) return { error: 'This tool is not available for that app. Use find_app_tools to get its exact name.' };
    schema(tool);
    if (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) return { error: 'arguments must be a JSON object matching the tool schema.' };
    const invalid = argumentError(schema(tool), input.arguments);
    if (invalid) return { error: invalid };
    const [permissions, settings] = await ruleLoad!;
    const ids = [a.id, ...a.permissionIds];
    const rules = rows(permissions).find((p) => ids.includes(p.serverId));
    const saved = rows(settings.settings ?? {}).find((p) => ids.includes(p.serverId));
    const names = [tool.name, tool.toolName];
    if ([...(rules?.disabledTools ?? []), ...(saved?.disabledTools ?? [])].some((n) => names.includes(n))) return { error: 'This tool is disabled in Grok.' };
    const policy = rules?.policy ?? {};
    const annotation = json(tool.annotationsJson) ?? {};
    const readOnly = annotation.readOnlyHint === true && annotation.destructiveHint !== true;
    // Grok Bot's own order: the tool's rule, then the reads or writes rule. Unspecified is no rule, so it falls through.
    const rule = (v: unknown) => (v === 'GROK_BOT_TOOL_PERMISSION_UNSPECIFIED' ? undefined : v);
    const permission = rule(policy.tools?.[tool.toolName]) ?? rule(policy.tools?.[tool.name]) ?? rule(readOnly ? policy.reads : policy.writes);
    if (permission === 'GROK_BOT_TOOL_PERMISSION_BLOCKED') return { error: 'This tool is blocked in Grok.' };
    // No rule is Grok Bot's default, auto review, which its own agent runs. The call runs these without asking,
    // like Grok Bot does for Shashank (his choice, 2026-11-11). An explicit "needs approval" or unknown rule still stops it.
    if (permission !== undefined && permission !== 'GROK_BOT_TOOL_PERMISSION_ALWAYS_ALLOW') {
      return { error: 'This tool is set to needs approval in Grok, so it cannot run from a call. Change it in Grok to use it here.', needsApproval: true };
    }
    const response = await this.rpc(DASHBOARD, 'ExecuteSandMcpTool', {
      serverIdentifier: a.id, toolName: tool.name, args: input.arguments,
      toolCallId: crypto.randomUUID(), agentId: botId,
    });
    if (!response?.result || typeof response.result !== 'object' || Array.isArray(response.result) || !Object.keys(response.result).length) throw new Error('Grok returned an unusable app tool result.');
    return response.result;
  }
}
