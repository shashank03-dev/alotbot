import { ConnectionAuth, type AuthOptions, type ConnectionRpc } from './connection-auth.ts';
import { pluginVariables } from './connection-manifest.ts';
import { connectionProblem } from './connection-status.ts';
import { argumentError } from './validation.ts';

const DASHBOARD = 'aiserver.v1.DashboardService', GROK = 'aiserver.v1.GrokBotService';
const PERMISSIONS: Record<string, string> = {
  auto: 'GROK_BOT_TOOL_PERMISSION_UNSPECIFIED', allow: 'GROK_BOT_TOOL_PERMISSION_ALWAYS_ALLOW',
  ask: 'GROK_BOT_TOOL_PERMISSION_NEEDS_APPROVAL', blocked: 'GROK_BOT_TOOL_PERMISSION_BLOCKED',
};
const list = (v: any, key: string): any[] => {
  if (!v || typeof v !== 'object' || (v[key] !== undefined && !Array.isArray(v[key]))) throw new Error(`Grok returned an invalid ${key} list.`);
  return v[key] ?? [];
};
const required = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new Error(`${label} is required.`);
  return value.trim();
};
const names = (value: any) => (Array.isArray(value) ? value : []).map((x: any) => String(x.name ?? '')).filter(Boolean);
const secret = (key: string, p: any) => p.writeOnly === true || p.format === 'password' || /token|secret|password|credential|api.?key|private.?key/i.test(key);
interface Entry {
  id: string; name: string; summary: string; kind: string; category: string; iconUrl: string | null;
  installed: boolean; enabled: boolean; required: boolean; needsManifest?: boolean; fields: any[]; configuredKeys: string[];
  connectors: string[]; skills: string[]; servers: any[]; nativeUrl: string | null; notice: string | null;
}
function pluginEntry(p: any, installed?: any): Entry {
  const schema = p.variables ?? {};
  const fields = Object.entries(schema.properties ?? {}).map(([key, value]) => {
    const f = value as any;
    return { key, title: f.title || key, description: f.description || '', type: f.type || 'string', secret: secret(key, f), required: (schema.required ?? []).includes(key), choices: f.enum ?? [], initial: f.default ?? null };
  });
  const blocked = p.teamAdminInstallBlockReason && !String(p.teamAdminInstallBlockReason).endsWith('_UNSPECIFIED');
  return {
    id: String(p.id), name: p.displayName || p.name, summary: p.description || '', kind: 'plugin',
    category: (p.curatedCategoryKeys ?? p.tags ?? [])[0] || 'Apps', iconUrl: p.logoUrl || null,
    installed: !!installed, enabled: installed?.isEnabled !== false,
    required: installed?.isTeamRequired === true || installed?.installMode === 'EFFECTIVE_PLUGIN_INSTALL_MODE_TEAM_REQUIRED',
    fields, needsManifest: !fields.length && !!p.gitUrl && !!p.gitRef, configuredKeys: installed?.configuredVariableKeys ?? [], connectors: names(p.mcpServers), skills: names(p.skills),
    servers: [], nativeUrl: null, notice: blocked ? 'Your team does not allow this installation.' : p.isDeprecated ? (p.deprecationMessage || 'This plugin has been deprecated.') : null,
  };
}
function safeServer(s: any) {
  return { id: s.serverIdentifier, numericId: s.id, name: s.name,
    setupUrl: s.serverIdentifier === 'cursor-github' ? 'https://cursor.com/dashboard?tab=integrations' : null,
    included: s.serverIdentifier === 'cursor-origin', enabled: s.enabled !== false,
    status: s.enabled === false ? 'disabled' : 'configured',
    accounts: list({ accounts: s.accounts }, 'accounts').map((a) => ({ key: a.accountKey, name: a.displayName || a.accountEmail || a.accountKey, connected: a.userHasAccessToken === true })) };
}

/** Only explicit native UI commands reach this manager; call bots cannot install apps or change permissions. */
export class ConnectionsManager {
  private rpc: ConnectionRpc;
  private auth: ConnectionAuth;
  private entries = new Map<string, Entry>();
  private schemas = new Map<string, Record<string, unknown>>();
  private writing = false;
  private plugins = new Map<string, any>();
  private recovered = new Map<string, Record<string, unknown>>();
  private fetchManifest: typeof fetch;
  constructor(rpc: ConnectionRpc, options: AuthOptions & { fetchManifest?: typeof fetch } = {}) { this.rpc = rpc; this.auth = new ConnectionAuth(rpc, options); this.fetchManifest = options.fetchManifest ?? fetch; }

  private async catalog(marketplaceId?: string): Promise<any[]> {
    const all: any[] = [], cursors = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await this.rpc(DASHBOARD, 'ListMarketplacePlugins', { excludeCloudAgentPlugins: true, ...(marketplaceId ? { marketplaceId } : {}), ...(pageToken ? { pageToken } : {}) });
      all.push(...list(page, 'plugins'));
      if (!page.hasMore) return all;
      if (!page.nextPageToken || cursors.has(page.nextPageToken)) throw new Error('Grok returned an invalid catalog page. Refresh to try again.');
      pageToken = page.nextPageToken;
      cursors.add(pageToken!);
    } while (true);
  }

  async refresh() {
    const [catalog, installed, available] = await Promise.all([
      this.catalog(), this.rpc(DASHBOARD, 'GetEffectiveUserPlugins', { excludeConfiguredVariables: true }), this.rpc(DASHBOARD, 'GetAvailableMcpServers', {}),
    ]);
    const warnings: string[] = [];
    try {
      const marketplaces = list(await this.rpc(DASHBOARD, 'ListMarketplaces', {}), 'marketplaces');
      for (const m of marketplaces.filter((m) => m.isPrivate || m.teamId)) {
        try { catalog.push(...await this.catalog(String(m.id))); } catch { warnings.push(`Could not load ${m.name || 'a team marketplace'}. Refresh to try again.`); }
      }
    } catch { warnings.push('Team marketplaces could not be loaded. Refresh to try again.'); }
    const owned = new Map(list(installed, 'plugins').filter((i) => i.plugin?.id).map((i) => [String(i.plugin.id), i]));
    for (const i of owned.values()) catalog.push(i.plugin);
    const entries = new Map<string, Entry>();
    this.schemas.clear();
    this.plugins.clear();
    for (const p of catalog) {
      if (!p?.id || !p.name) { warnings.push('An incomplete catalog entry could not be displayed.'); continue; }
      const id = String(p.id);
      this.plugins.set(id, p);
      const recovered = this.recovered.get(id + ':' + p.gitRef);
      const resolved = recovered ? { ...p, variables: recovered } : p;
      entries.set(id, pluginEntry(resolved, owned.get(id)));
      this.schemas.set(id, resolved.variables ?? { type: 'object', properties: {} });
    }
    for (const server of list(available, 'servers')) {
      if (!server?.serverIdentifier || !server.name) { warnings.push('An incomplete connection could not be displayed.'); continue; }
      const existing = entries.get(String(server.pluginId));
      if (existing) existing.servers.push(safeServer(server));
      else entries.set(`server:${server.serverIdentifier}`, {
        id: `server:${server.serverIdentifier}`, name: server.name, summary: 'A connection configured in your Grok account.', category: 'Apps', kind: 'connection', iconUrl: null,
        installed: true, enabled: server.enabled !== false, required: server.isRequired === true, fields: [], configuredKeys: [], connectors: [server.name], skills: [], servers: [safeServer(server)], nativeUrl: null, notice: null,
      });
    }
    let onePassword = 'Uses Grok Bot’s trusted 1Password setup';
    try {
      const count = list(await this.rpc(GROK, 'GetOnePasswordState', {}), 'connections').length;
      if (count) onePassword = `${count} account${count === 1 ? '' : 's'} configured in Grok Bot; review readiness there`;
    } catch { warnings.push('1Password status could not be refreshed. Its native setup is still available.'); }
    for (const [key, name, summary, url] of [
      ['messages', 'Messages', 'Uses Grok Bot’s Mac permissions; review its setup there', 'grokbot://app/v1/settings?id=messages'],
      ['onepassword', '1Password', onePassword, 'grokbot://app/v1/plugin/native?id=onepassword'],
      ['email', 'Mail on this Mac', 'Availability and setup are managed by Grok Bot', 'grokbot://app/v1/plugin/native?id=email'],
    ]) entries.set(`native:${key}`, { id: `native:${key}`, name, summary, category: key === 'onepassword' ? 'Password managers' : 'This Mac', kind: 'native', iconUrl: null, installed: true, enabled: true, required: false, fields: [], configuredKeys: [], connectors: [], skills: [], servers: [], nativeUrl: url, notice: 'Setup continues in Grok Bot. Refresh here after returning.' });
    this.entries = entries;
    return { entries: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
  }

  private async entry(id: unknown) {
    const key = required(id, 'Connection');
    if (!this.entries.size) await this.refresh();
    const entry = this.entries.get(key);
    if (!entry) throw new Error('Unknown connection. Refresh the list and try again.');
    return entry;
  }
  private async details(id: unknown) {
    const entry = await this.entry(id);
    if (entry.kind !== 'plugin' || entry.fields.length) return { entry };
    const plugin = this.plugins.get(entry.id)!;
    const variables = await pluginVariables(plugin, this.fetchManifest);
    if (variables) {
      this.recovered.set(entry.id + ':' + plugin.gitRef, variables);
      this.schemas.set(entry.id, variables);
      entry.fields = pluginEntry({ ...plugin, variables }).fields;
    }
    return { entry };
  }

  private async server(id: unknown) {
    const key = required(id, 'Server');
    const servers = list(await this.rpc(DASHBOARD, 'GetAvailableMcpServers', {}), 'servers');
    const s = servers.find((s) => s.serverIdentifier === key || (s.accounts ?? []).some((a: any) => a.serverIdentifier === key));
    if (!s) throw new Error('Unknown connection account. Refresh and try again.');
    return s;
  }

  private async mutate(action: string, args: any) {
    if (action === 'renameAccount' || action === 'disconnect') {
      const server = await this.server(args.id), account = required(args.account, 'Account');
      if (action === 'renameAccount') await this.rpc(DASHBOARD, 'RenameMcpOAuthAccount', { serverId: server.id, accountKey: account, newAccountKey: required(args.name, 'Account name') });
      else await this.rpc(DASHBOARD, 'DeleteMcpOAuthAccount', { serverId: server.id, accountKey: account, serverUrl: server.url ?? '' });
      return { ok: true };
    }
    if (action === 'setRule') return this.setRule(args);
    const entry = (await this.details(args.id)).entry;
    if (entry.kind !== 'plugin') throw new Error('This connection is managed through its account or native setup.');
    const owned = list(await this.rpc(DASHBOARD, 'GetEffectiveUserPlugins', { excludeConfiguredVariables: true }), 'plugins').find((i) => String(i.plugin?.id) === entry.id);
    const locked = owned?.isTeamRequired || owned?.installMode === 'EFFECTIVE_PLUGIN_INSTALL_MODE_TEAM_REQUIRED';
    if (locked && (action === 'uninstall' || (action === 'enable' && args.enabled === false))) throw new Error('This plugin is required by your team.');
    if (action === 'uninstall') {
      if (!owned) throw new Error('This plugin is no longer installed. Refresh the list.');
      await this.rpc(DASHBOARD, 'UninstallUserPlugin', { pluginId: entry.id });
    } else if (action === 'enable') {
      if (!owned || typeof args.enabled !== 'boolean') throw new Error('Choose an installed plugin and an enabled state.');
      await this.rpc(DASHBOARD, 'UpdateUserPluginInstall', { pluginId: entry.id, isEnabled: args.enabled });
    } else {
      if (entry.notice && !owned) throw new Error(entry.notice);
      if (!args.values || typeof args.values !== 'object' || Array.isArray(args.values)) throw new Error('Setup values must be an object.');
      const schema = this.schemas.get(entry.id)!;
      const invalid = argumentError(action === 'configure' ? { ...schema, required: [] } : schema, args.values);
      if (invalid) throw new Error(invalid);
      try {
        await this.rpc(DASHBOARD, action === 'install' ? 'InstallUserPlugin' : 'UpdateUserPluginInstall', { pluginId: entry.id, variables: args.values, ...(action === 'configure' ? { mergeWithStored: true } : {}) });
      } catch (err) {
        let message = (err as Error).message;
        for (const field of entry.fields.filter((f) => f.secret)) { const value = args.values[field.key]; if (typeof value === 'string' && value) message = message.replaceAll(value, '[redacted]'); }
        throw new Error(message);
      }
    }
    return { ok: true };
  }

  private async setRule(args: any) {
    const server = await this.server(args.id), tool = required(args.tool, 'Tool');
    const permission = PERMISSIONS[required(args.permission, 'Permission')];
    if (!permission) throw new Error('Choose auto, allow, ask or blocked.');
    const details = await this.tools(args.id);
    const target = details.tools.find((t: any) => t.key === tool || t.name === tool);
    if (!target) throw new Error('This tool is not available. Refresh the tool list.');
    const [permissions, saved] = await Promise.all([this.rpc(GROK, 'GetGrokBotMcpToolPermissions', {}), this.rpc(GROK, 'GetGrokBotUserMcpSettings', {})]);
    const ids = [String(server.id), server.serverIdentifier, args.id];
    const rule = list(permissions, 'servers').find((r) => ids.includes(r.serverId));
    const policy = rule?.policy ?? {};
    const serverId = rule?.serverId ?? args.id;
    await this.rpc(GROK, 'SetGrokBotMcpToolPermissions', { serverId, tools: { ...policy.tools, [target.key]: permission }, ...(policy.reads ? { reads: policy.reads } : {}), ...(policy.writes ? { writes: policy.writes } : {}) });
    const settings = saved.settings ?? {}, rows = list(settings, 'servers');
    const old = rows.find((r) => ids.includes(r.serverId));
    const disabled = (old?.disabledTools ?? []).filter((t: string) => t !== target.key && t !== target.name);
    if (args.permission === 'blocked') disabled.push(target.key);
    const updated = { ...old, serverId: old?.serverId ?? serverId, disabledTools: disabled };
    await this.rpc(GROK, 'SetGrokBotUserMcpSettings', { settings: { ...settings, servers: [...rows.filter((r) => r !== old), updated] }, keepDisabledTools: false, keepUserTimeZoneOverride: true });
    return { ok: true };
  }

  private async check(id: unknown, account: unknown) {
    const server = await this.server(id), key = required(id, 'Server');
    if (server.enabled === false) return { status: 'disabled', message: 'Enable this app to use it with your bots.' };
    try {
      if (key === 'cursor-github' || key === 'cursor-origin') {
        const result = await this.rpc(DASHBOARD, 'ListSandMcpTools', { serverIdentifiers: [key] });
        const row = list(result, 'servers').find((r) => (r.rowServerIdentifier || r.serverIdentifier) === key);
        if (row?.status === 'connected') return { status: 'connected', message: 'Ready for your bots.' };
        return { status: 'needsAuth', message: 'Review this connection in your Grok account.' };
      }
      const result = await this.rpc(DASHBOARD, 'CheckHttpMcpStatus', { serverIdentifiers: [key], accountKey: typeof account === 'string' && account.trim() ? account.trim() : 'default', statusOnly: true, userInitiated: false });
      const status = result.statuses?.find((s: any) => s.serverIdentifier === key);
      if (status?.error) return connectionProblem(status.error, status.signInRefusal);
      if (status?.requiresAuth) return { status: 'needsAuth', message: 'Sign in to let your bots use this app.' };
      if (status?.isAvailable) return { status: 'connected', message: 'Ready for your bots.' };
      return { status: 'unknown', message: 'The app has not confirmed it is ready. Check again or review its setup.' };
    } catch (err) { return connectionProblem(err); }
  }

  private async tools(id: unknown) {
    const server = await this.server(id), key = required(id, 'Server');
    const [listed, permissions, settings] = await Promise.all([
      this.rpc(DASHBOARD, 'ListSandMcpTools', { serverIdentifiers: [key] }), this.rpc(GROK, 'GetGrokBotMcpToolPermissions', {}), this.rpc(GROK, 'GetGrokBotUserMcpSettings', {}),
    ]);
    const row = list(listed, 'servers').find((r) => (r.rowServerIdentifier || r.serverIdentifier) === key);
    const ids = [String(server.id), server.serverIdentifier, key];
    const saved = list(permissions, 'servers').find((r) => ids.includes(r.serverId));
    const disabled = [...saved?.disabledTools ?? [], ...list(settings.settings ?? {}, 'servers').filter((r) => ids.includes(r.serverId)).flatMap((r) => r.disabledTools ?? [])];
    return { status: row?.status || 'unavailable', ...(row?.error ? { message: connectionProblem(row.error).message } : {}), tools: (row?.tools ?? []).map((t: any) => {
      const value = saved?.policy?.tools?.[t.toolName] ?? saved?.policy?.tools?.[t.name];
      const permission = disabled.includes(t.toolName) || disabled.includes(t.name) ? 'blocked' : Object.keys(PERMISSIONS).find((k) => PERMISSIONS[k] === value) ?? 'auto';
      return { name: t.name, key: t.toolName || t.name, description: t.description || '', permission };
    }) };
  }

  async command(action: string, args: Record<string, unknown> = {}): Promise<any> {
    if (action === 'list') return this.refresh();
    if (action === 'details') return this.details(args.id);
    if (action === 'check') return this.check(args.id, args.account);
    if (action === 'tools') return this.tools(args.id);
    if (action === 'authStatus') return this.auth.status();
    if (action === 'cancelAuth') return this.auth.cancel();
    if (action === 'native') { const e = await this.entry(args.id); if (!e.nativeUrl) throw new Error('This connection has no native setup.'); return { url: e.nativeUrl }; }
    if (action === 'authenticate') {
      const server = await this.server(args.id);
      if (server.serverIdentifier === 'cursor-origin') throw new Error('Origin is included with your Grok account and does not need a separate sign-in.');
      if (server.serverIdentifier === 'cursor-github') return { ...this.auth.status(), url: 'https://cursor.com/dashboard?tab=integrations' };
      return this.auth.start(required(args.id, 'Server'), typeof args.account === 'string' && args.account.trim() ? args.account.trim() : 'default', args.reconnect === true);
    }
    if (!['install', 'configure', 'uninstall', 'enable', 'renameAccount', 'disconnect', 'setRule'].includes(action)) throw new Error('Unknown connection action.');
    if (this.writing) throw new Error('A connection change is already running. Wait for it to finish.');
    this.writing = true;
    try { return await this.mutate(action, args); } finally { this.writing = false; }
  }
  close() { this.auth.close(); this.entries.clear(); this.schemas.clear(); this.plugins.clear(); this.recovered.clear(); }
}
