import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';

// The bots call you by name: your login name unless GROK_CALL_USER is set. Set before the call engine loads.
const login = os.userInfo().username;
process.env.GROK_CALL_USER ||= login.charAt(0).toUpperCase() + login.slice(1);
const { createApp } = await import('./server.ts');

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`Config error: ${(err as Error).message}`);
  process.exit(1);
}

const server = createApp({ dataDir: fileURLToPath(new URL('../.data', import.meta.url)) });
server.on('error', (err) => {
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  console.log(`Grok Call is running. Open: http://${host}:${config.port}/#t=${server.token}`);
});
