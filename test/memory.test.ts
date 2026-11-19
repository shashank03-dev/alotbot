import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BadInput, callFileName, CallStore, LIMITS, parseMemory } from '../src/memory.ts';

const good = { summary: ' We chose  May. ', actionItems: ['Email Sam', '  '], notes: [{ text: 'Budget\n5k', by: 'Bot A' }, { text: ' ', by: 'X' }] };

test('parseMemory cleans text and drops empty entries', () => {
  assert.deepEqual(parseMemory(good), { summary: 'We chose May.', actionItems: ['Email Sam'], notes: [{ text: 'Budget 5k', by: 'Bot A' }] });
});

test('parseMemory refuses bad shapes with the reason', () => {
  const bad: [unknown, RegExp][] = [
    [null, /memory must be an object/],
    ['x', /memory must be an object/],
    [{ ...good, summary: 5 }, /summary must be text/],
    [{ ...good, summary: 'x'.repeat(LIMITS.summary + 1) }, /summary is longer than 2000/],
    [{ ...good, actionItems: 'x' }, /actionItems must be a list/],
    [{ ...good, actionItems: Array(LIMITS.items + 1).fill('a') }, /actionItems has more than 200/],
    [{ ...good, actionItems: [1] }, /action item must be text/],
    [{ ...good, notes: [null] }, /each note must be an object/],
    [{ ...good, notes: [{ text: 'a' }] }, /note author must be text/],
    [{ ...good, notes: [{ text: 'a'.repeat(LIMITS.item + 1), by: 'b' }] }, /note is longer than 500/],
  ];
  for (const [input, msg] of bad) assert.throws(() => parseMemory(input), (e: Error) => e instanceof BadInput && msg.test(e.message), String(msg));
});

test('callFileName is safe on every file system', () => {
  assert.equal(callFileName(new Date('2026-11-10T14:05:09.123Z')), 'call-2026-11-10T14-05-09Z');
});

test('CallStore saves memory and one export per call, private to you', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alotbot-mem-'));
  const store = new CallStore(path.join(dir, 'data'));
  assert.equal(store.readMemory(), null, 'no file yet');
  const now = new Date('2026-11-10T14:05:09Z');
  const m = parseMemory(good);
  assert.equal(store.save(m, '# one', now), path.join('calls', 'call-2026-11-10T14-05-09Z.md'));
  assert.equal(store.save(m, '# two', now), path.join('calls', 'call-2026-11-10T14-05-09Z-2.md'), 'same second: no overwrite');
  assert.equal(store.save(m, '# three', now), path.join('calls', 'call-2026-11-10T14-05-09Z-3.md'));
  assert.equal(fs.readFileSync(path.join(store.callsDir, 'call-2026-11-10T14-05-09Z.md'), 'utf8'), '# one');
  assert.deepEqual(store.readMemory(), m);
  assert.equal(fs.statSync(store.memoryFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(store.callsDir, 'call-2026-11-10T14-05-09Z-2.md')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(store.callsDir).mode & 0o777, 0o700);
  assert.match(store.save(m, '# now'), /^calls[/\\]call-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ(-\d+)?\.md$/, 'defaults to the current time');
  // a broken or hand-edited file is ignored rather than crashing the next call
  fs.writeFileSync(store.memoryFile, '{not json');
  assert.equal(store.readMemory(), null);
  fs.writeFileSync(store.memoryFile, JSON.stringify({ summary: 1 }));
  assert.equal(store.readMemory(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
