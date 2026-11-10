export interface Config {
  host: string;
  port: number;
}

export type Env = Record<string, string | undefined>;

/** The server holds your Grok Bot sign-in, so it only listens on this machine. */
export const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function loadConfig(env: Env): Config {
  const host = env.HOST?.trim() || '127.0.0.1';
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`HOST must be a local address (127.0.0.1, localhost or ::1), got "${host}"`);
  }
  const raw = env.PORT?.trim() || '8787';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got "${raw}"`);
  }
  return { host, port };
}
