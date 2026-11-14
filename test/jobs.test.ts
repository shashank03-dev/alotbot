import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { ActionStore } from '../src/actions.ts';
import { approvalOf, approvalText, askTarget, FIRST_READ_SKEW_MS, JOB_FAST_MS, JOB_MAX_AGE_MS, JOB_POLL_MS, JOB_QUIET_MS, JOB_SLOW_POLL_MS, JobWatcher, SUMMARY_MAX } from '../src/jobs.ts';
import type { TranscriptEntry } from '../src/grokbot.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-jobs-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const flush = () => new Promise((r) => setImmediate(r));

/** Shapes taken from real Grok Bot chats (2026-11-11). */
const CALL = 'call-9-a';
const jobMsg = (seq: number, request: string, requestId: string, at: number): TranscriptEntry => ({ seq, body: { kind: 'message', id: `t${seq}u`, role: 'user', content: request, channel: `voice:${CALL}`, channelSender: 'the call', requestId, timestampMs: at } });
const reply = (seq: number, content: string, extra: object = {}, at = 0): TranscriptEntry => ({ seq, body: { kind: 'send-message', id: `t${seq}s`, message: { type: 'text', content, channel: `voice:${CALL}` }, timestampMs: at, ...extra } });

function setup(start = 1_000_000) {
  let now = start;
  const store = new ActionStore(path.join(tmp, String(++n)), () => now);
  let chat: TranscriptEntry[] = [];
  const reads: (number | null)[] = [];
  let fail: Error | null = null;
  let gap = false;
  const timers: { fn: () => void; ms: number; done: boolean }[] = [];
  const changes: string[] = [];
  const logs: [string, object][] = [];
  const w = new JobWatcher({
    grok: {
      transcript: async (_botId, after) => {
        reads.push(after);
        if (fail) throw fail;
        const entries = chat.filter((e) => after === null || e.seq > after);
        return { entries, newest: chat.length ? Math.max(...chat.map((e) => e.seq)) : null, gap };
      },
    },
    store,
    setTimer: (fn, ms) => {
      const t = { fn, ms, done: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => (t.done = true),
    now: () => now,
    onChange: (b) => changes.push(b),
    log: (k, d) => logs.push([k, d]),
  });
  const due = () => timers.filter((t) => !t.done);
  const tick = async () => {
    const [t] = due();
    assert.ok(t, 'a check is scheduled');
    t.done = true;
    t.fn();
    await flush();
    await flush();
    return t.ms;
  };
  const job = (request = 'Post the comment') => store.create({ callId: CALL, botId: 'a', botName: 'Bot A', target: 'agent', tool: 'send_task', input: { request } });
  return { w, store, reads, timers, due, tick, changes, logs, job, set: (c: TranscriptEntry[]) => (chat = c), fail: (e: Error | null) => (fail = e), gap: (g: boolean) => (gap = g), at: (t: number) => (now = t), get now() { return now; } };
}

test('a job\'s reply is matched through its request id, recorded once, and completes the action', async () => {
  // Call of 2026-11-11 13:33: the agent asked "should I go ahead?" 10 s after the job; nothing ever read it.
  const t = setup();
  const old = reply(1, 'Yesterday\'s chat, before the call', {}, t.now - 60_000);
  t.set([old]);
  const a = t.job();
  t.w.noteJob(a);
  assert.equal(await t.tick(), JOB_POLL_MS);
  assert.deepEqual(t.reads, [0], 'first read: recover the job even when it precedes the latest page');
  assert.equal(t.store.cursor('a'), 1);
  assert.deepEqual(t.store.events(a.id), [], 'history from before the job is not replayed');
  t.set([old, jobMsg(2, 'Post the comment', 'req-1', t.now), reply(3, 'On it.', { requestId: 'req-1' }, t.now)]);
  await t.tick();
  assert.deepEqual(t.reads.at(-1), 1, 'then everything after the cursor');
  let got = t.store.get(a.id)!;
  assert.deepEqual([got.requestId, got.status, got.summary, got.result], ['req-1', 'completed', 'On it.', 'On it.']);
  assert.deepEqual(t.changes, ['a']);
  t.set([old, jobMsg(2, 'Post the comment', 'req-1', t.now), reply(3, 'On it.', { requestId: 'req-1' }), reply(4, 'Posted: https://x/1', { requestId: 'req-1' })]);
  t.store.setCursor('a', 1); // a replay of entries already seen changes nothing
  await t.tick();
  got = t.store.get(a.id)!;
  assert.deepEqual([got.summary, got.result], ['Posted: https://x/1', 'On it.\n\nPosted: https://x/1']);
  assert.deepEqual(t.store.events(a.id).map((e) => [e.seq, e.kind, e.text]), [[3, 'reply', 'On it.'], [4, 'reply', 'Posted: https://x/1']]);
  assert.equal(t.store.cursor('a'), 4);
});

test('jobs on the same channel each get their own replies; a reply with no request id goes to the newest job', async () => {
  const t = setup();
  t.set([]);
  const first = t.job('Check disk space');
  const second = t.job('Post the comment');
  t.w.noteJob(first);
  t.set([jobMsg(1, 'Post the comment', 'req-2', t.now), jobMsg(2, 'Check disk space', 'req-1', t.now), reply(3, '212 GB free', { requestId: 'req-1' }, t.now), reply(4, 'Should I go ahead?', { requestId: 'req-2' }, t.now)]);
  await t.tick();
  assert.deepEqual([t.store.get(first.id)!.requestId, t.store.get(second.id)!.requestId], ['req-1', 'req-2'], 'matched by text, not order');
  assert.equal(t.store.get(first.id)!.summary, '212 GB free');
  assert.equal(t.store.get(second.id)!.summary, 'Should I go ahead?');
  const third = t.job('Something else');
  t.set([...[1, 2, 3, 4].map((s) => reply(s, 'old')), reply(5, 'No request id here', {}, t.now)]);
  await t.tick();
  assert.equal(t.store.get(third.id)!.summary, 'No request id here');
  // A job message with no matching text takes the oldest job still waiting for its id (here the third).
  const fourth = t.job('Exact words');
  t.set([jobMsg(6, 'Different words', 'req-4', t.now)]);
  await t.tick();
  assert.deepEqual([t.store.get(third.id)!.requestId, t.store.get(fourth.id)!.requestId], ['req-4', null]);
  // A request id already taken is not given to a second job.
  const fifth = t.job('Again');
  t.set([jobMsg(7, 'Again', 'req-4', t.now)]);
  await t.tick();
  assert.equal(t.store.get(fifth.id)!.requestId, null);
});

test('approval cards and Mac tool asks put the job on hold, with what is waiting', async () => {
  const t = setup();
  t.set([]);
  const a = t.job();
  t.w.noteJob(a);
  await t.tick();
  const ask = { seq: 5, body: { kind: 'send-message', id: 't5s', requestId: 'req-1', message: { type: 'local-tool-permission', ask: { requestId: 'ask-1', status: 'pending', action: 'run-command', target: 'gh pr comment 1249' } }, timestampMs: t.now } };
  t.set([jobMsg(4, 'Post the comment', 'req-1', t.now), ask]);
  await t.tick();
  let got = t.store.get(a.id)!;
  assert.equal(got.status, 'waiting_approval');
  assert.deepEqual(got.approval, { kind: 'local_tool', requestId: 'ask-1', entryId: 't5s', summary: 'gh pr comment 1249', status: 'pending' });
  assert.deepEqual(t.store.events(a.id).map((e) => [e.kind, e.text]), [['approval', "It is waiting for Shashank's OK to run this on their Mac: gh pr comment 1249. They can allow it in Grok Call or the Grok Bot app."]]);
  t.set([reply(6, 'Posted.', { requestId: 'req-1' }, t.now)]);
  await t.tick();
  got = t.store.get(a.id)!;
  assert.deepEqual([got.status, got.summary], ['completed', 'Posted.'], 'answered after the OK');
});

test('approvalOf reads every kind of ask, and approvalText says what to do', () => {
  const e = (message: object, extra: object = {}): TranscriptEntry => ({ seq: 1, body: { kind: 'send-message', id: 'e1', requestId: 'r1', message, ...extra } });
  assert.deepEqual(approvalOf(e({ type: 'auto-review-approval', approval: { requestId: 'ar', summary: ' Post it ', status: 'pending' } })), { kind: 'auto_review', requestId: 'ar', entryId: 'e1', summary: 'Post it', status: 'pending' });
  assert.equal(approvalOf(e({ type: 'auto-review-approval', approval: { requestId: 'ar' } }))!.summary, 'an action it wants to take');
  for (const [s, want] of [['allowed', 'approved'], ['always', 'approved'], ['approved', 'approved'], ['denied', 'denied'], ['never', 'denied'], ['expired', 'expired'], ['', 'pending']]) {
    assert.equal(approvalOf(e({ type: 'local-tool-permission', ask: { requestId: 'q', status: s } }))!.status, want, s);
  }
  assert.deepEqual(approvalOf(e({ type: 'connector', connector: 'X', variant: 'connect' })), { kind: 'connector', requestId: 'r1', entryId: 'e1', summary: 'X connected', status: 'pending' });
  assert.equal(approvalOf(e({ type: 'connector', variant: 'reauth' }, { requestId: undefined }))!.requestId, 'e1');
  assert.equal(approvalOf(e({ type: 'connector' }, { id: undefined, requestId: undefined }))!.entryId, null);
  assert.equal(approvalOf(e({ type: 'local-tool-permission', ask: {} })), null, 'no request id: not an ask we can answer');
  assert.equal(approvalOf(e({ type: 'local-tool-permission', ask: { requestId: 'q' } }, { id: undefined }))!.entryId, null);
  assert.equal(approvalOf(e({ type: 'auto-review-approval', approval: { requestId: 'q' } }, { id: undefined }))!.entryId, null);
  assert.equal(approvalOf(e({ type: 'auto-review-approval' })), null);
  assert.equal(approvalOf(e({ type: 'text', content: 'hi' })), null);
  assert.equal(approvalOf({ seq: 1, body: { kind: 'message' } }), null);
  assert.equal(approvalOf({ seq: 1, body: { kind: 'send-message' } }), null);
  assert.equal(askTarget({ action: 'use-app', recipientName: 'Slack' }), 'Slack');
  assert.equal(askTarget({ action: 'use-app', target: 'x' }), 'x');
  assert.equal(askTarget({ description: ' Read a file ' }), 'Read a file');
  assert.equal(askTarget(undefined), 'an action on this Mac');
  assert.match(approvalText({ kind: 'auto_review', requestId: 'r', entryId: null, summary: 'Post it', status: 'pending' }), /approval: Post it\. They can approve it in Grok Call/);
  assert.equal(approvalText({ kind: 'connector', requestId: 'r', entryId: null, summary: 'X connected', status: 'pending' }), 'It needs X connected in Grok Call’s Connections first.');
});

test('what Shashank types in a bot\'s chat during its call is passed on; other chat is not', async () => {
  const t = setup();
  t.set([]);
  t.w.callStarted('a', CALL);
  assert.equal(await t.tick(), 0, 'checked right away');
  const before = t.now - 1;
  t.set([
    { seq: 1, body: { kind: 'message', role: 'user', content: 'Typed before the call', timestampMs: before } },
    { seq: 2, body: { kind: 'message', role: 'user', content: '  use the second link  ', timestampMs: t.now } },
    { seq: 3, body: { kind: 'user-attachment', file_name: 'plan.pdf', timestampMs: t.now } },
    { seq: 4, body: { kind: 'user-attachment', timestampMs: t.now } },
    { seq: 5, body: { kind: 'message', role: 'user', content: 'from another bot', fromAgent: { id: 'x' }, timestampMs: t.now } },
    { seq: 6, body: { kind: 'message', role: 'user', content: '   ', timestampMs: t.now } },
    { seq: 7, body: { kind: 'send-message', message: { type: 'text', content: 'plain chat reply, no call' }, timestampMs: t.now } },
    { seq: 8, body: { kind: 'event', timestampMs: t.now } },
    { seq: 9, body: { kind: 'send-message', message: { type: 'text', content: '   ', channel: `voice:${CALL}` }, timestampMs: t.now } },
  ]);
  t.store.setCursor('a', 0);
  await t.tick();
  assert.deepEqual(t.store.eventsForCall('a', CALL, 0).map((e) => [e.seq, e.kind, e.text]), [[2, 'written', 'use the second link'], [3, 'written', '(attached a file: plan.pdf)'], [4, 'written', '(attached a file: a file)']]);
  t.w.callEnded('a');
  t.set([{ seq: 10, body: { kind: 'message', role: 'user', content: 'after the call', timestampMs: t.now } }]);
  await t.tick().catch(() => undefined);
  assert.equal(t.store.eventsForCall('a', CALL, 4).length, 0);
});

test('a reply on this call\'s channel with no job still reaches the call', async () => {
  const t = setup();
  t.set([]);
  t.w.callStarted('a', CALL);
  await t.tick();
  t.set([reply(1, 'Started on it.', {}, t.now)]);
  await t.tick();
  assert.deepEqual(t.store.eventsForCall('a', CALL, 0).map((e) => [e.kind, e.text, e.actionId]), [['reply', 'Started on it.', null]]);
});

test('checks are frequent after a job and during a call, slower later, and stop when nothing is left', async () => {
  const t = setup();
  t.set([]);
  const a = t.job();
  t.w.noteJob(a);
  assert.equal(await t.tick(), JOB_POLL_MS);
  t.at(t.now + JOB_FAST_MS);
  assert.equal(await t.tick(), JOB_POLL_MS, 'the check before scheduled the fast one');
  assert.equal(t.due()[0].ms, JOB_SLOW_POLL_MS, 'the job is older now');
  t.w.callStarted('a', CALL);
  assert.equal(t.due().length, 1);
  assert.equal(t.due()[0].ms, 0, 'a call moves the next check forward');
  await t.tick();
  assert.equal(t.due()[0].ms, JOB_POLL_MS, 'fast during the call');
  t.w.callEnded('a');
  t.at(t.now + JOB_MAX_AGE_MS + 1);
  await t.tick();
  assert.equal(t.due().length, 1, 'unfinished cloud work is still watched after a day');
  t.store.update(a.id, { status: 'completed' });
  t.at(t.now + JOB_QUIET_MS + 1);
  await t.tick();
  assert.equal(t.due().length, 0, 'nothing left to watch');
  t.w.noteJob(t.job());
  t.w.noteJob(t.job());
  assert.equal(t.due().length, 1, 'one check per bot');
  t.w.stop();
  assert.equal(t.due().length, 0);
  t.w.noteJob(t.job());
  assert.equal(t.due().length, 0, 'stopped for good');
  await t.w.check('a');
});

test('a check that fails is logged and tried again; a gap is logged; one check per bot at a time', async () => {
  const t = setup();
  t.set([]);
  t.w.noteJob(t.job());
  t.fail(new Error('Grok Bot ListGrokBotTranscriptEntries failed (HTTP 503)'));
  await t.tick();
  assert.deepEqual(t.logs.at(-1), ['jobs-error', { botId: 'a', error: 'Grok Bot ListGrokBotTranscriptEntries failed (HTTP 503)' }]);
  assert.equal(t.due().length, 1, 'tried again');
  t.fail(null);
  t.gap(true);
  await t.tick();
  assert.deepEqual(t.logs.at(-1), ['jobs-gap', { botId: 'a', cursor: null }]);
  const [x, y] = [t.w.check('a'), t.w.check('a')];
  await Promise.all([x, y]);
  assert.equal(t.reads.length, 3, 'the second check while one runs does nothing');
});

test('on relaunch, open jobs are watched again from where the history left off', async () => {
  const t = setup();
  const a = t.job();
  const done = t.job('finished long ago');
  t.at(t.now + 1);
  t.store.update(done.id, { status: 'completed' });
  t.at(t.now + JOB_QUIET_MS + 10);
  t.store.setCursor('a', 7);
  t.set([jobMsg(8, 'Post the comment', 'req-1', t.now), reply(9, 'Posted.', { requestId: 'req-1' }, t.now)]);
  t.w.resume();
  assert.equal(await t.tick(), 0);
  assert.deepEqual(t.reads, [7]);
  assert.equal(t.store.get(a.id)!.status, 'completed');
  const quiet = setup();
  quiet.w.resume();
  assert.equal(quiet.due().length, 0);
});

test('first read with no cursor counts only entries from just before the bot was first watched; long replies are cut', async () => {
  const t = setup();
  const a = t.job('Long one');
  t.w.noteJob(a);
  t.set([jobMsg(1, 'Long one', 'req-1', t.now - FIRST_READ_SKEW_MS + 1), reply(2, 'x'.repeat(5000), { requestId: 'req-1' }, t.now), { seq: 3, body: { kind: 'send-message', message: { type: 'text', content: 'no time' } } }]);
  await t.tick();
  const got = t.store.get(a.id)!;
  assert.equal(got.summary!.length, SUMMARY_MAX);
  assert.equal(t.store.events(a.id)[0].text.length, 1500);
});

test('an ask that was already answered keeps the job running; a relaunch with no cursor reads from the first check on', async () => {
  const t = setup();
  const a = t.job();
  t.w.resume(); // never watched before this run: the first check is the starting point
  t.set([jobMsg(1, 'Post the comment', 'req-1', t.now), { seq: 2, body: { kind: 'send-message', id: 't2s', requestId: 'req-1', message: { type: 'local-tool-permission', ask: { requestId: 'ask-1', status: 'allowed', target: 'ls' } }, timestampMs: t.now } }]);
  await t.tick();
  const got = t.store.get(a.id)!;
  assert.deepEqual([got.status, got.approval!.status], ['running', 'approved']);
});

test('stopping while a transcript read is in flight never touches a closed database', async () => {
  const t = setup();
  let release!: (v: any) => void;
  (t.w as any).o.grok.transcript = () => new Promise((r) => release = r);
  const pending = t.w.check('a');
  t.w.stop(); t.store.close();
  release({ entries: [reply(1, 'late', {}, t.now)], newest: 1, gap: false });
  await pending;
  assert.equal(t.due().length, 0);
});

test('relaunch without a transcript cursor recovers an old job instead of filtering it by restart time', async () => {
  const t = setup();
  const a = t.job();
  t.at(t.now + 60_000);
  t.set([jobMsg(1, 'Post the comment', 'r', a.createdAt), reply(2, 'Recovered result', { requestId: 'r' }, a.createdAt + 10_000)]);
  t.w.resume(); await t.tick();
  assert.equal(t.store.get(a.id)!.summary, 'Recovered result');
});

test('a transcript request rejected after shutdown also leaves the closed store alone', async () => {
  const t = setup(); let reject!: (e: Error) => void;
  (t.w as any).o.grok.transcript = () => new Promise((_resolve, r) => reject = r);
  const pending = t.w.check('a');
  t.w.stop(); t.store.close(); reject(new Error('network closed'));
  await pending;
});

test('an unwatched bot check ignores old history and does not start a polling loop', async () => {
  const t = setup();
  t.set([reply(1, 'Old result', {}, t.now - FIRST_READ_SKEW_MS - 1)]);
  await t.w.check('unwatched');
  assert.equal(t.store.cursor('unwatched'), 1);
  assert.equal(t.store.eventsForCall('unwatched', CALL, 0).length, 0);
  assert.equal(t.due().length, 0);
});
