import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTitle, parseTasks, TASK_LIMITS, TaskBoard, TaskError, type TaskStatus } from '../src/overlay/tasks.ts';

const board = () => {
  const b = new TaskBoard();
  b.add({ title: 'Launch site', by: 'Shashank' }); // #1 parent
  b.add({ title: 'Pick the angle', owner: 'Bot A', parent: 1, by: 'Bot A' }); // #2
  b.add({ title: 'Write copy', owner: 'Bot B', parent: 1, waitsOn: [2], by: 'Bot A' }); // #3
  return b;
};

test('cleanTitle trims, joins lines and caps length', () => {
  assert.equal(cleanTitle('  Ship\n it  '), 'Ship it');
  assert.equal(cleanTitle(undefined), '');
  assert.equal(cleanTitle('x'.repeat(400)).length, TASK_LIMITS.title);
});

test('add numbers tasks, keeps owner, parent and links, and bumps version', () => {
  const b = board();
  assert.deepEqual(b.get(3), { id: 3, title: 'Write copy', owner: 'Bot B', status: 'open', parent: 1, waitsOn: [2], by: 'Bot A', doneBy: null });
  assert.equal(b.get(1).owner, null);
  assert.equal(b.version, 3);
  assert.deepEqual(b.add({ title: 'x', waitsOn: [2, 2], by: 'Y' }).waitsOn, [2]);
});

test('add refuses bad input with a reason a bot can act on', () => {
  const b = board();
  assert.throws(() => b.add({ title: '  ', by: 'A' }), /needs a title/);
  assert.throws(() => b.add({ title: 'x', parent: 9, by: 'A' }), /no task #9/);
  assert.throws(() => b.add({ title: 'x', parent: 2, by: 'A' }), /already a part of #1; parts can't have parts/);
  assert.throws(() => b.add({ title: 'x', waitsOn: [9], by: 'A' }), /no task #9/);
  assert.throws(() => b.add({ title: 'x', parent: 1, waitsOn: [1], by: 'A' }), /can't wait on its own parent #1/);
  const full = new TaskBoard();
  for (let i = 0; i < TASK_LIMITS.max; i++) full.add({ title: `t${i}`, by: 'A' });
  assert.throws(() => full.add({ title: 'one more', by: 'A' }), (e) => e instanceof TaskError && /full \(200 tasks\)/.test(e.message));
});

test('a parent follows its parts: open, then doing, then done', () => {
  const b = board();
  assert.equal(b.statusOf(b.get(1)), 'open');
  b.setStatus(2, 'doing', 'Bot A');
  assert.equal(b.statusOf(b.get(1)), 'doing');
  b.setStatus(2, 'done', 'Bot A');
  b.setStatus(3, 'done', 'Bot B');
  assert.equal(b.statusOf(b.get(1)), 'done');
  assert.throws(() => b.setStatus(1, 'open', 'X'), /has parts; it is done when all of its parts are done/);
});

test('a waiting task cannot start until what it waits on is done, then it is reported ready', () => {
  const b = board();
  assert.throws(() => b.setStatus(3, 'doing', 'Bot B'), /#3 waits on #2, which is not done yet/);
  const r = b.setStatus(2, 'done', 'Bot A');
  assert.deepEqual(r.ready.map((t) => t.id), [3]);
  assert.equal(r.task.doneBy, 'Bot A');
  assert.equal(b.setStatus(3, 'doing', 'Bot B').task.status, 'doing');
  // Reopening #2 sets doneBy back to null; #3 stays as it is.
  assert.equal(b.setStatus(2, 'open', 'Bot A').task.doneBy, null);
});

test('several blockers are listed together', () => {
  const b = new TaskBoard();
  b.add({ title: 'a', by: 'X' });
  b.add({ title: 'b', by: 'X' });
  b.add({ title: 'c', waitsOn: [1, 2], by: 'X' });
  assert.throws(() => b.setStatus(3, 'done', 'X'), /waits on #1, #2, which are not done yet/);
  assert.equal(b.setStatus(1, 'done', 'X').ready.length, 0); // #2 still blocks
  assert.deepEqual(b.setStatus(2, 'done', 'X').ready.map((t) => t.id), [3]);
});

test('finishing the last part makes tasks waiting on the parent ready', () => {
  const b = board();
  b.add({ title: 'Announce', waitsOn: [1], by: 'X' }); // #4
  b.setStatus(2, 'done', 'A');
  assert.deepEqual(b.setStatus(3, 'done', 'B').ready.map((t) => t.id), [4]);
});

test('setStatus refuses unknown tasks and statuses', () => {
  const b = board();
  assert.throws(() => b.setStatus(9, 'done', 'X'), /no task #9/);
  assert.throws(() => b.setStatus(2, 'later' as TaskStatus, 'X'), /must be one of open, doing, done/);
});

test('link adds cross-links and refuses self, parent and loops', () => {
  const b = board();
  b.add({ title: 'Other', owner: 'Bot C', by: 'X' }); // #4
  assert.deepEqual(b.link(4, 3).waitsOn, [3]);
  assert.deepEqual(b.link(4, 3).waitsOn, [3]); // already linked: unchanged
  assert.throws(() => b.link(4, 4), /can't wait on itself/);
  assert.throws(() => b.link(2, 1), /can't wait on its own parent #1/);
  assert.throws(() => b.link(2, 4), /#4 already waits on #2 \(directly or through other tasks\), so this would make a loop/);
  assert.throws(() => b.link(4, 9), /no task #9/);
  assert.throws(() => b.link(9, 4), /no task #9/);
});

test('loop check walks shared paths once', () => {
  const b = new TaskBoard();
  for (const t of ['a', 'b', 'c', 'd']) b.add({ title: t, by: 'X' });
  b.link(2, 1);
  b.link(3, 1);
  b.link(4, 2);
  b.link(4, 3); // #4 reaches #1 two ways
  b.add({ title: 'e', by: 'X' }); // #5
  assert.deepEqual(b.link(5, 4).waitsOn, [4]); // the check walks #4 -> #2, #3 -> #1 (twice) without looping
  assert.throws(() => b.link(1, 4), /loop/);
});

test('unlink and remove drop links; removing a parent removes its parts', () => {
  const b = board();
  b.add({ title: 'Other', waitsOn: [3, 1], by: 'X' }); // #4
  assert.deepEqual(b.unlink(4, 3).waitsOn, [1]);
  assert.throws(() => b.unlink(9, 1), /no task #9/);
  assert.deepEqual(b.remove(1).map((t) => t.id), [1, 2, 3]);
  assert.deepEqual(b.tasks.map((t) => [t.id, t.waitsOn]), [[4, []]]);
  assert.throws(() => b.remove(1), /no task #1/);
  // New ids keep counting from the highest left.
  assert.equal(b.add({ title: 'n', by: 'X' }).id, 5);
});

test('text shows each task the way a bot reads it', () => {
  const b = board();
  assert.equal(new TaskBoard().text(), 'There are no tasks yet.');
  assert.equal(
    b.text(),
    [
      '- #1 Launch site · owner: nobody · open',
      '- #2 Pick the angle · owner: Bot A · open · part of #1',
      '- #3 Write copy · owner: Bot B · waiting on #2 · part of #1',
    ].join('\n'),
  );
  b.setStatus(2, 'done', 'Bot A');
  assert.equal(b.line(b.get(2)), '- #2 Pick the angle · owner: Bot A · done · part of #1 · done by Bot A');
  b.setStatus(3, 'done', 'Bot B');
  assert.equal(b.line(b.get(1)), '- #1 Launch site · owner: nobody · done'); // done through its parts: no "done by"
});

test('ownText lists only open tasks of that owner', () => {
  const b = board();
  assert.equal(b.ownText('Bot B'), '- #3 Write copy · owner: Bot B · waiting on #2 · part of #1');
  assert.equal(b.ownText('Nobody'), '');
  b.setStatus(2, 'done', 'Bot A');
  assert.equal(b.ownText('Bot A'), '');
});

test('carryOver keeps open tasks and their parents, and drops links to done tasks', () => {
  const b = board();
  b.add({ title: 'Solo done', by: 'X' }); // #4
  b.setStatus(4, 'done', 'X');
  b.setStatus(2, 'done', 'Bot A');
  const kept = b.carryOver();
  assert.deepEqual(kept.map((t) => t.id), [1, 3]);
  assert.deepEqual(kept.find((t) => t.id === 3)!.waitsOn, []);
  b.setStatus(3, 'done', 'Bot B');
  assert.deepEqual(b.carryOver(), []);
});

test('the constructor copies tasks so outside changes do not leak in', () => {
  const src = board().tasks;
  const b = new TaskBoard(src);
  src[2].waitsOn.push(99);
  assert.deepEqual(b.get(3).waitsOn, [2]);
});

test('parseTasks round-trips a board and fills safe defaults', () => {
  const b = board();
  b.setStatus(2, 'done', 'Bot A');
  assert.deepEqual(parseTasks(JSON.parse(JSON.stringify(b.tasks))), b.tasks);
  const [t] = parseTasks([{ id: 1, title: ' x ', status: 'open', waitsOn: [], owner: 'o'.repeat(200) }]);
  assert.deepEqual(t, { id: 1, title: 'x', owner: 'o'.repeat(TASK_LIMITS.by), status: 'open', parent: null, waitsOn: [], by: 'unknown', doneBy: null });
});

test('parseTasks refuses broken files with the reason', () => {
  const ok = { id: 1, title: 'a', status: 'open', parent: null, waitsOn: [], by: 'X', doneBy: null };
  const bad: [unknown, RegExp][] = [
    [null, /tasks must be a list/],
    [Array(TASK_LIMITS.max + 1).fill(ok), /more than 200 tasks/],
    [[null], /each task must be an object/],
    [[{ ...ok, id: 0 }], /own whole-number id/],
    [[ok, ok], /own whole-number id/],
    [[{ ...ok, title: ' ' }], /#1 has no title/],
    [[{ ...ok, owner: 5 }], /owner must be text/],
    [[{ ...ok, status: 'x' }], /unknown status/],
    [[{ ...ok, parent: 'x' }], /parent must be a task id/],
    [[{ ...ok, waitsOn: 'x' }], /waitsOn must be task ids/],
    [[{ ...ok, waitsOn: [1.5] }], /waitsOn must be task ids/],
    [[{ ...ok, parent: 7 }], /parent #7 is not a task/],
    [[{ ...ok, parent: 1 }], /parent #1 is not a task/],
    [[ok, { ...ok, id: 2, parent: 1 }, { ...ok, id: 3, parent: 2 }], /its parent #2 is itself a part/],
    [[{ ...ok, waitsOn: [4] }], /waits on #4, which is not a task/],
    [[{ ...ok, waitsOn: [2] }, { ...ok, id: 2, waitsOn: [1] }], /loop/],
    [[ok, { ...ok, id: 2, parent: 1, waitsOn: [1] }], /can't wait on its own parent/],
  ];
  for (const [raw, why] of bad) assert.throws(() => parseTasks(raw), (e) => e instanceof TaskError && why.test(e.message), String(why));
});


test('dependency cycles through a parent and its parts are refused in either link order', () => {
  for (const reverse of [false, true]) {
    const b = new TaskBoard();
    b.add({ title: 'Launch', by: 'Host' });
    b.add({ title: 'Write', parent: 1, by: 'A' });
    b.add({ title: 'Review', by: 'B' });
    const first = reverse ? [2, 3] : [3, 1];
    const second = reverse ? [3, 1] : [2, 3];
    b.link(first[0], first[1]);
    assert.throws(() => b.link(second[0], second[1]), /loop/);
    assert.deepEqual(b.get(second[0]).waitsOn, []);
  }
});

test('adding a part cannot make it wait on its parent through another task', () => {
  const b = new TaskBoard();
  b.add({ title: 'Launch', by: 'Host' });
  b.add({ title: 'Review launch', waitsOn: [1], by: 'A' });
  const version = b.version;
  assert.throws(() => b.add({ title: 'Write', parent: 1, waitsOn: [2], by: 'B' }), /loop/);
  assert.equal(b.tasks.length, 2);
  assert.equal(b.version, version);
});
