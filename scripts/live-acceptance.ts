// Explicit live checks: reads account metadata, reads a Mac-only nonce through live voice + the real Swift reader,
// and sends the approved call-ended notification. No public posts or messages to other people.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { AuthStore } from '../src/auth.ts';
import { GrokBotClient } from '../src/grokbot.ts';
import { createOverlayServer } from '../src/overlay/server.ts';
import { ActionStore } from '../src/actions.ts';
const exec = promisify(execFile);
const data = process.env.GROK_CALL_DATA_DIR ?? path.join(os.homedir(), 'Library/Application Support/GrokCall');
const auth = new AuthStore(data);
assert.ok(auth.read(), 'Sign in to Grok Call before running live tests.');
const grok = new GrokBotClient({ store: auth });
const reportFile = fileURLToPath(new URL('../docs/verification/live-results.json', import.meta.url));
const saveReport = () => { fs.mkdirSync(path.dirname(reportFile), { recursive: true }); fs.writeFileSync(reportFile, JSON.stringify(report, null, 2)); };
const report: any = { at: new Date().toISOString(), checks: [] };
const measure = async (name: string, fn: () => Promise<any>) => {
  const start = performance.now();
  try { const details = await fn(); const result = { name, status: 'passed', ms: Math.round(performance.now() - start), details }; report.checks.push(result); saveReport(); console.log(JSON.stringify(result)); return details; }
  catch (err) { const result = { name, status: 'failed', ms: Math.round(performance.now() - start), error: (err as Error).message }; report.checks.push(result); saveReport(); console.log(JSON.stringify(result)); throw err; }
};
const bots = await grok.listBots().catch(async (err) => measure('list-bots', async () => { throw err; }));
for (const bot of bots) {
  await measure(`catalog:${bot.name}`, async () => {
    const v = await grok.voiceSession(bot.id);
    const files = await grok.files(bot.id);
    assert.ok(v.clientSecret && v.tools.length);
    return { tools: v.tools.length, apps: v.apps.length, skills: v.skills.length, routines: v.routines.length, files: files.length, greeting: !!v.greeting, receipt: !!v.receipt, computersOnline: v.computers.filter((c) => c.online).length };
  });
}
await measure('transcript-pagination', async () => {
  for (const bot of bots) {
    const read = await grok.transcript(bot.id, 0);
    assert.equal(new Set(read.entries.map((e) => e.seq)).size, read.entries.length);
    if (read.entries.length > 50) return { bot: bot.name, entries: read.entries.length, unique: true, gap: read.gap };
  }
  throw new Error('No bot currently has more than one page of retained history. Pagination cannot be verified from this account state.');
});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-live-acceptance-'));
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const helper = path.join(temp, 'folder-reader');
fs.writeFileSync(path.join(temp, 'main.swift'), `import Foundation\ndo { print(try FolderReader.run(root: URL(fileURLWithPath: CommandLine.arguments[1]), operation: CommandLine.arguments[2], path: CommandLine.arguments[3]), terminator: "") } catch { FileHandle.standardError.write(Data(error.localizedDescription.utf8)); exit(1) }`);
await exec('swiftc', [path.join(root, 'mac/Sources/GrokCallCore/Actions.swift'), path.join(temp, 'main.swift'), '-o', helper]);
const nonce = crypto.randomBytes(10).toString('hex');
fs.writeFileSync(path.join(temp, 'proof.txt'), nonce, { mode: 0o600 });
new AuthStore(temp).write(auth.read()!);
const token = crypto.randomBytes(24).toString('hex');
const app = createOverlayServer({ dataDir: temp, token });
await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const port = (app.server.address() as any).port;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${token}` } });
let request = 0, audioFrames = 0, nativeRuns = 0;
const messages: any[] = [];
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
function op(op: string, args: object = {}): Promise<any> {
  const req = ++request;
  return new Promise((resolve, reject) => { pending.set(req, { resolve, reject }); ws.send(JSON.stringify({ req, op, ...args })); });
}
ws.on('message', (raw, binary) => {
  if (binary) { audioFrames++; return; }
  const m = JSON.parse(raw.toString()); messages.push(m);
  if (m.t === 'reply') { const p = pending.get(m.req); pending.delete(m.req); m.ok ? p?.resolve(m.result) : p?.reject(new Error(m.error)); }
  if (m.t === 'localTool') void (async () => {
    try {
      assert.equal(m.tool, 'mac_files'); assert.equal(m.input.operation, 'read'); assert.equal(m.input.path, 'proof.txt');
      nativeRuns++;
      const { stdout } = await exec(helper, [temp, m.input.operation, m.input.path]);
      await op('localResult', { id: m.id, text: stdout });
    } catch (err) { await op('localResult', { id: m.id, error: (err as Error).message }); }
  })();
});
async function until(fn: () => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() >= end) throw new Error('Live acceptance check timed out.'); await new Promise((r) => setTimeout(r, 100)); }
}
let recordedId = '';
try {
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await measure('voice-swift-mac-file', async () => {
    await op('join', { botIds: [bots[0].id] });
    await until(() => messages.some((m) => m.t === 'view' && m.view.bots.some((b: any) => b.status === 'ready' || b.status === 'listening')));
    await op('say', { text: 'This is an authorized read-only test. Use mac_files with operation read and relative path proof.txt inside the selected folder. This native tool is already enabled for the test. Do not use send_task or apps. Read the file now and speak its exact contents once; then wait_for_host. Do not guess the contents.' });
    await until(() => messages.some((m) => m.t === 'lines' && m.lines.some((l: any) => l.botId && l.text.toLowerCase().includes(nonce))));
    const list = await op('actions');
    const action = list.actions.find((a: any) => a.tool === 'mac_files' && a.status === 'completed');
    assert.ok(action); recordedId = action.id;
    const detail = await op('action', { id: action.id });
    assert.ok(detail.action.result.includes(nonce)); assert.equal(nativeRuns, 1); assert.ok(audioFrames > 0);
    return { nativeRuns, nonceMatched: true, audioFrames, status: detail.action.status, target: detail.action.target };
  });
  await op('leave');
  ws.close();
  await new Promise((r) => ws.once('close', r));
  // Wait for the already-authorized call-ended request to settle before closing its database.
  await until(() => { const s = new ActionStore(temp); try { return s.list().some((a) => a.tool === 'send_task' && a.result === null); } finally { s.close(); } }, 20_000);
  app.close();
  await measure('history-after-relaunch', async () => {
    const s = new ActionStore(temp);
    try { const action = s.get(recordedId)!; assert.ok(action.result?.includes(nonce)); assert.equal(action.status, 'completed'); return { nonceMatched: true, status: action.status }; }
    finally { s.close(); }
  });
} finally {
  ws.terminate(); app.close(); await new Promise<void>((r) => app.server.close(() => r()));
  fs.mkdirSync(path.join(root, 'docs/verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/verification/live-results.json'), JSON.stringify(report, null, 2));
  fs.rmSync(temp, { recursive: true, force: true });
}
