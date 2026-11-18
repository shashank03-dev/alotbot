import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { USER } from '../public/core.js';
import {
  CALLS_SEARCHED,
  LATEST_LISTED,
  MATCHES_MAX,
  PAST_CALLS_TOOL,
  callFiles,
  callLabel,
  callTime,
  callUnits,
  queryWords,
  searchPastCalls,
} from '../src/past-calls.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-call-past-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const fresh = () => fs.mkdtempSync(path.join(tmp, 'c'));

/** A saved call, as Grok Call writes one. */
const call = (summary: string, decisions: string[] = [], lines: string[] = []) =>
  [
    '# Grok Call, 2026-11-10', '', 'Bots: Bot A  ', 'Length: 3 min', '',
    '## Summary', '', summary || '_No summary was saved._', '',
    ...(decisions.length ? ['## Decisions', '', ...decisions.map((d) => `- ${d} (Bot A, at 1:00)`), ''] : []),
    '## Transcript', '', ...(lines.length ? lines.map((l) => `**Bot A:** ${l}  `) : ['_Nothing was said._']), '',
    '## Timeline', '', '- 0:01 bot: Bot A: launch launch launch', '',
  ].join('\n');

test('the tool: one optional query, described for the host by name', () => {
  assert.equal(PAST_CALLS_TOOL.name, 'search_past_calls');
  assert.equal(PAST_CALLS_TOOL.type, 'function');
  assert.match(PAST_CALLS_TOOL.description, new RegExp(`Search ${USER}'s saved earlier group calls`));
  assert.deepEqual(PAST_CALLS_TOOL.parameters.required, []);
});

test('callFiles lists saved calls newest first, same-second saves in order, and nothing else', () => {
  const dir = fresh();
  for (const f of ['call-2026-11-10T14-05-09Z.md', 'call-2026-11-10T14-05-09Z-2.md', 'call-2026-11-11T09-00-00Z.md', 'notes.md', 'call-x.md']) fs.writeFileSync(path.join(dir, f), 'x');
  assert.deepEqual(callFiles(dir), ['call-2026-11-11T09-00-00Z.md', 'call-2026-11-10T14-05-09Z-2.md', 'call-2026-11-10T14-05-09Z.md']);
  assert.deepEqual(callFiles(path.join(dir, 'missing')), []);
  assert.equal(callTime('call-2026-11-10T14-05-09Z-2.md'), Date.parse('2026-11-10T14:05:09Z'));
  assert.equal(callLabel('call-2026-11-10T14-05-09Z.md'), '2026-11-10 14:05 UTC');
});

test('callUnits: lines with their section; the title, placeholders and timeline are left out', () => {
  assert.deepEqual(callUnits(call('We met.', ['Ship it'], ['Hello **there**'])), [
    { section: 'Summary', text: 'We met.' },
    { section: 'Decisions', text: 'Ship it (Bot A, at 1:00)' },
    { section: 'Transcript', text: 'Bot A: Hello there' },
  ]);
  assert.deepEqual(callUnits('## Tasks\n\n- [x] #1 Ship\n- [ ] #2 Test\n* Note'), [
    { section: 'Tasks', text: '#1 Ship' },
    { section: 'Tasks', text: '#2 Test' },
    { section: 'Tasks', text: 'Note' },
  ]);
});

test('queryWords keeps the words that say what to look for', () => {
  assert.deepEqual(queryWords('What did we decide about the launch date last call? The launch!'), ['decide', 'launch', 'date']);
  assert.deepEqual(queryWords('what was it'), []);
});

test('no saved calls: says so', () => {
  assert.deepEqual(searchPastCalls(path.join(fresh(), 'none'), 'launch'), { found: 0, note: 'There are no saved calls yet.' });
});

test('a search ranks lines with more of the words first, then what was decided, then newer calls', () => {
  const dir = fresh();
  fs.writeFileSync(path.join(dir, 'call-2026-11-01T10-00-00Z.md'), call('Old pricing talk.', ['Launch on Friday'], ['We could launch in spring']));
  fs.writeFileSync(path.join(dir, 'call-2026-11-08T10-00-00Z.md'), call('', ['Launch in May with the new pricing'], ['Launching is risky']));
  const r: any = searchPastCalls(dir, 'launch pricing');
  assert.equal(r.query, 'launch pricing');
  assert.equal(r.searched, 2);
  assert.deepEqual(r.matches.map((m: any) => [m.call.slice(0, 10), m.section, m.text]), [
    ['2026-11-08', 'Decisions', 'Launch in May with the new pricing (Bot A, at 1:00)'],
    ['2026-11-01', 'Decisions', 'Launch on Friday (Bot A, at 1:00)'], // one word, but a decision: before the summary
    ['2026-11-01', 'Summary', 'Old pricing talk.'],
    ['2026-11-08', 'Transcript', 'Bot A: Launching is risky'],
    ['2026-11-01', 'Transcript', 'Bot A: We could launch in spring'],
  ]);
  assert.equal(r.found, 5);
  assert.deepEqual(r.calls, [
    { call: '2026-11-08 10:00 UTC', summary: '(no summary was saved)' },
    { call: '2026-11-01 10:00 UTC', summary: 'Old pricing talk.' },
  ]);
  assert.equal(r.note, undefined);
  const none: any = searchPastCalls(dir, 'zebra');
  assert.deepEqual([none.found, none.matches, none.calls], [0, [], []]);
  assert.match(none.note, /Nothing in the saved calls matches/);
});

test('a search returns at most MATCHES_MAX lines, cut to a readable length, from the newest CALLS_SEARCHED calls', () => {
  const dir = fresh();
  const long = `launch ${'x'.repeat(400)}`;
  fs.writeFileSync(path.join(dir, 'call-2026-11-01T10-00-00Z.md'), call(long, [], Array.from({ length: 20 }, (_, i) => `launch step ${i}`)));
  const r: any = searchPastCalls(dir, 'launch');
  assert.equal(r.matches.length, MATCHES_MAX);
  assert.equal(r.found, 21);
  assert.equal(r.matches[0].text.length, 300);
  assert.ok(r.matches[0].text.endsWith('…'));
  assert.equal(r.calls[0].summary.length, 300);
  const many = fresh();
  for (let i = 0; i < CALLS_SEARCHED + 2; i++) fs.writeFileSync(path.join(many, `call-2026-01-01T00-${String(Math.floor(i / 60)).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}Z.md`), call(i < 2 ? 'oldest marker' : 'x'));
  assert.equal((searchPastCalls(many, 'marker') as any).searched, CALLS_SEARCHED);
  assert.equal((searchPastCalls(many, 'marker') as any).found, 0, 'the two oldest are past the limit');
});

test('no query (or not text): the latest calls with their summaries and decisions', () => {
  const dir = fresh();
  for (let d = 1; d <= LATEST_LISTED + 1; d++) fs.writeFileSync(path.join(dir, `call-2026-11-0${d}T10-00-00Z.md`), call(`Call ${d}.`, d === 6 ? ['Go'] : []));
  const r: any = searchPastCalls(dir, undefined);
  assert.equal(r.saved, LATEST_LISTED + 1);
  assert.equal(r.latest.length, LATEST_LISTED);
  assert.deepEqual(r.latest[0], { call: '2026-11-06 10:00 UTC', summary: 'Call 6.', decisions: ['Go (Bot A, at 1:00)'] });
  assert.deepEqual(r.latest[1].decisions, []);
  assert.deepEqual(searchPastCalls(dir, 'what was it'), r, 'a query of only filler words lists too');
  assert.deepEqual(searchPastCalls(dir, 42), r);
});
