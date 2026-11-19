// Approved private draft test. Creates one unsent test draft, verifies deduplication, then deletes only that draft.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthStore } from '../src/auth.ts';
import { GrokBotClient } from '../src/grokbot.ts';
import { ActionStore } from '../src/actions.ts';
import { CallActions, connectorFailed } from '../src/dispatch.ts';
const grok = new GrokBotClient({ store: new AuthStore(process.env.ALOTBOT_DATA_DIR ?? path.join(os.homedir(), 'Library/Application Support/Alotbot')) });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-write-verification-'));
const store = new ActionStore(dir);
const line = { theyJustTalked: true, newsOwed: false, receiptOwed: false, alreadySpokeThisTurn: false };
const report: any = { at: new Date().toISOString(), status: 'running', writesDispatched: 0, cleanup: false };
let draftId = '';
let bot: any;
const subject = `Alotbot verification ${crypto.randomUUID()}`;
function unpack(out: any): any {
  assert.equal(connectorFailed(out), null);
  const text = out?.success?.content?.map((c: any) => typeof c.text === 'string' ? c.text : c.text?.text ?? '').join('\n');
  return text ? JSON.parse(text) : out;
}
const tool = async (name: string, args: object) => unpack((await grok.harnessTool(bot.id, { callId: 'verify-draft-read', name: 'use_app_tool', input: { app: 'Gmail', tool: name, arguments: args }, line })).output);
try {
  bot = (await grok.listBots())[0]; await grok.voiceSession(bot.id);
  await grok.harnessTool(bot.id, { callId: 'verify-draft-catalog', name: 'find_app_tools', input: { app: 'Gmail', query: 'draft' }, line });
  const actions = new CallActions({ harnessTool: (id, call) => { report.writesDispatched++; return grok.harnessTool(id, call); } }, store, {} as any);
  const call = { callId: `verify-draft-${crypto.randomUUID()}`, name: 'use_app_tool', input: { app: 'Gmail', tool: 'user-Gmail-create_draft', arguments: { to: 'verification@example.invalid', subject, body: 'Unsent Alotbot deduplication test. No message is sent. This draft will be removed by the test.' } }, line };
  const started = performance.now();
  const [first, second] = await Promise.all([actions.tool(bot.id, bot.name, call), actions.tool(bot.id, bot.name, call)]);
  assert.deepEqual(first, second); assert.equal(report.writesDispatched, 1);
  const created = unpack(first.output); draftId = created.draftId ?? created.id ?? created.draft?.id ?? '';
  assert.ok(draftId, 'No draft ID returned; do not repeat the write.');
  const listed = await tool('user-Gmail-list_drafts', { query: `subject:"${subject}"`, maxResults: 25 });
  const drafts = listed.drafts ?? listed;
  assert.ok(Array.isArray(drafts), 'Unrecognized draft list shape.');
  assert.equal(drafts.length, 1); assert.equal(drafts[0].draftId ?? drafts[0].id, draftId);
  report.draftsCreated = drafts.length; report.ms = Math.round(performance.now() - started); report.status = 'passed';
} catch (err) { report.status = 'failed'; report.error = (err as Error).message; process.exitCode = 1; }
finally {
  if (draftId) {
    try { await tool('user-Gmail-delete_draft', { draftId }); report.cleanup = true; }
    catch (err) { report.cleanupError = (err as Error).message; process.exitCode = 1; }
  }
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync('docs/verification', { recursive: true }); fs.writeFileSync('docs/verification/connector-write-live.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
