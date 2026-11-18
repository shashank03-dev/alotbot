import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { CALLS_LISTED, OverlayStore, parseOverlayMemory, summaryOf } from '../src/overlay/store.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-call-store-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const fresh = () => new OverlayStore(fs.mkdtempSync(path.join(tmp, 's')));
const task = { id: 1, title: 'Plan', owner: 'Bot A', status: 'open', parent: null, waitsOn: [], by: 'Shashank', doneBy: null };

test('parseOverlayMemory cleans the summary and checks tasks', () => {
  assert.deepEqual(parseOverlayMemory({ summary: ' We  met.\n', tasks: [task] }), { summary: 'We met.', tasks: [task], decisions: [] }, 'saved before decisions existed');
  assert.deepEqual(parseOverlayMemory({ summary: '', tasks: [], decisions: [' Go  now ', '', 'x'.repeat(600)] }).decisions, ['Go now', 'x'.repeat(500)]);
  assert.equal(parseOverlayMemory({ summary: '', tasks: [], decisions: Array.from({ length: 60 }, (_, i) => `D${i}`) }).decisions[0], 'D10', 'the newest 50 are kept');
  assert.throws(() => parseOverlayMemory({ summary: '', tasks: [], decisions: 'Go' }), /decisions must be a list of text/);
  assert.throws(() => parseOverlayMemory({ summary: '', tasks: [], decisions: [1] }), /decisions must be a list of text/);
  assert.equal(parseOverlayMemory({ summary: 'x'.repeat(3000), tasks: [] }).summary.length, 2000);
  assert.throws(() => parseOverlayMemory(null), /must be an object/);
  assert.throws(() => parseOverlayMemory({ summary: 1, tasks: [] }), /summary must be text/);
  assert.throws(() => parseOverlayMemory({ summary: '', tasks: 'x' }), /tasks must be a list/);
});

test('summaryOf reads the Summary section', () => {
  assert.equal(summaryOf('# T\n\n## Summary\n\nWe met.\n\n## Tasks\n'), 'We met.');
  assert.equal(summaryOf('# T\n\n## Summary\n\n_No summary was saved._\n\n## Transcript\n'), '');
  assert.equal(summaryOf('nothing here'), '');
  assert.equal(summaryOf(`\n## Summary\n\n${'a'.repeat(400)}\n\n## X`).length, 300);
});

test('memory: missing or broken files read as null; writes are atomic and private', () => {
  const s = fresh();
  assert.equal(s.readMemory(), null);
  fs.writeFileSync(s.memoryFile, '{not json');
  assert.equal(s.readMemory(), null);
  s.writeMemory({ summary: 'Hi', tasks: [task as any], decisions: ['Go'] });
  assert.deepEqual(s.readMemory(), { summary: 'Hi', tasks: [task], decisions: ['Go'] });
  assert.equal(fs.statSync(s.memoryFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(s.dir).filter((n) => n.endsWith('.tmp')), []);
});

test('saveCall writes the call and memory; same-second calls get -2, -3', () => {
  const s = fresh();
  const now = new Date('2026-11-10T14:05:09Z');
  const md = (x: string) => `# C\n\n## Summary\n\n${x}\n\n## Transcript\n`;
  assert.equal(s.saveCall({ summary: 'A', tasks: [], decisions: [] }, md('First'), now), 'call-2026-11-10T14-05-09Z.md');
  assert.equal(s.saveCall({ summary: 'B', tasks: [], decisions: [] }, md('Second'), now), 'call-2026-11-10T14-05-09Z-2.md');
  assert.equal(s.saveCall({ summary: 'C', tasks: [], decisions: [] }, md('Third'), new Date('2026-11-11T09:00:00Z')), 'call-2026-11-11T09-00-00Z.md');
  assert.equal(s.readMemory()!.summary, 'C');
  fs.writeFileSync(path.join(s.callsDir, 'notes.txt'), 'ignored');
  assert.deepEqual(s.listCalls().map((c) => [c.file, c.summary]), [
    ['call-2026-11-11T09-00-00Z.md', 'Third'],
    ['call-2026-11-10T14-05-09Z-2.md', 'Second'],
    ['call-2026-11-10T14-05-09Z.md', 'First'],
  ]);
  assert.equal(s.listCalls()[0].at, Date.parse('2026-11-11T09:00:00Z'));
  assert.equal(s.readCall('call-2026-11-10T14-05-09Z.md'), md('First'));
});

test('listCalls is empty with no calls folder and keeps only the newest 50', () => {
  const s = fresh();
  assert.deepEqual(s.listCalls(), []);
  for (let i = 0; i < CALLS_LISTED + 3; i++) s.saveCall({ summary: '', tasks: [], decisions: [] }, 'x', new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
  const list = s.listCalls();
  assert.equal(list.length, CALLS_LISTED);
  assert.equal(list[0].file, 'call-2026-01-01T00-00-52Z.md');
});

test('readCall only accepts call file names', () => {
  const s = fresh();
  for (const bad of ['../auth.json', 'call-x.md', 'overlay-memory.json', 'call-2026-11-10T14-05-09Z.md/../../a']) {
    assert.throws(() => s.readCall(bad), /not a call file name/);
  }
  assert.throws(() => s.readCall('call-2026-11-10T14-05-09Z.md'), /ENOENT/);
});
