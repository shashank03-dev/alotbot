// Isolated native-integration fixture: production overlay server, private scratch data, fake Grok service.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { AuthStore } from '../../../src/auth.ts';
import { ActionStore } from '../../../src/actions.ts';
import { createOverlayServer } from '../../../src/overlay/server.ts';

export async function start() {
  const dir = process.env.OVERLAY_DATA_DIR!;
  new AuthStore(dir).write({ accessToken: 'native-test-token', refreshToken: null, machineId: 'native-test-machine' });
  const store = new ActionStore(dir);
  if (!store.list().length) for (const [kind, requestId] of [['auto_review', 'approve-request'], ['local_tool', 'deny-request']] as const) {
    const action = store.create({ callId: 'native-call', botId: 'bot-test', botName: 'Native test bot', target: 'agent', tool: 'send_task', input: { request: 'Read the verification file' } });
    store.update(action.id, { status: 'waiting_approval', approval: { kind, requestId, entryId: 'test-entry', summary: 'Read the verification file', status: 'pending' } });
  }
  store.close();
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const method = req.url!.split('/').at(-1);
    let result: any = {};
    let status = 200;
    if (method === 'ListGrokBotAgents' && fs.existsSync(path.join(dir, 'hold-bots'))) { fs.writeFileSync(path.join(dir, 'bots-waiting'), 'ready'); return; }
    if (method === 'ListGrokBotAgents') result = { agents: [{ id: 'bot-test', agentId: 'uuid-bot-test', name: 'Native test bot', kind: 'GROK_BOT_AGENT_KIND_AGENT' }] };
    if (method?.startsWith('ResolveGrokBot')) {
      const valid = body.agentId === 'uuid-bot-test' && (body.requestId === 'approve-request' && body.resolution === 1 && body.approvalPlatform === 'desktop' || body.requestId === 'deny-request' && body.resolution === 2 && body.entryId === 'test-entry');
      if (!valid) { status = 400; result = { message: 'Incorrect approval contract' }; }
    }
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const app = createOverlayServer({ dataDir: dir, token: process.env.OVERLAY_TOKEN!, apiUrl: `http://127.0.0.1:${(upstream.address() as any).port}` });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  console.log(`READY ${(app.server.address() as any).port}`);
  const stop = () => { app.close(); app.server.close(); upstream.closeAllConnections(); upstream.close(() => process.exit(0)); };
  process.stdin.on('end', stop); process.stdin.resume();
  process.on('SIGTERM', stop);
}
