import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { createApp } from './server.ts';

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
  console.log(`Grok Call is running at http://${host}:${config.port}`);
});
