// The user approved a live Mac-only file-read job and resolving that job's own pending approvals once.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthStore } from '../src/auth.ts';
import { GrokBotClient } from '../src/grokbot.ts';
import { ActionStore } from '../src/actions.ts';
import { CallActions } from '../src/dispatch.ts';
import { JobWatcher } from '../src/jobs.ts';
const base = path.resolve('.data/live-checks');
fs.mkdirSync(base, { recursive: true, mode: 0o700 });
const dir = fs.mkdtempSync(path.join(base, 'grok-agent-verification-'));
const nonce = crypto.randomBytes(12).toString('hex');
const file = path.join(dir, 'proof.txt');
fs.writeFileSync(file, nonce, { mode: 0o600 });
const grok = new GrokBotClient({ store: new AuthStore(process.env.GROK_CALL_DATA_DIR ?? path.join(os.homedir(), 'Library/Application Support/GrokCall')) });
const store = new ActionStore(dir);
const watcher = new JobWatcher({ grok, store, setTimer: () => 0, clearTimer: () => {}, now: Date.now });
const actions = new CallActions(grok, store, watcher);
const terminal = process.env.GROK_CALL_REQUIRE_TERMINAL === '1';
const report: any = { at: new Date().toISOString(), approvalsResolved: 0, status: 'running', executor: terminal ? 'agent-local-terminal' : 'agent-local-file' };
try {
  const bot = (await grok.listBots())[0]; await grok.voiceSession(bot.id);
  const callId = `verify-agent-${crypto.randomUUID()}`;
  const started = performance.now();
  await actions.tool(bot.id, bot.name, { callId, name: 'send_task', input: { request: `Authorized integration test: read the UTF-8 file ${file} on Shashank's Mac using your existing local computer executor. ${terminal ? 'Use the Mac terminal or shell tool to run /bin/cat on this exact path, rather than the file-read helper. Request the local approval if needed; this one command is authorized for the test.' : ''} Return only its exact contents to this voice channel. It contains a test nonce and no private data. Do not create, modify, send or publish anything. If local access needs approval, request approval for just this read.` }, line: { theyJustTalked: true, newsOwed: false, receiptOwed: false, alreadySpokeThisTurn: false } });
  const action = store.list()[0];
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000)); await watcher.check(bot.id);
    const current = store.get(action.id)!;
    if (current.approval?.status === 'pending' && current.approval.kind !== 'connector') {
      assert.ok(/read|cat|proof|terminal|command|execute|shell/i.test(current.approval.summary), 'Do not approve an unrelated action.');
      await actions.resolve(current.id, 'approve', (id, approval, decision) => grok.resolveApproval(id, approval, decision));
      report.approvalsResolved++;
    }
    if (current.result && /couldn.t read|read was refused|cannot read|outside.*allowed/i.test(current.result)) { report.lastReply = current.result.replaceAll(nonce, '<nonce>').replaceAll(file, '<test-file>'); break; }
    if (current.result?.includes(nonce)) { report.status = 'passed'; report.nonceMatched = true; report.ms = Math.round(performance.now() - started); report.events = store.events(action.id).length; break; }
  }
  assert.equal(report.status, 'passed', 'The Grok agent did not return the Mac-only nonce before the test ended.');
} catch (err) { report.status = 'failed'; report.error = (err as Error).message; process.exitCode = 1; }
finally {
  watcher.stop(); store.close();
  fs.mkdirSync('docs/verification', { recursive: true }); fs.writeFileSync(terminal ? 'docs/verification/agent-terminal-live.json' : 'docs/verification/agent-job-live.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  fs.rmSync(dir, { recursive: true, force: true });
}
