import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  CallLibrary,
  callIdOf,
  fileOfId,
  fileTime,
  ftsQuery,
  HITS_MAX,
  isCallFile,
  LIBRARY_FILE,
  LIBRARY_VERSION,
  LibraryError,
  LIST_MAX,
  type NewCallRecord,
  parseCallMarkdown,
  QUERY_WORDS,
} from '../src/overlay/library.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-call-lib-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const dir = () => fs.mkdtempSync(path.join(tmp, 'd'));

const F1 = 'call-2026-11-10T14-05-09Z.md';
const F2 = 'call-2026-11-11T09-00-00Z.md';
const F3 = 'call-2026-11-11T09-00-00Z-2.md';
const rec = (file: string, extra: Partial<NewCallRecord> = {}): NewCallRecord => ({
  file,
  kind: 'call',
  startedAt: fileTime(file),
  endedAt: fileTime(file) + 120_000,
  bots: ['Bot A'],
  summary: '',
  decisions: [],
  actionItems: [],
  lines: [],
  ...extra,
});

test('file names, ids and times', () => {
  assert.equal(isCallFile(F1), true);
  assert.equal(isCallFile(F3), true);
  assert.equal(isCallFile('call-x.md'), false);
  assert.equal(isCallFile('../call-2026-11-10T14-05-09Z.md'), false);
  assert.equal(callIdOf(F1), 'call-2026-11-10T14-05-09Z');
  assert.equal(fileOfId('call-2026-11-10T14-05-09Z'), F1);
  assert.throws(() => fileOfId('../etc/passwd'), LibraryError);
  assert.throws(() => fileOfId(''), LibraryError);
  assert.equal(fileTime(F1), Date.parse('2026-11-10T14:05:09Z'));
  assert.equal(fileTime(F3), Date.parse('2026-11-11T09:00:00Z'));
});

test('ftsQuery uses only the words, quoted, with the last one as a prefix', () => {
  assert.equal(ftsQuery(''), null);
  assert.equal(ftsQuery('  "*:() - OR NEAR ^ '), '"or" "near"*');
  assert.equal(ftsQuery('Pricing decision'), '"pricing" "decision"*');
  assert.equal(ftsQuery('pricing decision', true), '"pricing" OR "decision"*');
  assert.equal(ftsQuery('launch a'), '"launch" "a"', 'a one-letter last word is not a prefix (it would match nearly everything)');
  assert.equal(ftsQuery('café Ünïcode 2026'), '"café" "ünïcode" "2026"*');
  const many = Array.from({ length: QUERY_WORDS + 5 }, (_, i) => `w${i}`).join(' ');
  assert.equal(ftsQuery(many)!.split(' ').length, QUERY_WORDS);
  assert.equal(ftsQuery('x'.repeat(500)), `"${'x'.repeat(200)}"*`, 'the query is capped before splitting');
});

test('parseCallMarkdown reads back what overlayMarkdown writes, and tolerates old or broken files', () => {
  const md = [
    '# Grok Meeting, T', '', 'Bots: Bot A, Bot B  ', 'Kind: meeting  ', 'Length: 7 min', '',
    '## Summary', '', 'We chose May.', '',
    '## Decisions', '', '- Launch in May', '- Price at $10', '',
    '## Action items', '', '- Email Sam', 'not a bullet', '',
    '## Tasks', '', '- [ ] #1 Draft plan (no owner)', '',
    '## Transcript', '', '**Shashank (host):** Hi  ', '**Bot A (cut off by the host):** Hello th  ', 'junk line', '**Meeting:** Can you hear me?', '',
    '## Summary', '', 'A second summary section is ignored.', '',
    '## Timeline', '', '- 0:00 join: Bot A joined', '',
    '## Empty',
  ].join('\n');
  const r = parseCallMarkdown(F1, md);
  assert.deepEqual(r, {
    file: F1,
    kind: 'meeting',
    startedAt: fileTime(F1),
    endedAt: fileTime(F1) + 7 * 60_000,
    bots: ['Bot A', 'Bot B'],
    summary: 'We chose May.',
    decisions: ['Launch in May', 'Price at $10'],
    actionItems: ['Email Sam'],
    lines: [
      { who: 'Shashank (host)', text: 'Hi', cut: false },
      { who: 'Bot A', text: 'Hello th', cut: true },
      { who: 'Meeting', text: 'Can you hear me?', cut: false },
    ],
  });
  const bare = parseCallMarkdown(F2, '# Grok Call, T\n\nBots: none  \n\n## Summary\n\n_No summary was saved._\n\n## Action items\n\n- [ ] Old style item\n- [x] Done item\n');
  assert.equal(bare.kind, 'call');
  assert.deepEqual(bare.bots, []);
  assert.equal(bare.summary, '');
  assert.equal(bare.endedAt, bare.startedAt, 'no Length line: zero minutes');
  assert.deepEqual(bare.actionItems, ['Old style item', 'Done item']);
  assert.deepEqual(bare.lines, []);
  const nothing = parseCallMarkdown(F2, 'garbage');
  assert.deepEqual([nothing.summary, nothing.bots, nothing.decisions, nothing.lines], ['', [], [], []]);
});

test('index, get, latest and count; re-indexing replaces a call; bad records are refused', () => {
  const lib = new CallLibrary(dir());
  assert.equal(lib.count(), 0);
  assert.equal(lib.latest(), null);
  assert.equal(lib.recovered, null);
  assert.equal(
    lib.index(rec(F1, {
      summary: '  We set pricing. ',
      decisions: ['Price is $10', '', 7 as unknown as string],
      actionItems: ['Email Sam'],
      bots: undefined as unknown as string[],
      lines: [
        { who: 'Shashank', text: 'What about pricing for the launch?' },
        { who: 'Bot A', text: 'Ten   dollars\nworks.', cut: true },
        { who: '', text: 'no speaker' },
        { who: 'Bot A', text: '   ' },
        null as unknown as { who: string; text: string },
      ],
    })),
    'call-2026-11-10T14-05-09Z',
  );
  const got = lib.get('call-2026-11-10T14-05-09Z')!;
  assert.deepEqual(got.call, {
    id: 'call-2026-11-10T14-05-09Z', file: F1, kind: 'call', startedAt: fileTime(F1), endedAt: fileTime(F1) + 120_000,
    bots: [], summary: 'We set pricing.', decisions: ['Price is $10', '7'], actionItems: ['Email Sam'], lineCount: 2,
  });
  assert.deepEqual(got.lines, [
    { seq: 1, who: 'Shashank', text: 'What about pricing for the launch?', cut: false },
    { seq: 2, who: 'Bot A', text: 'Ten dollars works.', cut: true },
  ]);
  // A summary of undefined, lines that aren't a list and an end before the start still index.
  lib.index(rec(F2, { kind: 'meeting', summary: undefined as unknown as string, lines: 'x' as unknown as [], endedAt: 0 }));
  const meeting = lib.get(callIdOf(F2))!.call;
  assert.deepEqual([meeting.kind, meeting.summary, meeting.lineCount, meeting.endedAt], ['meeting', '', 0, meeting.startedAt]);
  assert.equal(lib.latest()!.id, callIdOf(F2));
  assert.equal(lib.count(), 2);
  // Indexing the same file again replaces it (and its words).
  lib.index(rec(F1, { summary: 'Replaced.', lines: [{ who: 'Bot B', text: 'Only line' }] }));
  assert.equal(lib.get(callIdOf(F1))!.call.summary, 'Replaced.');
  assert.deepEqual(lib.search('pricing'), []);
  assert.equal(lib.count(), 2);
  assert.equal(lib.get('call-2026-01-01T00-00-00Z'), null);
  assert.throws(() => lib.get('nope'), LibraryError);
  assert.throws(() => lib.index(rec('call-x.md')), /not a call file name/);
  assert.throws(() => lib.index(rec(F1, { kind: 'other' as 'call' })), /kind must be call or meeting/);
  assert.throws(() => lib.index(rec(F1, { startedAt: Number.NaN })), /call times must be numbers/);
  assert.throws(() => lib.index(rec(F1, { endedAt: Number.POSITIVE_INFINITY })), /call times must be numbers/);
  lib.close();
  lib.close(); // closing twice is fine
});

test('a failure while indexing rolls back: the call keeps its earlier version', () => {
  const lib = new CallLibrary(dir());
  lib.index(rec(F1, { summary: 'Original.' }));
  const db = (lib as unknown as { db: DatabaseSync }).db;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    if (sql.startsWith('INSERT INTO calls')) throw new Error('disk full');
    return prepare(sql);
  };
  assert.throws(() => lib.index(rec(F1, { summary: 'New.' })), /disk full/);
  db.prepare = prepare;
  assert.equal(lib.get(callIdOf(F1))!.call.summary, 'Original.');
  assert.equal(lib.search('original')[0].field, 'summary');
  lib.close();
});

test('search: every word first, then any word; best first; capped; excludes one call; never FTS syntax', () => {
  const lib = new CallLibrary(dir());
  lib.index(rec(F1, {
    summary: 'We set pricing at ten dollars.',
    decisions: ['Price is ten dollars'],
    actionItems: ['Email Sam about pricing'],
    lines: [{ who: 'Shashank', text: 'What about pricing for the launch?' }, { who: 'Bot A', text: 'Ten dollars works.' }],
  }));
  lib.index(rec(F2, { kind: 'meeting', summary: 'Launch moved to May.', lines: [{ who: 'Meeting', text: 'The launch date is May' }] }));
  const both = lib.search('pricing launch');
  assert.deepEqual(both.map((h) => [h.callId, h.field, h.who, h.snippet, h.kind]), [
    ['call-2026-11-10T14-05-09Z', 'line', 'Shashank', 'What about «pricing» for the «launch»?', 'call'],
  ]);
  // No passage has both words: any word.
  const any = lib.search('dollars may');
  assert.ok(any.length >= 3);
  assert.ok(any.some((h) => h.kind === 'meeting' && h.startedAt === fileTime(F2)));
  assert.ok(any.some((h) => h.field === 'decision' && h.who === null));
  // Prefix on the last word, and accents folded.
  assert.equal(lib.search('pric')[0].callId, callIdOf(F1));
  assert.equal(lib.search('Príçing').length, 3);
  assert.equal(lib.search('pricing', 1).length, 1);
  assert.equal(lib.search('pricing', 0).length, 1);
  assert.equal(lib.search('pricing', Number.NaN).length, 1);
  assert.equal(lib.search('dollars may', 1000).length <= HITS_MAX, true);
  assert.deepEqual(lib.search('pricing', 8, { excludeId: callIdOf(F1) }), []);
  assert.deepEqual(lib.search('"); DROP TABLE calls; --'), []);
  assert.deepEqual(lib.search('***'), []);
  assert.deepEqual(lib.search('zebra unicorn'), []);
  assert.equal(lib.count(), 2, 'nothing a query says is run');
  lib.close();
});

test('list: newest first, paged, by kind, and searched with the best match of each call', () => {
  const lib = new CallLibrary(dir());
  lib.index(rec(F1, { summary: 'Pricing call.', lines: [{ who: 'Bot A', text: 'pricing again and pricing' }] }));
  lib.index(rec(F2, { kind: 'meeting', summary: 'Launch meeting.', lines: [{ who: 'Meeting', text: 'launch pricing' }] }));
  lib.index(rec(F3, { summary: 'Another.' }));
  const all = lib.list();
  assert.deepEqual(all.calls.map((c) => c.id), [callIdOf(F3), callIdOf(F2), callIdOf(F1)], 'same second: the later copy first');
  assert.equal(all.hasMore, false);
  assert.equal(all.calls[0].match, null);
  const page = lib.list({ limit: 2 });
  assert.equal(page.hasMore, true);
  const rest = lib.list({ limit: 2, before: page.calls[1].startedAt });
  assert.deepEqual(rest.calls.map((c) => c.id), [callIdOf(F1)]);
  assert.deepEqual(lib.list({ kind: 'meeting' }).calls.map((c) => c.id), [callIdOf(F2)]);
  assert.equal(lib.list({ limit: 0 }).calls.length, 1);
  assert.equal(lib.list({ limit: 10_000 }).calls.length, 3);
  assert.ok(LIST_MAX >= 3);
  assert.equal(lib.list({ query: '   ' }).calls.length, 3, 'a blank query lists everything');
  const found = lib.list({ query: 'pricing' });
  assert.deepEqual(found.calls.map((c) => [c.id, c.match!.field]), [[callIdOf(F2), 'line'], [callIdOf(F1), 'line']]);
  assert.equal(found.calls[1].match!.snippet, '«pricing» again and «pricing»');
  assert.equal(found.calls[0].match!.kind, 'meeting');
  assert.deepEqual(lib.list({ query: 'pricing', kind: 'call' }).calls.map((c) => c.id), [callIdOf(F1)]);
  assert.equal(lib.list({ query: 'pricing', limit: 1 }).hasMore, true);
  // No call has both words: any word.
  assert.deepEqual(lib.list({ query: 'another launch' }).calls.map((c) => c.id), [callIdOf(F3), callIdOf(F2)]);
  assert.deepEqual(lib.list({ query: '!!!' }).calls, []);
  assert.deepEqual(lib.list({ query: 'zebra' }).calls, []);
  lib.close();
});

// "Show more" sent the last call's start time only, so a call that started in the same second was skipped.
test('paging one call at a time reaches every call once, even two that started in the same second', () => {
  const lib = new CallLibrary(dir());
  for (const f of [F1, F2, F3]) lib.index(rec(f, { summary: 'Pricing.' }));
  for (const query of [undefined, 'pricing']) {
    const seen: string[] = [];
    let page = lib.list({ limit: 1, query });
    for (;;) {
      seen.push(...page.calls.map((c) => c.id));
      if (!page.hasMore) break;
      const last = page.calls.at(-1)!;
      page = lib.list({ limit: 1, query, before: last.startedAt, beforeId: last.id });
    }
    assert.deepEqual(seen, [callIdOf(F3), callIdOf(F2), callIdOf(F1)], String(query));
  }
  lib.close();
});

test('remove, and backfill from the calls folder: adds new files, drops gone ones, skips unreadable ones', () => {
  const d = dir();
  const callsDir = path.join(d, 'calls');
  const lib = new CallLibrary(d);
  assert.deepEqual(lib.backfill(callsDir), { added: 0, removed: 0, failed: [] }, 'no calls folder yet');
  fs.mkdirSync(callsDir);
  fs.writeFileSync(path.join(callsDir, F1), '# Grok Call, T\n\nBots: Bot A  \nLength: 3 min\n\n## Summary\n\nPricing talk.\n\n## Transcript\n\n**Bot A:** ten dollars  \n');
  fs.writeFileSync(path.join(callsDir, 'notes.txt'), 'not a call');
  fs.mkdirSync(path.join(callsDir, F3)); // a folder with a call's name can't be read
  lib.index(rec(F2, { summary: 'Indexed, file gone.' }));
  assert.deepEqual(lib.backfill(callsDir), { added: 1, removed: 1, failed: [F3] });
  assert.equal(lib.get(callIdOf(F1))!.lines[0].text, 'ten dollars');
  assert.equal(lib.get(callIdOf(F2)), null);
  assert.deepEqual(lib.backfill(callsDir), { added: 0, removed: 0, failed: [F3] }, 'already indexed files are left alone');
  assert.equal(lib.remove(callIdOf(F1)), true);
  assert.equal(lib.remove(callIdOf(F1)), false);
  assert.deepEqual(lib.search('pricing'), []);
  assert.throws(() => lib.remove('x'), LibraryError);
  lib.close();
});

test('the index survives reopening, is rebuilt after a version change, and a damaged file is moved aside', () => {
  const d = dir();
  const lib = new CallLibrary(d);
  lib.index(rec(F1, { summary: 'Kept.' }));
  lib.close();
  const again = new CallLibrary(d);
  assert.equal(again.get(callIdOf(F1))!.call.summary, 'Kept.');
  assert.equal((fs.statSync(again.file).mode & 0o777).toString(8), '600');
  again.close();
  // An index from another version starts empty (backfill rebuilds it from the files).
  const raw = new DatabaseSync(path.join(d, LIBRARY_FILE));
  raw.exec(`PRAGMA user_version = ${LIBRARY_VERSION + 1}`);
  raw.close();
  const rebuilt = new CallLibrary(d);
  assert.equal(rebuilt.count(), 0);
  assert.equal(rebuilt.recovered, null);
  rebuilt.close();
  // Not a database at all: kept for inspection under another name, and a fresh index is used.
  const d2 = dir();
  fs.writeFileSync(path.join(d2, LIBRARY_FILE), 'this is not sqlite '.repeat(200));
  const fresh = new CallLibrary(d2);
  assert.match(fresh.recovered!, /call-library\.sqlite\.damaged-\d+$/);
  assert.equal(fs.readFileSync(fresh.recovered!, 'utf8').startsWith('this is not sqlite'), true);
  assert.equal(fresh.count(), 0);
  fresh.index(rec(F1));
  assert.equal(fresh.count(), 1);
  fresh.close();
});

/** Whether `word` is anywhere in the library's files (the database, its WAL and shared memory). */
const inFiles = (d: string, word: string) =>
  fs.readdirSync(d).filter((f) => f.startsWith(LIBRARY_FILE)).some((f) => fs.readFileSync(path.join(d, f)).includes(word));

test('a removed call leaves no trace of its words in the library files, and an older index is wiped once', () => {
  const word = 'zanzibarquokka';
  const d = dir();
  const lib = new CallLibrary(d);
  lib.index(rec(F1, { summary: `Talked about ${word}.`, lines: [{ who: 'Bot A', text: `the ${word} plan` }] }));
  lib.index(rec(F2, { summary: 'Another call.', lines: [{ who: 'Bot A', text: 'pricing' }] }));
  assert.equal(inFiles(d, word), true);
  lib.remove(callIdOf(F1));
  assert.equal(inFiles(d, word), false, 'gone while the library is open');
  lib.close();
  assert.equal(inFiles(d, word), false, 'gone after closing');
  const kept = new CallLibrary(d);
  assert.equal(kept.search('pricing').length, 1, 'the other call is still there');
  kept.close();
  // An index made before deleted calls were wiped: what an earlier delete left behind is wiped at the next open.
  const old = dir();
  new CallLibrary(old).close();
  const raw = new DatabaseSync(path.join(old, LIBRARY_FILE));
  raw.exec("PRAGMA secure_delete = OFF; INSERT INTO docs(docs, rank) VALUES('secure-delete', 0);");
  raw.prepare('INSERT INTO calls VALUES (?,?,?,?,?,?,?,?,?,?)').run(callIdOf(F1), F1, 'call', 1, 2, '[]', word, '[]', '[]', 1);
  raw.prepare('INSERT INTO lines VALUES (?,?,?,?,?)').run(callIdOf(F1), 1, 'Bot A', `the ${word} plan`, 0);
  raw.prepare('INSERT INTO docs (call_id, field, who, text) VALUES (?,?,?,?)').run(callIdOf(F1), 'line', 'Bot A', `the ${word} plan`);
  raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  raw.exec(`DELETE FROM docs; DELETE FROM lines; DELETE FROM calls; PRAGMA wal_checkpoint(TRUNCATE);`);
  raw.close();
  assert.equal(inFiles(old, word), true, 'the old way left the words in the file');
  const wiped = new CallLibrary(old);
  wiped.close();
  assert.equal(inFiles(old, word), false);
  const check = new DatabaseSync(path.join(old, LIBRARY_FILE));
  assert.deepEqual({ ...check.prepare("SELECT v FROM docs_config WHERE k = 'secure-delete'").get() }, { v: 1 }, 'marked, so it runs once');
  check.close();
});
