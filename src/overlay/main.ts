// Started by the Mac app. Env: OVERLAY_TOKEN (required), OVERLAY_PORT (default 8788; 0 = any free port),
// OVERLAY_DATA_DIR (default <repo>/.data/overlay). Prints "READY <port>" once listening, and exits when
// the app closes its stdin (so a crashed app never leaves this running).
import { fileURLToPath } from 'node:url';
import { createOverlayServer } from './server.ts';

const token = process.env.OVERLAY_TOKEN ?? '';
if (token.length < 32) {
  console.error('OVERLAY_TOKEN must be set (32+ characters).');
  process.exit(1);
}
const port = Number(process.env.OVERLAY_PORT ?? '8788');
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`OVERLAY_PORT must be 0-65535, got "${process.env.OVERLAY_PORT}"`);
  process.exit(1);
}
const dataDir = process.env.OVERLAY_DATA_DIR || fileURLToPath(new URL('../../.data/overlay', import.meta.url));

const app = createOverlayServer({ dataDir, token });
app.server.on('error', (err) => {
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});
app.server.listen(port, '127.0.0.1', () => {
  const addr = app.server.address();
  console.log(`READY ${typeof addr === 'object' && addr ? addr.port : port}`);
});

const stop = () => {
  app.close();
  app.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
if (process.env.OVERLAY_WATCH_STDIN !== '0') {
  process.stdin.on('end', stop);
  process.stdin.resume();
}
