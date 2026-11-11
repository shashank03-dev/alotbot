import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BotLink, USER } from '../public/core.js';
import { gaze, overlayMarkdown, TASK_TOOLS, tasksText } from '../src/overlay/call.ts';
import { TaskBoard } from '../src/overlay/tasks.ts';
import { bot, hostSays, reply, setup } from './overlay-fakes.ts';

const A = bot('a');
const B = bot('b');
const C = bot('c'); // on the account, not in the call

async function twoBots(memory: { summary: string; tasks: any[] } | null = null) {
  const h = setup();
  h.call.joinWith([A, B], [A, B, C], memory);
  await h.ready('a', 'b');
  return h;
}

test('bots get the task tools instead of the notepad tools, and keep search', async () => {
  const { ws } = await twoBots();
  const names = ws('a').lastSession().tools.map((t: any) => t.name ?? t.type);
  for (const t of TASK_TOOLS) assert.ok(names.includes(t.name));
  for (const gone of ['write_note', 'read_notes', 'done_task']) assert.ok(!names.includes(gone));
  assert.ok(names.includes('web_search') && names.includes('invite_bot') && names.includes('save_summary'));
  assert.equal(names.filter((n: string) => n === 'add_task').length, 1);
});

test('instructions explain tasks, list the bot\'s own open tasks, and never mention the notepad', async () => {
  const board = new TaskBoard();
  board.add({ title: 'Draft the plan', owner: 'Bot A', by: USER });
  const { ws } = await twoBots({ summary: 'We picked May.', tasks: board.tasks });
  const a = ws('a').lastSession().instructions;
  assert.doesNotMatch(a, /notepad/i);
  assert.match(a, /There is a task list that every bot and Shashank can see/);
  assert.match(a, /Your open tasks:\n- #1 Draft the plan · owner: Bot A · open/);
  assert.match(a, /# Your last call with Shashank\nSummary: We picked May\.$/);
  assert.match(ws('b').lastSession().instructions, /You have no open tasks\./);
});

test('without a last summary, no last-call section is added', async () => {
  const { ws } = await twoBots();
  assert.doesNotMatch(ws('a').lastSession().instructions, /Your last call/);
});

test('if core\'s wording changes, the task text is still added', async () => {
  const original = BotLink.prototype.instructions;
  BotLink.prototype.instructions = () => 'Base text.';
  try {
    const { ws } = await twoBots();
    assert.match(ws('a').lastSession().instructions, /^Base text\.\n\nThere is a task list/);
  } finally {
    BotLink.prototype.instructions = original;
  }
});

test('tasksText is the same text the bots get', () => {
  const b = new TaskBoard();
  assert.match(tasksText(b, 'X'), /You have no open tasks\. $/);
});

test('add_task: owners can be me, another bot (in the call or not), the host, or nobody', async () => {
  const { call, ws } = await twoBots();
  reply(ws('a'), '', [
    ['add_task', { title: 'Plan', owner: 'me' }],
    ['add_task', { title: 'Write', owner: 'Bot B', parent: '#1' }],
    ['add_task', { title: 'Review', owner: 'host', waits_on: ['#2', 1] }],
    ['add_task', { title: 'Research', owner: 'Bot C' }],
    ['add_task', { title: 'Someday' }],
    ['add_task', { title: 'Mine', owner: USER }],
  ]);
  assert.deepEqual(ws('a').outputs(), ['Task #1 added for you.', 'Task #2 added for Bot B.', 'Task #3 added for Shashank.', 'Task #4 added for Bot C.', 'Task #5 added.', 'Task #6 added for Shashank.']);
  assert.deepEqual(call.board.get(2).parent, 1);
  assert.deepEqual(call.board.get(3).waitsOn, [2, 1]);
  // Only Bot B is told; the bot that made the change already knows.
  assert.ok(ws('b').said().includes('[Tasks]: Bot A gave you task #2: Write'));
  assert.ok(!ws('a').said().some((s) => s.startsWith('[Tasks]')));
  // Bot B's instructions now list its task.
  assert.match(ws('b').lastSession().instructions, /Your open tasks:\n- #2 Write/);
});

test('task tool mistakes come back as "Not done" with the reason', async () => {
  const { ws } = await twoBots();
  reply(ws('a'), '', [
    ['add_task', { title: 'x', owner: 'Nobody Real' }],
    ['add_task', { title: ' ' }],
    ['update_task', { id: 9, status: 'done' }],
    ['link_tasks', { id: 1, waits_on: 1 }],
    ['add_task', '{bad json'],
  ]);
  const out = ws('a').outputs();
  assert.match(out[0], /^Not done: No bot called "Nobody Real"\. Owners can be: Shashank, Bot A, Bot B, Bot C\.$/);
  assert.equal(out[1], 'Not done: The task needs a title.');
  assert.equal(out[2], 'Not done: There is no task #9.');
  assert.equal(out[3], 'Not done: There is no task #1.');
  assert.equal(out[4], 'Not done: The task needs a title.');
});

test('update_task: the owner hears about it, and tasks that were waiting are announced as ready', async () => {
  const { call, ws } = await twoBots();
  call.addTask({ title: 'Pick angle', owner: 'Bot A', parent: null, waitsOn: [] }, USER);
  call.addTask({ title: 'Write copy', owner: 'Bot B', parent: null, waitsOn: [1] }, USER);
  assert.ok(ws('a').said().includes('[Tasks]: Shashank gave you task #1: Pick angle'));
  reply(ws('b'), '', [['update_task', { id: 2, status: 'doing' }]]);
  assert.equal(ws('b').outputs().at(-1), 'Not done: Task #2 waits on #1, which is not done yet.');
  reply(ws('b'), '', [['update_task', { id: 1, status: 'done' }]]);
  assert.equal(ws('b').outputs().at(-1), 'Task #1 is done.');
  assert.ok(ws('a').said().includes('[Tasks]: Bot B marked your task #1 done'));
  // Bot B made the change, so it is not told its own task is ready.
  assert.ok(!ws('b').said().some((s) => s.includes('can start')));
  call.setTaskStatus(1, 'open', USER);
  call.setTaskStatus(1, 'done', USER);
  assert.ok(ws('b').said().includes('[Tasks]: #1 is done, so your task #2 (Write copy) can start'));
});

test('link_tasks and list_tasks', async () => {
  const { call, ws } = await twoBots();
  call.addTask({ title: 'One', owner: 'Bot B', parent: null, waitsOn: [] }, USER);
  call.addTask({ title: 'Two', owner: null, parent: null, waitsOn: [] }, USER);
  reply(ws('a'), '', [['link_tasks', { id: 1, waits_on: 2 }], ['link_tasks', { id: 2, waits_on: 1 }], ['list_tasks', {}]]);
  const out = ws('a').outputs();
  assert.equal(out[0], 'Task #1 now waits on #2.');
  assert.match(out[1], /^Not done: #1 already waits on #2 .*loop\.$/);
  assert.equal(out[2], call.board.text());
  assert.ok(ws('b').said().includes('[Tasks]: Bot A made your task #1 wait on #2'));
  // A task with no owner tells nobody.
  call.addTask({ title: 'Three', owner: null, parent: null, waitsOn: [] }, USER);
  const before = ws('a').said().length + ws('b').said().length;
  assert.deepEqual(call.linkTasks(3, 1, USER).waitsOn, [1]);
  assert.equal(ws('a').said().length + ws('b').said().length, before);
});

test('host task changes from the app: unlink and remove tell the owners', async () => {
  const { call, ws } = await twoBots();
  call.addTask({ title: 'Parent', owner: 'Bot A', parent: null, waitsOn: [] }, USER);
  call.addTask({ title: 'Part', owner: 'Bot B', parent: 1, waitsOn: [] }, USER);
  call.addTask({ title: 'Mine', owner: USER, parent: null, waitsOn: [1] }, USER);
  call.addTask({ title: 'Loose', owner: null, parent: null, waitsOn: [] }, USER);
  assert.deepEqual(call.unlinkTasks(3, 1, USER).waitsOn, []);
  assert.deepEqual(call.removeTask(1, USER).map((t) => t.id), [1, 2]);
  assert.ok(ws('a').said().includes('[Tasks]: Shashank removed your task #1 (Parent)'));
  assert.ok(ws('b').said().includes('[Tasks]: Shashank removed your task #2 (Part)'));
  call.removeTask(3, USER); // the host's own task: nobody to tell
  call.removeTask(4, USER); // no owner
  assert.equal(call.board.tasks.length, 0);
});

test('old notepad tools are refused with the right tool names; other tools still work', async () => {
  const { call, ws } = await twoBots();
  reply(ws('a'), '', [['write_note', { text: 'x' }], ['wait_for_host', {}]]);
  assert.match(ws('a').outputs()[0], /"write_note" is not a tool in this call\. Use add_task, update_task, link_tasks or list_tasks\./);
  assert.equal(call.waitingForHost, true);
});

test('unexpected errors in task tools are not swallowed', async () => {
  const { call } = await twoBots();
  call.board.add = () => {
    throw new Error('disk on fire');
  };
  assert.throws(() => call.onToolCall(call.links.get('a'), { name: 'add_task', args: '{"title":"x"}' }), /disk on fire/);
});

test('ownerOf: "me" only works for a bot', async () => {
  const { call } = await twoBots();
  assert.equal(call.ownerOf('  ', 'Bot A'), null);
  assert.equal(call.ownerOf(undefined, 'Bot A'), null);
  assert.equal(call.ownerOf('myself', 'Bot A'), 'Bot A');
  assert.equal(call.ownerOf('the host', null), USER);
  assert.throws(() => call.ownerOf('me', null), /No bot called "me"/);
});

test('wrap-up shows the summary bot the tasks with owners and done marks', async () => {
  const { call, ws } = await twoBots();
  hostSays(ws('a'), 'Let us plan the launch.');
  call.addTask({ title: 'Plan', owner: 'Bot A', parent: null, waitsOn: [] }, USER);
  call.addTask({ title: 'Loose', owner: null, parent: null, waitsOn: [] }, USER);
  call.setTaskStatus(1, 'done', 'Bot A');
  void call.wrapUp();
  const asks = ws('a').sent.filter((m) => m.type === 'response.create' && m.response?.instructions);
  const text = asks.at(-1).response.instructions;
  assert.match(text, /- \[x\] 1\. Plan \(owner: Bot A\) \(done by Bot A\)/);
  assert.match(text, /- \[ \] 2\. Loose \(added by Shashank\)/);
  call.leave();
});

test('overlayExport: tasks with real status, memory carries open tasks and keeps the last summary', async () => {
  const board = new TaskBoard();
  board.add({ title: 'Old', by: USER });
  const { call, ws } = await twoBots({ summary: 'Earlier call.', tasks: board.tasks });
  let d = call.overlayExport();
  assert.equal(d.saveWorthy, false);
  assert.equal(d.memory.summary, 'Earlier call.');
  call.addTask({ title: 'Parent', owner: null, parent: null, waitsOn: [] }, USER);
  call.addTask({ title: 'Part', owner: null, parent: 2, waitsOn: [] }, USER);
  call.setTaskStatus(3, 'done', USER);
  reply(ws('a'), '', [['save_summary', { summary: 'New summary.', action_items: ['Ship it'] }]]);
  d = call.overlayExport();
  assert.equal(d.saveWorthy, true);
  assert.equal(d.summary, 'New summary.');
  assert.deepEqual(d.actionItems, ['Ship it']);
  assert.equal(d.tasks.find((t) => t.id === 2)!.status, 'done');
  assert.deepEqual(d.memory, { summary: 'New summary.', tasks: [{ ...board.tasks[0] }] });
  hostSays(ws('a'), 'Hello there everyone.');
  assert.equal(call.overlayExport().saveWorthy, true);
});

test('linesSince gives new transcript lines with who said them', async () => {
  const { call, ws } = await twoBots();
  hostSays(ws('a'), 'Bot A, what do you think?');
  reply(ws('a'), 'I think May works.');
  call.lines.push({ who: 'Someone Gone', text: 'hi' });
  call.lines.push({ who: 'Bot B', text: 'Half', cut: true });
  const all = call.linesSince(0);
  assert.deepEqual(all.map((l) => [l.seq, l.who, l.botId, l.cut]), [
    [1, USER, null, false],
    [2, 'Bot A', 'a', false],
    [3, 'Someone Gone', null, false],
    [4, 'Bot B', 'b', true],
  ]);
  assert.deepEqual(call.linesSince(3).map((l) => l.seq), [4]);
  assert.deepEqual(call.linesSince(4), []);
});

test('overlayView: live words of the speaking bot, gaze, focus and versions', async () => {
  const { call, ws, audio } = await twoBots();
  let v = call.overlayView();
  assert.equal(v.live, null);
  assert.deepEqual(v.bots.map((b) => b.looksAt), [null, null]);
  const s = ws('a');
  s.emit('response.created');
  s.emit('response.output_item.added', { item: { id: 'i1' } });
  s.emit('response.output_audio.delta', { delta: Buffer.alloc(4800).toString('base64') });
  v = call.overlayView();
  assert.equal(v.live, null); // speaking, but no words yet
  s.emit('response.output_audio_transcript.delta', { delta: 'Hello every' });
  v = call.overlayView();
  assert.deepEqual(v.live, { botId: 'a', text: 'Hello every' });
  assert.deepEqual(v.bots.map((b) => [b.id, b.status, b.looksAt]), [['a', 'speaking', 'host'], ['b', 'idle', 'a']]);
  assert.equal(v.linesSeq, 0);
  assert.equal(v.tasksVersion, 0);
  assert.equal(v.focus, null);
  audio.t = 10;
  assert.equal(call.overlayView().live, null);
});

test('gaze rules', () => {
  const bots = [{ id: 'a', status: 'speaking' }, { id: 'b', status: 'idle' }, { id: 'c', status: 'quiet' }];
  const g = (b: typeof bots, user: boolean, focus: string | null) => [...gaze(b, user, focus).values()];
  assert.deepEqual(g(bots, true, null), ['host', 'host', 'host']); // host talks: everyone looks at the host
  assert.deepEqual(g(bots, true, 'b'), [null, 'host', null]); // one-on-one: only that bot looks
  assert.deepEqual(g(bots, false, null), ['host', 'a', 'a']); // a bot talks: the others look at it
  assert.deepEqual(g(bots, false, 'a'), ['host', 'a', 'a']); // the one-on-one bot talks: same
  assert.deepEqual(g(bots, false, 'b'), ['host', null, null]); // another bot talks during a one-on-one: others stay idle
  assert.deepEqual(g(bots.map((b) => ({ ...b, status: 'idle' })), false, null), [null, null, null]);
});

test('overlayMarkdown writes summary, action items, tasks under parents, the transcript, the timeline and the log file', () => {
  const d = {
    startedAt: 0,
    endedAt: 125_000,
    bots: ['Bot A'],
    lines: [{ who: USER, text: 'Hi' }, { who: 'Bot A', text: 'Hello', cut: true }],
    summary: 'We met.',
    actionItems: ['Ship'],
    tasks: [
      { id: 1, title: 'Parent', owner: null, status: 'doing' as const, parent: null, waitsOn: [], by: USER, doneBy: null },
      { id: 3, title: 'Other', owner: 'Bot A', status: 'open' as const, parent: null, waitsOn: [2], by: USER, doneBy: null },
      { id: 2, title: 'Part', owner: 'Bot A', status: 'done' as const, parent: 1, waitsOn: [], by: USER, doneBy: 'Bot A' },
    ],
    memory: { summary: '', tasks: [] },
    timeline: [{ at: 0, kind: 'join', text: 'Bot A joined' }, { at: 75_400, kind: 'tool', text: 'Bot A searched its past chats for "x"' }],
    logFile: 'call-1970-01-01T00-00-00Z.jsonl' as string | null,
    saveWorthy: true,
  };
  assert.equal(
    overlayMarkdown(d, () => 'T'),
    [
      '# Grok Call, T', '', 'Bots: Bot A  ', 'Length: 2 min', '',
      '## Summary', '', 'We met.', '',
      '## Action items', '', '- Ship', '',
      '## Tasks', '', '- [ ] #1 Parent (no owner)', '  - [x] #2 Part (owner: Bot A; done by Bot A)', '- [ ] #3 Other (owner: Bot A; waits on #2)', '',
      '## Transcript', '', '**Shashank (host):** Hi  ', '**Bot A (cut off by the host):** Hello  ', '',
      '## Timeline', '', '- 0:00 join: Bot A joined', '- 1:15 tool: Bot A searched its past chats for "x"', '',
      'Full log: `logs/call-1970-01-01T00-00-00Z.jsonl`', '',
    ].join('\n'),
  );
  const empty = overlayMarkdown({ ...d, bots: [], lines: [], summary: '', actionItems: [], tasks: [], endedAt: -5, timeline: [], logFile: null });
  assert.match(empty, /^# Grok Call, 1970-01-01T00:00:00\.000Z/);
  assert.match(empty, /Bots: none {2}\nLength: 0 min/);
  assert.match(empty, /_No summary was saved\._\n\n## Transcript\n\n_Nothing was said\._/);
  assert.match(empty, /## Timeline\n\n_Nothing happened\._\n$/);
  assert.doesNotMatch(empty, /Full log/);
});

test('a bot added mid-call gets the conversation so far; bad tool arguments count as none', async () => {
  const { call, ws, ready } = await twoBots();
  hostSays(ws('a'), 'We are planning the launch.');
  call.addBot(C);
  await ready('c');
  assert.match(ws('c').said()[0], /We are planning the launch\./);
  assert.equal(call.onToolCall(call.links.get('c'), { name: 'add_task', args: 'null' }).output, 'Not done: The task needs a title.');
});

test('overlayView reports the one-on-one bot', async () => {
  const { call, ws } = await twoBots();
  hostSays(ws('a'), 'Bot B, just you: what is the plan?');
  assert.equal(call.overlayView().focus, 'b');
});


test('removing a blocker refreshes the dependent bot instructions', async () => {
  const { call, ws } = await twoBots();
  call.addTask({ title: 'Research', owner: 'Bot A', parent: null, waitsOn: [] }, USER);
  call.addTask({ title: 'Write', owner: 'Bot B', parent: null, waitsOn: [1] }, USER);
  assert.match(ws('b').lastSession().instructions, /waiting on #1/);
  call.removeTask(1, USER);
  assert.match(ws('b').lastSession().instructions, /#2 Write · owner: Bot B · open/);
  assert.doesNotMatch(ws('b').lastSession().instructions, /waiting on #1/);
});


test('removing the unfinished part refreshes the parent owner and bots waiting on the parent', async () => {
  const { call, ws } = await twoBots();
  call.addTask({ title: 'Launch', owner: 'Bot A', parent: null, waitsOn: [] }, USER);
  call.addTask({ title: 'Draft', owner: null, parent: 1, waitsOn: [] }, USER);
  call.addTask({ title: 'Ship', owner: 'Bot B', parent: null, waitsOn: [1] }, USER);
  call.addTask({ title: 'Review', owner: null, parent: 1, waitsOn: [] }, USER);
  call.setTaskStatus(4, 'done', USER);
  assert.match(ws('b').lastSession().instructions, /waiting on #1/);
  call.removeTask(2, USER);
  assert.doesNotMatch(ws('a').lastSession().instructions, /#1 Launch/);
  assert.match(ws('b').lastSession().instructions, /#3 Ship · owner: Bot B · open/);
});


test('parent completion and newly added parts refresh every affected owner', async () => {
  const { call, ws } = await twoBots();
  call.addTask({ title: 'Launch', owner: 'Bot A', parent: null, waitsOn: [] }, USER);
  call.addTask({ title: 'Draft', owner: null, parent: 1, waitsOn: [] }, USER);
  call.addTask({ title: 'Ship', owner: 'Bot B', parent: null, waitsOn: [1] }, USER);
  call.setTaskStatus(2, 'done', USER);
  assert.doesNotMatch(ws('a').lastSession().instructions, /#1 Launch/);
  assert.match(ws('b').lastSession().instructions, /#3 Ship · owner: Bot B · open/);
  call.addTask({ title: 'Review', owner: null, parent: 1, waitsOn: [] }, USER);
  assert.match(ws('a').lastSession().instructions, /#1 Launch · owner: Bot A · doing/);
  assert.match(ws('b').lastSession().instructions, /waiting on #1/);
});
