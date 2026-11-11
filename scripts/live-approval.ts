// Approval compatibility check: temporarily tighten this Mac from 'always' to 'ask', then restore it in finally.
// Only a read of this test's own nonce file is authorized. Never weaken a pre-existing block.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuthStore } from '../src/auth.ts';
import { GrokBotClient } from '../src/grokbot.ts';
import { ActionStore } from '../src/actions.ts';
import { CallActions } from '../src/dispatch.ts';
import { JobWatcher } from '../src/jobs.ts';
class Client extends GrokBotClient {
  machines() { return this.rpc('ListSandMachines', {}, 20_000, 'aiserver.v1.DashboardService'); }
  permission(machineId: string, localToolPermission: string) { return this.rpc('UpdateSandMachineLocalToolPermission', { machineId, localToolPermission }, 20_000, 'aiserver.v1.DashboardService'); }
}
const base = path.resolve('.data/live-checks'); fs.mkdirSync(base, { recursive: true, mode: 0o700 });
const dir = fs.mkdtempSync(path.join(base, 'approval-'));
const nonce = crypto.randomBytes(12).toString('hex'); const file = path.join(dir, 'proof.txt'); fs.writeFileSync(file, nonce, { mode: 0o600 });
const grok = new Client({ store: new AuthStore(process.env.GROK_CALL_DATA_DIR ?? path.join(os.homedir(), 'Library/Application Support/GrokCall')), setupTimeoutMs: 20_000 });
const store = new ActionStore(dir);
const watcher = new JobWatcher({ grok, store, setTimer: () => 0, clearTimer: () => {}, now: Date.now });
const actions = new CallActions(grok, store, watcher);
let machine: any; let original: string | undefined;
const report: any = { at: new Date().toISOString(), status: 'running', approvalsResolved: 0, restored: false };
try {
  const bots = await grok.listBots(); const bot = bots[0]; await grok.voiceSession(bot.id);
  const desktop = (await grok.machines()).machines.filter((m: any) => m.connected && (!m.kind || m.kind === 'desktop'));
  assert.equal(desktop.length, 1, 'The test requires one unambiguous connected desktop.');
  machine = desktop[0]; original = machine.localToolPermission;
  assert.ok(original === 'always' || original === 'ask', 'Do not change a blocked or unknown permission.');
  fs.writeFileSync(path.join(base, 'approval-policy-recovery.json'), JSON.stringify({ machineId: machine.machineId, original }), { mode: 0o600 });
  await grok.permission(machine.machineId, 'ask');
  assert.equal((await grok.machines()).machines.find((m: any) => m.machineId === machine.machineId).localToolPermission, 'ask');
  report.temporaryPermission = 'ask'; console.log('Test device now requires approval; original policy recorded for restoration.');
  await new Promise((r) => setTimeout(r, 3000));
  const started = performance.now();
  await actions.tool(bot.id, bot.name, { callId: `verify-approval-${crypto.randomUUID()}`, name: 'send_task', input: { request: `Authorized approval integration test. On Shashank's Mac, run /bin/cat on ${file} using the local terminal execution tool. The device is temporarily set to ask so this read should produce a local approval card. Request approval for this exact command, wait for the approval, then return only the exact file contents to this voice channel. This file contains only a test nonce. Do not modify any files, change any settings, or use the cloud machine.` }, line: { theyJustTalked: true, newsOwed: false, receiptOwed: false, alreadySpokeThisTurn: false } });
  const action = store.list()[0];
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 3000)); await watcher.check(bot.id);
    const current = store.get(action.id)!;
    if (current.approval?.status === 'pending' && current.approval.kind !== 'connector') {
      assert.ok(/read|cat|proof|terminal|command|execute|shell/i.test(current.approval.summary));
      await actions.resolve(current.id, 'approve', (id, approval, decision) => grok.resolveApproval(id, approval, decision));
      report.approvalsResolved++; report.approvalKind = current.approval.kind;
      console.log('The test job approval was resolved once.');
    }
    if (current.result?.includes(nonce)) { report.nonceMatched = true; break; }
    if (current.result && /refused|couldn.t read|cannot read/i.test(current.result)) { report.lastReply = current.result.replaceAll(nonce, '<nonce>').replaceAll(file, '<test-file>'); break; }
  }
  report.ms = Math.round(performance.now() - started);
  assert.ok(report.approvalsResolved > 0, 'No genuine approval card reached the test job.'); assert.equal(report.nonceMatched, true);
  report.status = 'passed';
} catch (err) { report.status = 'failed'; report.error = (err as Error).message; process.exitCode = 1; }
finally {
  watcher.stop();
  if (machine && original) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await grok.permission(machine.machineId, original); const current = (await grok.machines()).machines.find((m: any) => m.machineId === machine.machineId); assert.equal(current.localToolPermission, original); report.restored = true; break; }
      catch (err) { report.restoreError = (err as Error).message; }
    }
    if (report.restored) { delete report.restoreError; fs.rmSync(path.join(base, 'approval-policy-recovery.json')); }
    else { report.status = 'failed'; process.exitCode = 1; }
  }
  fs.mkdirSync('docs/verification', { recursive: true }); fs.writeFileSync('docs/verification/approval-live.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
}
