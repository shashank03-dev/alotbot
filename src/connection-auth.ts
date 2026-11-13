import { connectionProblem } from './connection-status.ts';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type ConnectionRpc = (service: string, method: string, body: object, headers?: Record<string, string>) => Promise<any>;
export interface AuthFlow { id: string; server: string; status: string; authorizationUrl: string | null; message: string; }
export interface AuthOptions { ports?: number[]; now?: () => number; authMs?: number; }
const DASHBOARD = 'aiserver.v1.DashboardService';

/** Browser consent stays with the provider. Only its state-bound callback reaches this loopback listener. */
export class ConnectionAuth {
  private rpc: ConnectionRpc;
  private options: AuthOptions;
  private servers: http.Server[] = [];
  private callback = '';
  private current: (AuthFlow & { state: string; account: string; until: number }) | null = null;
  private starting = false;
  private revision = 0;
  constructor(rpc: ConnectionRpc, options: AuthOptions) { this.rpc = rpc; this.options = options; }

  private now() { return (this.options.now ?? Date.now)(); }
  private publicFlow(): { flow: AuthFlow | null } {
    if (this.current?.status === 'waiting' && this.now() >= this.current.until) this.finish('expired', 'Sign-in expired. Start again.');
    if (!this.current) return { flow: null };
    const { state, account, until, ...flow } = this.current;
    return { flow };
  }
  status() { return this.publicFlow(); }
  private finish(status: string, message: string) {
    if (this.current) Object.assign(this.current, { status, message, state: '', authorizationUrl: null });
  }
  cancel() {
    if (this.current?.status === 'completing') throw new Error('Sign-in is finishing. Wait for its result; disconnect afterward if needed.');
    if (this.current?.status === 'waiting') this.finish('cancelled', 'Sign-in cancelled. Existing connections were kept.');
    return this.publicFlow();
  }

  async start(server: string, account: string, reconnect: boolean) {
    this.publicFlow();
    if (this.starting || this.current?.status === 'waiting' || this.current?.status === 'completing') throw new Error('Finish or cancel the current sign-in first.');
    this.starting = true;
    const revision = this.revision;
    try {
      await this.listen(revision);
      const result = await this.rpc(DASHBOARD, 'CheckHttpMcpStatus', {
        serverIdentifiers: [server], accountKey: account, oauthRedirectUri: this.callback,
        statusOnly: false, userInitiated: true, forceReauth: reconnect,
      }, { 'x-cursor-mcp-oauth-relayed-loopback': '1' });
      if (revision !== this.revision) throw new Error('Sign-in was closed.');
      const status = result.statuses?.find((s: any) => s.serverIdentifier === server);
      if (!status) throw new Error('Grok did not return a sign-in status for this connection.');
      this.current = { id: crypto.randomUUID(), server, account, state: '', until: this.now() + (this.options.authMs ?? 15 * 60_000), status: 'waiting', authorizationUrl: null, message: 'Finish signing in in your browser.' };
      if (status.error) throw new Error(connectionProblem(status.error, status.signInRefusal).message);
      if (!status.requiresAuth && (status.isAvailable || status.hasValidToken || status.signedIn)) this.finish('connected', 'Already signed in.');
      else {
        if (!status.authUrl) throw new Error('This connection needs setup in Grok Bot.');
        this.authorize(status.authUrl);
      }
    } catch (err) {
      if (revision === this.revision) this.finish('failed', connectionProblem(err).message);
      throw new Error(connectionProblem(err).message);
    } finally {
      if (revision === this.revision) this.starting = false;
    }
    return this.publicFlow();
  }

  private authorize(raw: string) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Grok returned an unsafe sign-in URL.');
    const state = url.searchParams.get('state');
    if (!state || url.username || url.password) throw new Error('Grok returned a sign-in URL without valid state.');
    Object.assign(this.current!, { state, status: 'waiting', authorizationUrl: url.href, message: 'Finish signing in in your browser.' });
  }

  private async listen(revision: number) {
    if (this.servers.length) return;
    for (const candidate of this.options.ports ?? [18787, 28787, 31787]) {
      const bound: http.Server[] = [];
      try {
        const v4 = http.createServer((req, res) => { void this.receive(req, res); });
        bound.push(v4);
        await new Promise<void>((resolve, reject) => { v4.once('error', reject); v4.listen(candidate, '127.0.0.1', resolve); });
        const port = (v4.address() as AddressInfo).port;
        const v6 = http.createServer((req, res) => { void this.receive(req, res); });
        bound.push(v6);
        await new Promise<void>((resolve, reject) => { v6.once('error', reject); v6.listen({ port, host: '::1', ipv6Only: true }, resolve); });
        if (revision !== this.revision) {
          for (const s of bound) { s.close(); s.closeAllConnections(); }
          throw new Error('Sign-in was closed.');
        }
        this.servers = bound;
        this.callback = `http://localhost:${port}/callback`;
        return;
      } catch {
        for (const s of bound) { s.close(); s.closeAllConnections(); }
        if (revision !== this.revision) throw new Error('Sign-in was closed.');
      }
    }
    throw new Error('The local sign-in callback ports are busy. Close the other sign-in window and try again.');
  }

  private async receive(req: http.IncomingMessage, res: http.ServerResponse) {
    const reply = (code: number, text: string) => {
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'" });
      res.end(text);
    };
    if (req.method !== 'GET' || !req.url || req.url.length > 16384) return reply(400, 'Invalid sign-in callback.');
    const url = new URL(req.url, this.callback);
    this.publicFlow();
    const flow = this.current;
    if (url.pathname !== '/callback' || flow?.status !== 'waiting' || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== flow.state) return reply(400, 'This sign-in is unknown, expired or already completed.');
    const code = url.searchParams.get('code'), error = url.searchParams.get('error');
    if ((!code && !error) || url.searchParams.getAll('code').length > 1 || url.searchParams.getAll('error').length > 1 || (code && error)) return reply(400, 'Invalid sign-in response.');
    flow.status = 'completing';
    try {
      const result = await this.rpc(DASHBOARD, 'CompleteMcpOAuth', {
        stateId: flow.state, authorizationCode: code ?? '', ...(error ? { oauthError: error } : {}),
      });
      if (this.current !== flow) return reply(400, 'This sign-in was closed.');
      flow.state = '';
      if (error) { this.finish('cancelled', 'The provider declined sign-in. Existing connections were kept.'); return reply(200, 'Sign-in was cancelled. Return to Grok Call.'); }
      if (result.continueAuthorizationUrl) {
        this.authorize(result.continueAuthorizationUrl);
        return reply(200, 'Another sign-in step is needed. Return to Grok Call to continue.');
      }
      const checked = await this.rpc(DASHBOARD, 'CheckHttpMcpStatus', { serverIdentifiers: [flow.server], accountKey: result.accountKey || flow.account, oauthRedirectUri: this.callback, statusOnly: true, userInitiated: false });
      if (this.current !== flow) return reply(400, 'This sign-in was closed.');
      const status = checked.statuses?.find((s: any) => s.serverIdentifier === flow.server);
      if (!status || status.requiresAuth || !(status.isAvailable || status.hasValidToken || status.signedIn)) throw new Error('Sign-in returned, but Grok has not verified this connection. Refresh its status or reconnect.');
      this.finish('connected', 'Connected. Your bots can discover the app now.');
      reply(200, 'Connected. Return to Grok Call.');
    } catch (err) {
      if (this.current === flow) this.finish('failed', connectionProblem(err).message);
      reply(400, 'Sign-in could not be completed. Return to Grok Call for its status.');
    }
  }

  close() {
    this.revision++;
    this.starting = false;
    this.current = null;
    for (const server of this.servers) { server.close(); server.closeAllConnections(); }
    this.servers = [];
    this.callback = '';
  }
}
