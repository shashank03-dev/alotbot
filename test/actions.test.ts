import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ActionStore, RESULT_MAX } from '../src/actions.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-actions-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (now?: () => number) => new ActionStore(path.join(tmp, String(++n)), now);
const job = { callId: 'call-1', botId: 'a', botName: 'Bot A', target: 'agent' as const, tool: 'send_task', input: { request: 'post it' } };

test('an action is recorded before dispatch, then updated, and survives reopening the file', () => {
  let t = 1000;
  const dir = path.join(tmp, 'reopen');
  const s = new ActionStore(dir, () => t);
  const a = s.create(job);
  assert.deepEqual(
    { ...a, id: 'x' },
    { id: 'x', callId: 'call-1', botId: 'a', botName: 'Bot A', target: 'agent', tool: 'send_task', input: { request: 'post it' }, status: 'running', requestId: null, summary: null, result: null, error: null, approval: null, createdAt: 1000, updatedAt: 1000 },
  );
  t = 2000;
  const approval = { kind: 'auto_review' as const, requestId: 'r1', entryId: null, summary: 'Post the comment', status: 'pending' as const };
  const b = s.update(a.id, { status: 'waiting_approval', requestId: 'req-1', approval });
  assert.deepEqual([b.status, b.requestId, b.approval, b.updatedAt, b.createdAt], ['waiting_approval', 'req-1', approval, 2000, 1000]);
  s.update(a.id, { status: 'completed', summary: 'Posted.', result: '{"url":"x"}', approval: null, error: null });
  s.close();
  const again = new ActionStore(dir, () => t);
  const c = again.get(a.id)!;
  assert.deepEqual([c.status, c.summary, c.result, c.approval, c.error], ['completed', 'Posted.', '{"url":"x"}', null, null]);
  for (const f of [again.file]) assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'only this user can read it');
  again.close();
});

test('bad updates are refused; unknown ids are null; lists are newest first and per call', () => {
  let t = 0;
  const s = fresh(() => ++t);
  assert.equal(s.get('nope'), null);
  assert.throws(() => s.update('nope', { status: 'failed' }), /no action nope/);
  const a = s.create(job);
  assert.throws(() => s.update(a.id, { status: 'done' as any }), /unknown action status "done"/);
  const b = s.create({ ...job, callId: 'call-2', target: 'app', tool: 'use_app_tool', input: undefined });
  assert.equal(b.input, null);
  assert.deepEqual(s.list().map((x) => x.id), [b.id, a.id]);
  assert.deepEqual(s.list({ callId: 'call-1' }).map((x) => x.id), [a.id]);
  assert.deepEqual(s.list({ limit: 1 }).map((x) => x.id), [b.id]);
  assert.equal(s.list({ limit: 0 }).length, 1, 'at least one');
  s.close();
});

test('a huge result is kept up to RESULT_MAX with a note', () => {
  const s = fresh();
  const a = s.create(job);
  const big = 'x'.repeat(RESULT_MAX + 10);
  const r = s.update(a.id, { result: big }).result!;
  assert.equal(r.slice(0, RESULT_MAX), big.slice(0, RESULT_MAX));
  assert.match(r.slice(RESULT_MAX), /\[cut: the full result was 2000010 characters\]$/);
  s.close();
});

test('jobs to watch: open ones for a day, answered ones for a quiet window; only agent jobs', () => {
  let t = 0;
  const s = fresh(() => t);
  const open = s.create(job);
  const answered = s.create(job);
  const app = s.create({ ...job, target: 'app' });
  const search = s.create({ ...job, tool: 'search_conversations' });
  t = 10;
  s.update(answered.id, { status: 'completed' });
  t = 100;
  assert.deepEqual(s.watchedJobs(1000, 200).map((x) => x.id), [open.id, answered.id]);
  assert.deepEqual(s.watchedJobs(1000, 50).map((x) => x.id), [open.id], 'answered too long ago');
  t = 2000;
  assert.deepEqual(s.watchedJobs(1000, 5000).map((x) => x.id), [open.id], 'unresolved jobs remain visible after the old age limit');
  assert.ok(!s.watchedJobs(1e9, 1e9).some((x) => x.id === app.id || x.id === search.id), 'only background jobs');
  s.close();
});

test('request ids find their job; dedupe finds a recent action that did not fail', () => {
  let t = 0;
  const s = fresh(() => t);
  const a = s.create({ ...job, dedupeKey: 'k' });
  s.update(a.id, { requestId: 'req-9' });
  assert.equal(s.byRequest('a', 'req-9')!.id, a.id);
  assert.equal(s.byRequest('b', 'req-9'), null);
  assert.equal(s.byRequest('a', 'other'), null);
  assert.equal(s.dedupe('k', 0)!.id, a.id);
  assert.equal(s.dedupe('k', 1)!.id, a.id, 'running writes remain reserved');
  s.update(a.id, { status: 'completed' });
  assert.equal(s.dedupe('k', 1), null, 'a completed action outside the window may run again');
  assert.equal(s.dedupe('other', 0), null);
  s.update(a.id, { status: 'failed' });
  assert.equal(s.dedupe('k', 0), null, 'a failed action can be tried again');
  s.close();
});

test('chat entries are recorded once per bot and seq, and read back per call', () => {
  const s = fresh();
  const e = { botId: 'a', seq: 5, callId: 'call-1', actionId: 'x', kind: 'reply' as const, text: 'Done.', at: 1 };
  assert.equal(s.addEvent(e), true);
  assert.equal(s.addEvent({ ...e, text: 'replayed' }), false, 'a replay is dropped');
  assert.equal(s.addEvent({ ...e, botId: 'b' }), true, 'another bot has its own seqs');
  s.addEvent({ ...e, seq: 3, kind: 'written', actionId: null, text: 'typed' });
  s.addEvent({ ...e, seq: 7, callId: 'call-2' });
  assert.deepEqual(s.eventsForCall('a', 'call-1', 0).map((x) => [x.seq, x.kind, x.text, x.actionId]), [[3, 'written', 'typed', null], [5, 'reply', 'Done.', 'x']]);
  assert.deepEqual(s.eventsForCall('a', 'call-1', 3).map((x) => x.seq), [5]);
  assert.deepEqual(s.events('x').map((x) => [x.botId, x.seq]), [['a', 5], ['b', 5], ['a', 7]]);
  s.close();
});

test('cursors start unknown and move', () => {
  const s = fresh();
  assert.equal(s.cursor('a'), null);
  s.setCursor('a', 10);
  s.setCursor('a', 12);
  assert.equal(s.cursor('a'), 12);
  s.close();
});

test('a transaction is all or nothing', () => {
  const s = fresh();
  assert.throws(() => s.tx(() => {
    s.create(job);
    throw new Error('stop');
  }), /stop/);
  assert.equal(s.list().length, 0);
  assert.equal(s.tx(() => s.create(job).status), 'running');
  assert.equal(s.list().length, 1);
  s.close();
});

test('a damaged history file is set aside, not fatal', () => {
  const dir = path.join(tmp, 'broken');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'actions.sqlite'), 'this is not a database'.repeat(100));
  fs.writeFileSync(path.join(dir, 'actions.sqlite-wal'), 'junk');
  const s = new ActionStore(dir, () => 42);
  assert.equal(s.create(job).status, 'running');
  assert.ok(fs.existsSync(path.join(dir, 'actions.sqlite.broken-42')));
  assert.ok(!fs.readdirSync(dir).includes('actions.sqlite-wal') || fs.readFileSync(path.join(dir, 'actions.sqlite-wal')).toString() !== 'junk');
  s.close();
});

test('a row edited by hand with broken JSON still lists', () => {
  const dir = path.join(tmp, 'edited');
  const s = new ActionStore(dir);
  const a = s.create(job);
  const raw = new DatabaseSync(path.join(dir, 'actions.sqlite'));
  raw.prepare("UPDATE actions SET input = '{bad', approval = 'nope' WHERE id = ?").run(a.id);
  raw.close();
  assert.deepEqual([s.get(a.id)!.input, s.get(a.id)!.approval], [null, null]);
  s.close();
});

test('startup reconciles interrupted direct actions as unknown without replaying them', () => {
  const s = fresh();
  const direct = s.create({ ...job, target: 'app', tool: 'use_app_tool' });
  const agent = s.create(job);
  s.recoverInterrupted();
  assert.equal(s.get(direct.id)!.status, 'unknown');
  assert.equal(s.get(agent.id)!.status, 'running');
  s.close();
});

test('a filesystem open failure is surfaced without renaming or replacing user files', () => {
  const dir = path.join(tmp, 'directory-conflict');
  fs.mkdirSync(path.join(dir, 'actions.sqlite'), { recursive: true });
  assert.throws(() => new ActionStore(dir));
  assert.ok(fs.statSync(path.join(dir, 'actions.sqlite')).isDirectory());
  assert.deepEqual(fs.readdirSync(dir), ['actions.sqlite']);
});

test('workspace metadata survives restart without draft, secure input or executable stale actions',()=>{
 const dir=path.join(tmp,'workspace-cards');let store=new ActionStore(dir);
 const card:any={id:'entry',seq:4,kind:'secret-request',title:'Secret requested',status:'pending',requestId:'r',sessionId:'s',text:'PRIVATE',draft:{body:'PRIVATE',signatureHtml:'PRIVATE',attachments:[{path:'/PRIVATE/file.pdf',sizeBytes:2}],revision:'PRIVATE'},actions:['respond'],fields:[{value:'PRIVATE'}]};
 store.saveWorkspaceCards('uuid-a',[card]);assert.doesNotMatch(fs.readFileSync(store.file).toString(),/PRIVATE/);
 store.close();store=new ActionStore(dir);const saved=store.workspaceCards('uuid-a');assert.equal(saved[0].id,'entry');assert.deepEqual(saved[0].actions,[]);assert.equal(saved[0].text,'');assert.deepEqual(store.workspaceCards('uuid-b'),[]);assert.deepEqual(store.workspaceCards('uuid-a',4),[]);
 store.saveWorkspaceCards('uuid-a',[{...card,seq:3,status:'stale'}]);assert.equal(store.workspaceCards('uuid-a')[0].status,'pending');
 store.saveWorkspaceCards('uuid-a',Array.from({length:1001},(_,i)=>({...card,id:'e'+i,seq:i+10})));assert.equal(store.workspaceCards('uuid-a').length,100);assert.ok(store.workspaceCards('uuid-a',11).every(c=>c.seq<11));store.close();
});
test('a workspace persistence failure rolls back the whole batch',()=>{
 const store=fresh(),other=new DatabaseSync(store.file);other.exec("CREATE TRIGGER fail_workspace BEFORE INSERT ON workspace_events WHEN NEW.seq=2 BEGIN SELECT RAISE(FAIL,'write failed'); END");
 const card:any={id:'one',seq:1,kind:'text',title:'Message',status:'done',requestId:'',sessionId:''};
 assert.throws(()=>store.saveWorkspaceCards('a',[card,{...card,id:'two',seq:2}]),/write failed/);assert.deepEqual(store.workspaceCards('a'),[]);other.close();store.close();
});
