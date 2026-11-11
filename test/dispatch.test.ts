import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { ActionStore } from '../src/actions.ts';
import { CallActions, connectorFailed, DEDUPE_MS, forVoice, LIVE_STALE_MS, stable, VOICE_RESULT_MAX } from '../src/dispatch.ts';
import type { ToolCall, ToolOutcome } from '../src/grokbot.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-dispatch-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const LINE = { theyJustTalked: true, newsOwed: false, receiptOwed: false, alreadySpokeThisTurn: false };
const call = (name: string, input: Record<string, unknown>, callId = 'call-1-a'): ToolCall => ({ callId, name, input, line: LINE });

function setup() {
  let now = 1000;
  const store = new ActionStore(path.join(tmp, String(++n)), () => now);
  const sent: ToolCall[] = [];
  let answer: (c: ToolCall) => Promise<ToolOutcome> = async () => ({ kind: 'served', output: { ok: true } });
  const noted: string[] = [];
  const started: [string, string][] = [];
  const ended: string[] = [];
  const watcher = { noteJob: (a: any) => noted.push(a.id), callStarted: (b: string, c: string) => started.push([b, c]), callEnded: (b: string) => ended.push(b) } as any;
  const actions = new CallActions({ harnessTool: (_b, c) => (sent.push(c), answer(c)) }, store, watcher, () => now);
  return { actions, store, sent, noted, started, ended, answer: (f: typeof answer) => (answer = f), at: (t: number) => (now = t), get now() { return now; } };
}

test('an app action is recorded before it runs and completed with its result', async () => {
  const t = setup();
  let during: string | undefined;
  t.answer(async () => {
    during = t.store.list()[0]?.status;
    return { kind: 'served', output: { success: { content: [{ text: 'Your profile' }] } } };
  });
  const r = await t.actions.tool('a', 'Bot A', call('use_app_tool', { app: 'Mail', tool: 'get_me', arguments: {} }));
  assert.deepEqual(r, { kind: 'served', output: { success: { content: [{ text: 'Your profile' }] } } });
  assert.equal(during, 'running', 'recorded before dispatch');
  const [a] = t.store.list();
  assert.deepEqual([a.target, a.tool, a.status, a.botName, a.callId, a.result], ['app', 'use_app_tool', 'completed', 'Bot A', 'call-1-a', JSON.stringify(r.output)]);
  assert.deepEqual(t.noted, [], 'only background jobs are watched');
});

test('connector errors fail; a transport error after dispatch is outcome unknown; refused calls fail', async () => {
  const t = setup();
  t.answer(async () => ({ kind: 'served', output: { success: { isError: true, content: [{ text: 'Resource not accessible by integration' }] } } }));
  await t.actions.tool('a', 'A', call('use_app_tool', { app: 'GitHub', tool: 'comment', arguments: { n: 1 } }));
  assert.deepEqual([t.store.list()[0].status, t.store.list()[0].error], ['failed', '[{"text":"Resource not accessible by integration"}]']);
  t.answer(async () => {
    throw new Error('Grok Bot ExecuteSandMcpTool did not answer within 20 s');
  });
  await assert.rejects(t.actions.tool('a', 'A', call('use_app_tool', { app: 'GitHub', tool: 'comment', arguments: { n: 2 } })), /did not answer/);
  assert.deepEqual([t.store.list()[0].status, t.store.list()[0].error], ['unknown', 'Grok Bot ExecuteSandMcpTool did not answer within 20 s']);
  await assert.rejects(t.actions.tool('a', 'A', call('find_app_tools', { app: 'GitHub' })), /did not answer/);
  assert.equal(t.store.list()[0].status, 'failed', 'a lookup that failed did nothing');
  t.answer(async () => ({ kind: 'invalid_input', output: { error: 'missing request' } }));
  await t.actions.tool('a', 'A', call('send_task', {}));
  assert.deepEqual([t.store.list()[0].status, t.store.list()[0].error], ['failed', 'invalid_input: {"error":"missing request"}']);
});

test('a background job is watched; one Grok Bot did not accept fails', async () => {
  const t = setup();
  t.answer(async () => ({ kind: 'served', output: { relay: 'accepted' } }));
  await t.actions.tool('a', 'A', call('send_task', { request: 'post it' }));
  const [job] = t.store.list();
  assert.deepEqual([job.target, job.status, job.result], ['agent', 'running', null]);
  assert.deepEqual(t.noted, [job.id]);
  t.answer(async () => ({ kind: 'served', output: { relay: 'unreachable', spoken: 'I could not reach my computer.' } }));
  await t.actions.tool('a', 'A', call('send_task', { request: 'again' }));
  assert.match(t.store.list()[0].error!, /^not accepted: \{"relay":"unreachable"/);
  t.answer(async () => ({ kind: 'served', output: { hits: [] } }));
  await t.actions.tool('a', 'A', call('search_conversations', { query: 'x' }));
  assert.deepEqual([t.store.list()[0].target, t.store.list()[0].status], ['agent', 'completed']);
  t.answer(async () => ({ kind: 'served', output: undefined }));
  await t.actions.tool('a', 'A', call('search_conversations', { query: 'y' }));
  assert.deepEqual([t.store.list()[0].status, t.store.list()[0].result], ['completed', 'null'], 'no output is still an answer');
});

test('the same app call by the same bot in the same call runs once: at the same time, and just after', async () => {
  const t = setup();
  let release!: (o: ToolOutcome) => void;
  t.answer(() => new Promise((r) => (release = r)));
  const input = { app: 'GitHub', tool: 'comment', arguments: { body: 'LGTM', n: 1 } };
  const same = { tool: 'comment', arguments: { n: 1, body: 'LGTM' }, app: 'GitHub' }; // other key order
  const first = t.actions.tool('a', 'A', call('use_app_tool', input));
  const second = t.actions.tool('a', 'A', call('use_app_tool', same));
  release({ kind: 'served', output: { success: { content: [{ text: 'commented' }] } } });
  assert.deepEqual(await second, await first, 'the second waited for the first');
  assert.equal(t.sent.length, 1, 'executed once');
  t.answer(async () => ({ kind: 'served', output: { ok: 'again' } }));
  const third = await t.actions.tool('a', 'A', call('use_app_tool', input));
  assert.equal((third.output as any).duplicate, true);
  assert.equal(t.sent.length, 1);
  // Not a duplicate: another bot, another call, other arguments, or later than DEDUPE_MS.
  await t.actions.tool('b', 'B', call('use_app_tool', input));
  await t.actions.tool('a', 'A', call('use_app_tool', input, 'call-2-a'));
  await t.actions.tool('a', 'A', call('use_app_tool', { ...input, arguments: { n: 2 } }));
  t.at(t.now + DEDUPE_MS + 1);
  await t.actions.tool('a', 'A', call('use_app_tool', input));
  assert.equal(t.sent.length, 5);
  // A failed one may be tried again at once.
  t.answer(async () => ({ kind: 'served', output: { error: 'nope' } }));
  const failing = { ...input, arguments: { n: 9 } };
  await t.actions.tool('a', 'A', call('use_app_tool', failing));
  await t.actions.tool('a', 'A', call('use_app_tool', failing));
  assert.equal(t.sent.length, 7);
  // Lookups are never deduplicated.
  await t.actions.tool('a', 'A', call('find_app_tools', { app: 'GitHub' }));
  await t.actions.tool('a', 'A', call('find_app_tools', { app: 'GitHub' }));
  assert.equal(t.sent.length, 9);
});

test('a large result: voice gets the first VOICE_RESULT_MAX characters and a pointer, the history keeps all of it', async () => {
  const t = setup();
  const big = { success: { content: [{ text: 'r'.repeat(VOICE_RESULT_MAX * 3) }] } };
  t.answer(async () => ({ kind: 'served', output: big }));
  const r = await t.actions.tool('a', 'A', call('use_app_tool', { app: 'GitHub', tool: 'list', arguments: {} }));
  const out = r.output as any;
  const [a] = t.store.list();
  assert.equal(out.cut, true);
  assert.equal(out.start.length, VOICE_RESULT_MAX);
  assert.match(out.note, new RegExp(`action ${a.id}`));
  assert.equal(a.result, JSON.stringify(big), 'full result kept');
  assert.deepEqual(forVoice({ a: 1 }, 'x'), { a: 1 });
  assert.equal(forVoice(undefined, 'x'), undefined);
});

test('updates for a call: marks it live once, returns its events, and ends calls that stopped asking', () => {
  const t = setup();
  t.store.addEvent({ botId: 'a', seq: 4, callId: 'call-1-a', actionId: 'x', kind: 'reply', text: 'Done.', at: 9 });
  assert.deepEqual(t.actions.updates('a', 'call-1-a', 0), [{ seq: 4, at: 9, kind: 'reply', text: 'Done.', actionId: 'x' }]);
  assert.deepEqual(t.actions.updates('a', 'call-1-a', 4), []);
  assert.deepEqual(t.started, [['a', 'call-1-a']], 'started once');
  t.actions.updates('b', 'call-1-b', 0);
  t.at(t.now + LIVE_STALE_MS + 1);
  t.actions.updates('b', 'call-1-b', 0);
  assert.deepEqual(t.ended, ['a'], 'a stopped asking');
  t.actions.updates('a', 'call-2-a', 0);
  assert.deepEqual(t.started.at(-1), ['a', 'call-2-a'], 'a new call starts again');
  t.actions.callEnded('b');
  assert.deepEqual(t.ended, ['a', 'b']);
});

test('stable JSON and connector failures', () => {
  assert.equal(stable({ b: [1, { d: 2, c: 3 }], a: null }), '{"a":null,"b":[1,{"c":3,"d":2}]}');
  assert.equal(stable(undefined), 'null');
  assert.equal(connectorFailed({ error: 'blocked' }), 'blocked');
  assert.match(connectorFailed({ success: { isError: true } })!, /tool error/);
  assert.match(connectorFailed({ permissionDenied: { reason: 'no' } })!, /^permissionDenied: /);
  assert.match(connectorFailed({ rejected: {} })!, /^rejected: /);
  assert.match(connectorFailed({ error: { code: 1 } })!, /^error: /);
  for (const fine of [{ success: { content: [] } }, null, 'text', { hits: [] }]) assert.equal(connectorFailed(fine), null);
});

test('approval resolution is bound to a pending action and only sent once concurrently', async () => {
  const t = setup();
  const a = t.store.create({ callId: 'c', botId: 'a', botName: 'A', target: 'agent', tool: 'send_task', input: {} });
  t.store.update(a.id, { status: 'waiting_approval', approval: { kind: 'auto_review', requestId: 'r', entryId: null, summary: 'Write test file', status: 'pending' } });
  let sends = 0;
  let release!: () => void;
  const resolve = async () => { sends++; await new Promise<void>((r) => release = r); };
  const first = t.actions.resolve(a.id, 'approve', resolve);
  await assert.rejects(t.actions.resolve(a.id, 'deny', resolve), /already|pending/);
  release();
  await first;
  assert.equal(sends, 1);
  assert.equal(t.store.get(a.id)!.approval!.status, 'approved');
  await assert.rejects(t.actions.resolve(a.id, 'approve', resolve), /pending/);
  await assert.rejects(t.actions.resolve('missing', 'approve', resolve), /pending/);
});

test('denials, connector setup cards, and failed approval transports preserve truthful state', async () => {
  const t = setup();
  const a = t.store.create({ callId: 'c', botId: 'a', botName: 'A', target: 'agent', tool: 'send_task', input: {} });
  const pending = { kind: 'local_tool' as const, requestId: 'r', entryId: 'e', summary: 'Test', status: 'pending' as const };
  t.store.update(a.id, { status: 'waiting_approval', approval: pending });
  await assert.rejects(t.actions.resolve(a.id, 'approve', async () => { throw new Error('network'); }), /network/);
  assert.equal(t.store.get(a.id)!.approval!.status, 'pending');
  const denied = await t.actions.resolve(a.id, 'deny', async () => {});
  assert.equal(denied.status, 'failed'); assert.equal(denied.approval!.status, 'denied');
  t.store.update(a.id, { status: 'waiting_approval', approval: null });
  await assert.rejects(t.actions.resolve(a.id, 'approve', async () => {}), /pending/);
  t.store.update(a.id, { approval: { ...pending, kind: 'connector' } });
  await assert.rejects(t.actions.resolve(a.id, 'approve', async () => {}), /pending/);
});

test('a write still running beyond the dedupe window never executes twice', async () => {
  const t = setup(); let release!: (r: ToolOutcome) => void;
  t.answer(() => new Promise((r) => release = r));
  const request = call('use_app_tool', { app: 'Test', tool: 'write', arguments: {} });
  const first = t.actions.tool('a', 'A', request);
  t.at(t.now + DEDUPE_MS + 1);
  const second = t.actions.tool('a', 'A', request);
  assert.equal(t.sent.length, 1);
  release({ kind: 'served', output: { ok: true } });
  await Promise.all([first, second]);
});
