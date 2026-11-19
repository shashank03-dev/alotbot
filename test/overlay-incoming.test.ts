import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  type ActionView,
  CALLBACK_MAX_MS,
  CALLBACKS_PER_BOT,
  callbackWhen,
  CHECK_MS,
  DECLINE_COOLDOWN_MS,
  defaultSettings,
  HELD_MAX_MS,
  INCOMING_FILE,
  IncomingCalls,
  IncomingError,
  LATE_GRACE_MS,
  MISSED_KEPT,
  nextRun,
  parseSaved,
  parseSchedule,
  parseSettings,
  quietUntil,
  RING_SECONDS,
  type Schedule,
  SCHEDULES_MAX,
} from '../src/overlay/incoming.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alotbot-inc-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const newDir = () => fs.mkdtempSync(path.join(tmp, 'd'));

// Wednesday 18 November 2026, 13:00 UTC: outside the default quiet hours (22:00-08:00 UTC).
const WED_1300 = Date.parse('2026-11-18T13:00:00Z');
const MIN = 60_000;
const KNOWN = new Set(['a', 'b', 'c']);
const weekly = (extra: object = {}) => ({ title: 'Standup', botIds: ['a', 'b'], agenda: 'Yesterday, today, blockers', days: [3], time: '13:05', timezone: 'UTC', ...extra });

/** A manager on a fake clock: timers run when `advance` passes them. */
function harness(dir = newDir(), start = WED_1300) {
  let now = start;
  let id = 0;
  const timers: { id: number; at: number; fn: () => void; done: boolean }[] = [];
  let busy = false;
  let changes = 0;
  const make = () =>
    new IncomingCalls({
      dir,
      now: () => now,
      setTimer: (fn, ms) => {
        timers.push({ id: ++id, at: now + ms, fn, done: false });
        return id;
      },
      clearTimer: (t) => {
        const x = timers.find((y) => y.id === t);
        if (x) x.done = true;
      },
      busy: () => busy,
      zone: () => 'UTC',
      changed: () => changes++,
    });
  const inc = make();
  return {
    inc,
    dir,
    make,
    timers,
    get now() {
      return now;
    },
    set busy(v: boolean) {
      busy = v;
    },
    get changes() {
      return changes;
    },
    /** Moves the clock on, running every timer that falls due on the way, in order. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => !t.done && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.done = true;
        now = Math.max(now, due.at);
        due.fn();
      }
      now = end;
    },
    jump(ms: number) {
      now += ms;
    },
    pending: () => timers.filter((t) => !t.done),
  };
}

const view = (extra: Partial<ActionView> = {}): ActionView => ({
  id: 'act-1', botId: 'a', botName: 'Bot A', callId: 'call-1-a', target: 'agent', tool: 'send_task', status: 'running', summary: null, error: null, approvalSummary: null, ...extra,
});

// ---------- parsing ----------

test('defaultSettings uses the Mac\'s zone, or UTC when it is not a zone', () => {
  assert.equal(defaultSettings('Asia/Kolkata').quietHours.timezone, 'Asia/Kolkata');
  assert.equal(defaultSettings('Nowhere/City').quietHours.timezone, 'UTC');
  assert.deepEqual(defaultSettings('UTC'), {
    botCallbacks: true, jobResults: true, approvals: true,
    quietHours: { enabled: true, start: '22:00', end: '08:00', timezone: 'UTC' },
    doNotDisturbUntil: null, ringSeconds: RING_SECONDS.default,
  });
});

test('parseSchedule checks every field and tidies days and bots', () => {
  assert.deepEqual(parseSchedule(weekly({ botIds: ['b', 'a', 'b'], days: [5, 1, 5], agenda: '  x  ', title: '  Weekly   sync ' }), KNOWN), {
    title: 'Weekly sync', botIds: ['b', 'a'], agenda: 'x', days: [1, 5], time: '13:05', timezone: 'UTC', enabled: true,
  });
  assert.equal(parseSchedule(weekly({ agenda: null, enabled: false }), KNOWN).enabled, false);
  assert.equal(parseSchedule(weekly({ agenda: undefined }), KNOWN).agenda, '');
  const bad: [unknown, RegExp][] = [
    [null, /schedule must be an object/],
    [[], /schedule must be an object/],
    [weekly({ title: '  ' }), /title is required/],
    [weekly({ title: 7 }), /title is required/],
    [weekly({ title: 'x'.repeat(81) }), /title is longer than 80/],
    [weekly({ botIds: [] }), /botIds must be a list/],
    [weekly({ botIds: 'a' }), /botIds must be a list/],
    [weekly({ botIds: ['a', 3] }), /botIds must be a list/],
    [weekly({ botIds: Array.from({ length: 9 }, (_, i) => `b${i}`) }), /at most 8 bots/],
    [weekly({ botIds: ['a', 'gone'] }), /not on this account any more/],
    [weekly({ agenda: 5 }), /agenda must be text/],
    [weekly({ agenda: 'x'.repeat(1001) }), /agenda is longer than 1000/],
    [weekly({ days: [] }), /days must be a list of weekdays/],
    [weekly({ days: [7] }), /days must be a list of weekdays/],
    [weekly({ days: [1.5] }), /days must be a list of weekdays/],
    [weekly({ days: 'mon' }), /days must be a list of weekdays/],
    [weekly({ time: '9:00' }), /time must be HH:MM/],
    [weekly({ timezone: 'Mars/Base' }), /timezone must be a time zone name/],
    [weekly({ enabled: 'yes' }), /enabled must be true or false/],
  ];
  for (const [raw, why] of bad) assert.throws(() => parseSchedule(raw, KNOWN), why);
  assert.throws(() => parseSchedule(null, KNOWN), IncomingError);
});

test('parseSettings changes only the fields given, and checks each', () => {
  const base = defaultSettings('UTC');
  const next = parseSettings({ jobResults: false, quietHours: { enabled: false, start: '23:30', end: '07:00', timezone: 'Europe/Paris' }, ringSeconds: 30, doNotDisturbUntil: WED_1300 + MIN }, base, WED_1300);
  assert.deepEqual(next, { ...base, jobResults: false, ringSeconds: 30, doNotDisturbUntil: WED_1300 + MIN, quietHours: { enabled: false, start: '23:30', end: '07:00', timezone: 'Europe/Paris' } });
  assert.equal(base.quietHours.enabled, true, 'the current settings are not changed in place');
  assert.equal(parseSettings({ doNotDisturbUntil: null }, next, WED_1300).doNotDisturbUntil, null);
  assert.deepEqual(parseSettings({ quietHours: {} }, base, WED_1300), base);
  const bad: [unknown, RegExp][] = [
    [null, /settings must be an object/],
    [{ botCallbacks: 'no' }, /botCallbacks must be true or false/],
    [{ quietHours: 'night' }, /quietHours must be an object/],
    [{ quietHours: { enabled: 1 } }, /quietHours.enabled must be true or false/],
    [{ quietHours: { start: '25:00' } }, /quietHours.start must be HH:MM/],
    [{ quietHours: { end: 8 } }, /quietHours.end must be HH:MM/],
    [{ quietHours: { timezone: 'x' } }, /quietHours.timezone must be a time zone name/],
    [{ doNotDisturbUntil: WED_1300 }, /doNotDisturbUntil must be a time within the next 7 days/],
    [{ doNotDisturbUntil: WED_1300 + CALLBACK_MAX_MS + 1 }, /within the next 7 days/],
    [{ doNotDisturbUntil: 'later' }, /within the next 7 days/],
    [{ ringSeconds: 5 }, /ringSeconds must be 15 to 120/],
    [{ ringSeconds: 121 }, /ringSeconds must be 15 to 120/],
    [{ ringSeconds: 30.5 }, /ringSeconds must be 15 to 120/],
  ];
  for (const [raw, why] of bad) assert.throws(() => parseSettings(raw, base, WED_1300), why);
});

test('parseSaved keeps every good piece of a damaged file and drops the rest', () => {
  assert.deepEqual(parseSaved(null, 'UTC', WED_1300), { version: 1, schedules: [], callbacks: [], settings: defaultSettings('UTC'), rings: [], checkedAt: WED_1300, cooldowns: {} });
  const s = parseSaved({
    settings: { jobResults: false, ringSeconds: 3, quietHours: { start: '21:00', end: 'late', timezone: 'Mars' }, doNotDisturbUntil: WED_1300 - 1, unknown: 1 },
    schedules: [
      { ...weekly(), id: 's1', createdAt: 1 },
      { ...weekly({ time: 'noon' }), id: 's2', createdAt: 1 },
      { ...weekly(), id: 3, createdAt: 1 },
      { ...weekly(), id: 's4' },
      { ...weekly({ botIds: 'a' }), id: 's5', createdAt: 1 },
      'junk',
    ],
    callbacks: [
      { id: 'c1', botId: 'a', botName: 'Bot A', reason: 'r', at: WED_1300 + MIN, waitsFor: [], createdAt: 1 },
      { id: 'c2', botId: 'a', reason: 'r', at: null, waitsFor: ['x', 5], createdAt: 1 },
      { id: 'c3', botId: 'a', at: null, waitsFor: [], createdAt: 1 },
      { id: 'c4', botId: 'a', at: 'soon', waitsFor: 'x', createdAt: 1 },
      { botId: 'a', at: 1, createdAt: 1 },
      7,
    ],
    rings: [
      { id: 'r1', source: 'schedule', title: 'T', reason: 'R', botIds: ['a'], agenda: 'A', createdAt: 1, state: 'ringing', note: 'n' },
      { id: 'r2', source: 'job', title: 'T', reason: 'R', botIds: ['a'], agenda: 5, createdAt: 2, state: 'answered', note: 'kept', scheduleId: 's1' },
      { id: 'r3', source: 'nope', botIds: [], createdAt: 1 },
      { id: 'r4', source: 'job', botIds: [1], createdAt: 1 },
      { id: 'r5', source: 'job', botIds: 'a', createdAt: 1 },
      { id: 'r6', source: 'callback', botIds: ['a'], createdAt: 3, state: 'declined' },
      null,
    ],
    checkedAt: WED_1300 + 99 * MIN,
    cooldowns: { a: WED_1300 + MIN, b: WED_1300 - MIN, c: 'x' },
  }, 'UTC', WED_1300);
  assert.equal(s.settings.jobResults, false);
  assert.equal(s.settings.ringSeconds, RING_SECONDS.default, 'a bad value keeps its default');
  assert.deepEqual(s.settings.quietHours, { enabled: true, start: '21:00', end: '08:00', timezone: 'UTC' });
  assert.equal(s.settings.doNotDisturbUntil, null);
  assert.deepEqual(s.schedules.map((x) => x.id), ['s1']);
  assert.deepEqual(s.callbacks.map((c) => [c.id, c.botName, c.waitsFor, c.at]), [['c1', 'Bot A', [], WED_1300 + MIN], ['c2', 'A bot', ['x'], null]]);
  assert.deepEqual(s.rings.map((r) => [r.id, r.state, r.note, r.agenda, r.scheduleId]), [
    ['r1', 'missed', 'Alotbot was closed while this rang.', 'A', null],
    ['r2', 'answered', 'kept', '', 's1'],
    ['r6', 'declined', '', '', null],
  ]);
  assert.equal(s.checkedAt, WED_1300, 'a check time in the future (a clock change) is not trusted');
  assert.deepEqual(s.cooldowns, { a: WED_1300 + MIN });
  const dnd = parseSaved({ settings: { doNotDisturbUntil: WED_1300 + MIN }, checkedAt: WED_1300 - MIN }, 'UTC', WED_1300);
  assert.equal(dnd.settings.doNotDisturbUntil, WED_1300 + MIN);
  assert.equal(parseSaved({ settings: { doNotDisturbUntil: WED_1300 } }, 'UTC', WED_1300).settings.doNotDisturbUntil, null, 'ending right now is over');
  assert.equal(dnd.checkedAt, WED_1300 - MIN);
  assert.equal(parseSaved({ settings: [] }, 'UTC', WED_1300).settings.jobResults, true);
  // More than SCHEDULES_MAX schedules, or MISSED_KEPT rings, keep the first schedules and the newest rings.
  const many = parseSaved({
    schedules: Array.from({ length: SCHEDULES_MAX + 2 }, (_, i) => ({ ...weekly(), id: `s${i}`, createdAt: 1 })),
    rings: Array.from({ length: MISSED_KEPT + 2 }, (_, i) => ({ id: `r${i}`, source: 'job', botIds: ['a'], createdAt: i, state: 'declined' })),
  }, 'UTC', WED_1300);
  assert.equal(many.schedules.length, SCHEDULES_MAX);
  assert.equal(many.rings[0].id, 'r2');
});

test('nextRun is null for a paused call; quietUntil gives the end of the quiet hours you are in', () => {
  const s = { ...parseSchedule(weekly(), KNOWN), id: 's', createdAt: 0 } as Schedule;
  assert.equal(nextRun(s, WED_1300), Date.parse('2026-11-18T13:05:00Z'));
  assert.equal(nextRun({ ...s, enabled: false }, WED_1300), null);
  const q = defaultSettings('UTC').quietHours;
  assert.equal(quietUntil(q, WED_1300), null);
  assert.equal(quietUntil({ ...q, enabled: false }, Date.parse('2026-11-18T23:00:00Z')), null);
  assert.equal(quietUntil(q, Date.parse('2026-11-18T23:00:00Z')), Date.parse('2026-11-19T08:00:00Z'), 'before midnight: tomorrow morning');
  assert.equal(quietUntil(q, Date.parse('2026-11-19T03:00:00Z')), Date.parse('2026-11-19T08:00:00Z'), 'after midnight: this morning');
  assert.equal(quietUntil({ ...q, start: '12:00', end: '14:00' }, WED_1300), Date.parse('2026-11-18T14:00:00Z'));
});

test('callbackWhen reads minutes, clock times, ISO times and job waits, and refuses the rest', () => {
  const now = WED_1300;
  assert.deepEqual(callbackWhen({ in_minutes: 30 }, now, 'UTC'), { at: now + 30 * MIN, jobs: false });
  assert.deepEqual(callbackWhen({ when_job_done: true, at: '', in_minutes: null }, now, 'UTC'), { at: null, jobs: true });
  assert.equal(callbackWhen({ at: '15:30' }, now, 'UTC').at, Date.parse('2026-11-18T15:30:00Z'));
  assert.equal(callbackWhen({ at: '09:00' }, now, 'UTC').at, Date.parse('2026-11-19T09:00:00Z'), 'already past today: tomorrow');
  assert.equal(callbackWhen({ at: '3:30 pm' }, now, 'UTC').at, Date.parse('2026-11-18T15:30:00Z'));
  assert.equal(callbackWhen({ at: '12:15 a.m.' }, now, 'UTC').at, Date.parse('2026-11-19T00:15:00Z'));
  assert.equal(callbackWhen({ at: '12:15PM' }, now, 'UTC').at, Date.parse('2026-11-19T12:15:00Z'));
  assert.equal(callbackWhen({ at: '9:15 am' }, now, 'Asia/Kolkata').at, Date.parse('2026-11-19T03:45:00Z'));
  assert.equal(callbackWhen({ at: '2026-11-19T09:00' }, now, 'Asia/Kolkata').at, Date.parse('2026-11-19T03:30:00Z'), 'no offset: the Mac\'s zone');
  assert.equal(callbackWhen({ at: '2026-11-19 09:00:30' }, now, 'UTC').at, Date.parse('2026-11-19T09:00:00Z'));
  assert.equal(callbackWhen({ at: '2026-11-19T09:00:00.000+05:30' }, now, 'UTC').at, Date.parse('2026-11-19T03:30:00Z'));
  assert.equal(callbackWhen({ at: '2026-11-19T09:00Z' }, now, 'Asia/Kolkata').at, Date.parse('2026-11-19T09:00:00Z'));
  assert.equal(callbackWhen({ at: '2026-11-19T09:00-0500' }, now, 'UTC').at, Date.parse('2026-11-19T14:00:00Z'));
  assert.equal(callbackWhen({ at: '2028-02-29T09:00' }, now, 'UTC').at, Date.parse('2028-02-29T09:00:00Z'), 'a leap day');
  const bad: [Record<string, unknown>, RegExp][] = [
    [{}, /exactly one of/],
    [{ in_minutes: 5, at: '10:00' }, /exactly one of/],
    [{ when_job_done: 'yes' }, /when_job_done must be true/],
    [{ in_minutes: 0 }, /in_minutes must be a whole number from 1 to 10080/],
    [{ in_minutes: 10081 }, /in_minutes must be/],
    [{ in_minutes: 2.5 }, /in_minutes must be/],
    [{ at: '13:30 pm' }, /the hour must be 1 to 12/],
    [{ at: '0:30 am' }, /the hour must be 1 to 12/],
    [{ at: '25:00' }, /must be a real time/],
    [{ at: '10:75' }, /must be a real time/],
    [{ at: 'tomorrow' }, /at must be HH:MM or an ISO date-time/],
    [{ at: 42 }, /at must be HH:MM or an ISO date-time/],
    [{ at: '2026-13-01T10:00' }, /real date and time/],
    [{ at: '2026-11-00T10:00' }, /real date and time/],
    [{ at: '2026-11-32T10:00' }, /real date and time/],
    [{ at: '2026-11-19T24:00' }, /real date and time/],
    [{ at: '2026-11-19T10:60' }, /real date and time/],
    [{ at: '2026-02-30T10:00+0100' }, /real date and time/],
    [{ at: '2026-02-29T10:00' }, /real date and time/],
  ];
  for (const [args, why] of bad) assert.throws(() => callbackWhen(args, now, 'UTC'), why, JSON.stringify(args));
});

// ---------- standing calls ----------

// A bot gave an offset that does not exist: Date.parse gave NaN, which passed every check, rang at once and told the
// bot "rings Shashank at Invalid Date".
test('a call back at an impossible offset is refused, and a time that is not a number never rings', () => {
  for (const at of ['2026-11-20T15:30+24:00', '2026-11-20T15:30-9959']) {
    assert.throws(() => callbackWhen({ at }, WED_1300, 'UTC'), (e: unknown) => e instanceof IncomingError && /real date and time/.test((e as Error).message), at);
  }
  const h = harness();
  h.inc.start();
  for (const at of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => h.inc.addCallback('a', 'Bot A', 'Check in', { at, waitsFor: [] }), /in the future and within 7 days/);
  }
  assert.deepEqual(h.inc.state().callbacks, []);
  assert.equal(h.inc.state().ringing, null);
});

test('a standing call rings at its time, is missed if nobody answers, and rings again next week', () => {
  const h = harness();
  h.inc.start();
  const s = h.inc.saveSchedule(weekly(), KNOWN);
  assert.equal(h.inc.state().schedules[0].nextAt, Date.parse('2026-11-18T13:05:00Z'));
  h.advance(4 * MIN);
  assert.equal(h.inc.state().ringing, null);
  h.advance(MIN);
  const ring = h.inc.state().ringing!;
  assert.deepEqual([ring.source, ring.title, ring.botIds, ring.agenda, ring.scheduleId, ring.until], ['schedule', 'Standup', ['a', 'b'], 'Yesterday, today, blockers', s.id, h.now + RING_SECONDS.default * 1000]);
  assert.match(ring.reason, /^Standing call\. Agenda: Yesterday/);
  h.advance(RING_SECONDS.default * 1000);
  assert.equal(h.inc.state().ringing, null);
  assert.deepEqual(h.inc.state().missed.map((r) => [r.id, r.note]), [[ring.id, 'Nobody answered.']]);
  assert.equal(h.inc.state().schedules[0].nextAt, Date.parse('2026-11-25T13:05:00Z'));
  h.advance(7 * 86_400_000 - RING_SECONDS.default * 1000);
  assert.equal(h.inc.state().ringing!.scheduleId, s.id);
  // Saved to disk, readable only by you.
  const file = path.join(h.dir, INCOMING_FILE);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schedules[0].title, 'Standup');
  assert.ok(h.changes > 0);
});

test('a standing call without an agenda says so; checks happen at least every CHECK_MS', () => {
  const h = harness();
  h.inc.start();
  assert.deepEqual(h.pending().map((t) => t.at - h.now), [CHECK_MS]);
  h.inc.saveSchedule(weekly({ agenda: '' }), KNOWN);
  h.advance(5 * MIN);
  assert.equal(h.inc.state().ringing!.reason, 'Standing call.');
});

test('a standing call due while the app was closed rings if recent, else is listed as missed', () => {
  const dir = newDir();
  const first = harness(dir);
  first.inc.start();
  first.inc.saveSchedule(weekly({ time: '13:10' }), KNOWN);
  first.inc.stop();
  first.inc.stop(); // twice is fine
  // Opened again 5 minutes after it was due: it rings.
  const recent = harness(dir, Date.parse('2026-11-18T13:15:00Z'));
  recent.inc.start();
  assert.equal(recent.inc.state().ringing!.title, 'Standup');
  recent.inc.stop();
  // Opened again an hour after: missed, with why.
  const dir2 = newDir();
  const a = harness(dir2);
  a.inc.start();
  a.inc.saveSchedule(weekly({ time: '13:10' }), KNOWN);
  a.inc.stop();
  const late = harness(dir2, Date.parse('2026-11-18T13:10:00Z') + LATE_GRACE_MS + 1);
  late.inc.start();
  assert.equal(late.inc.state().ringing, null);
  assert.match(late.inc.state().missed[0].note, /due while Alotbot was closed or the Mac was asleep/);
  // A stopped manager does nothing on tick.
  late.inc.stop();
  late.jump(7 * 86_400_000);
  late.inc.tick();
  assert.equal(late.inc.state().missed.length, 1);
});

test('the clock going back a little never rings a standing call twice; a big correction starts counting again', () => {
  const h = harness();
  h.inc.start();
  h.inc.saveSchedule(weekly(), KNOWN);
  h.advance(5 * MIN);
  h.inc.decline(h.inc.state().ringing!.id);
  h.jump(-10 * MIN);
  h.inc.tick();
  h.jump(10 * MIN);
  h.inc.tick();
  assert.equal(h.inc.state().ringing, null);
  // The clock had been days ahead and is put right: calls ring again at their times.
  const d = newDir();
  const ahead = harness(d, Date.parse('2026-11-28T13:00:00Z'));
  ahead.inc.start();
  ahead.inc.saveSchedule(weekly(), KNOWN);
  ahead.jump(Date.parse('2026-11-18T13:00:00Z') - ahead.now);
  ahead.inc.tick();
  ahead.advance(5 * MIN);
  assert.equal(ahead.inc.state().ringing!.title, 'Standup');
});

test('standing calls ring through quiet hours, but are missed during do-not-disturb', () => {
  const h = harness(newDir(), Date.parse('2026-11-18T22:30:00Z'));
  h.inc.start();
  h.inc.saveSchedule(weekly({ time: '22:35' }), KNOWN);
  h.advance(5 * MIN);
  assert.ok(h.inc.state().ringing, 'quiet hours do not stop a time you chose');
  assert.equal(h.inc.state().quietUntil, Date.parse('2026-11-19T08:00:00Z'));
  h.inc.decline(h.inc.state().ringing!.id);
  h.inc.setSettings({ doNotDisturbUntil: h.now + 86_400_000 });
  h.inc.saveSchedule(weekly({ title: 'Daily', days: [0, 1, 2, 3, 4, 5, 6], time: '22:40' }), KNOWN);
  h.advance(5 * MIN);
  assert.equal(h.inc.state().ringing, null);
  assert.deepEqual([h.inc.state().missed[0].title, h.inc.state().missed[0].note], ['Daily', 'Do not disturb was on.']);
});

// Local run of 2026-11-19: with do not disturb on until 08:00, three presses of Ring now rang at once.
test('Ring now waits for do-not-disturb and rings the moment it is turned off; quiet hours do not stop it', () => {
  const h = harness(newDir(), Date.parse('2026-11-18T22:30:00Z'));
  h.inc.start();
  const s = h.inc.saveSchedule(weekly(), KNOWN);
  assert.ok(h.inc.state().quietUntil, 'in quiet hours');
  h.inc.setSettings({ doNotDisturbUntil: h.now + 8 * 60 * MIN });
  const ring = h.inc.ringNow(s.id);
  assert.equal(h.inc.state().ringing, null);
  assert.deepEqual(h.inc.state().held.map((r) => [r.id, r.note]), [[ring.id, 'Do not disturb was on.']]);
  h.advance(MIN);
  assert.equal(h.inc.state().ringing, null, 'still held');
  // Pressing it again while it waits (14 presses on 2026-11-19 rang 14 times in a row) gives the same ring.
  for (let i = 0; i < 3; i++) assert.equal(h.inc.ringNow(s.id).id, ring.id);
  assert.equal(h.inc.state().held.length, 1);
  h.inc.setSettings({ doNotDisturbUntil: null });
  assert.equal(h.inc.state().ringing!.id, ring.id, 'rings straight away, through quiet hours');
  assert.deepEqual(h.inc.state().held, []);
  assert.equal(h.inc.ringNow(s.id).id, ring.id, 'and while it rings');
  assert.deepEqual(h.inc.state().held, []);
  h.inc.decline(ring.id);
  assert.equal(h.inc.state().ringing, null, 'one decline is enough');
  assert.deepEqual(h.inc.state().held, []);
  const other = h.inc.saveSchedule(weekly({ title: 'Other' }), KNOWN);
  assert.notEqual(h.inc.ringNow(other.id).id, ring.id, 'a different standing call is its own ring');
});

test('Ring now just before its time does not ring the same standing call twice', () => {
  const h = harness();
  h.inc.start();
  const s = h.inc.saveSchedule(weekly(), KNOWN); // 13:05
  h.advance(4 * MIN + 40_000);
  const ring = h.inc.ringNow(s.id);
  h.advance(30_000);
  assert.equal(h.inc.state().ringing!.id, ring.id);
  assert.deepEqual(h.inc.state().held, [], 'its time came while it rang: no second ring waits');
  h.inc.answer(ring.id);
  assert.equal(h.inc.state().ringing, null);
  assert.deepEqual(h.inc.state().held, []);
  assert.equal(h.inc.state().schedules[0].nextAt, Date.parse('2026-11-25T13:05:00Z'));
});

test('in a call nothing rings: rings wait, ring when the call ends, and are missed after an hour', () => {
  const h = harness();
  h.inc.start();
  h.inc.saveSchedule(weekly(), KNOWN);
  h.busy = true;
  h.advance(5 * MIN);
  assert.equal(h.inc.state().ringing, null);
  assert.deepEqual(h.inc.state().held.map((r) => r.note), ['You were in a call.']);
  h.inc.freed(); // still busy: nothing
  assert.equal(h.inc.state().held.length, 1);
  h.busy = false;
  const before = h.changes;
  h.inc.freed();
  assert.equal(h.inc.state().ringing!.title, 'Standup');
  assert.ok(h.changes > before);
  h.inc.decline(h.inc.state().ringing!.id);
  h.inc.freed(); // nothing waiting: no change
  // Held more than an hour: missed when next looked at.
  h.busy = true;
  h.inc.saveSchedule(weekly({ title: 'Later', time: '13:20' }), KNOWN);
  h.advance(15 * MIN);
  h.advance(HELD_MAX_MS + MIN);
  h.busy = false;
  h.inc.freed();
  assert.equal(h.inc.state().ringing, null);
  assert.equal(h.inc.state().missed[0].note, 'You were in a call. It waited too long to ring.');
});

test('a ring that is sounding when you start a call yourself waits, and rings when the call ends', () => {
  const h = harness();
  h.inc.start();
  const s = h.inc.saveSchedule(weekly(), KNOWN);
  const ring = h.inc.ringNow(s.id);
  h.inc.callStarted();
  h.busy = true;
  assert.equal(h.inc.state().ringing, null);
  assert.deepEqual(h.inc.state().held.map((r) => [r.id, r.note, r.until]), [[ring.id, 'You were in a call.', null]]);
  h.advance(RING_SECONDS.default * 1000 + 1);
  assert.deepEqual(h.inc.state().missed, [], 'its ring timer stopped');
  h.busy = false;
  h.inc.freed();
  assert.equal(h.inc.state().ringing!.id, ring.id);
  const before = h.changes;
  h.inc.decline(ring.id);
  h.inc.callStarted();
  assert.equal(h.changes, before + 1, 'nothing ringing: nothing to save');
});

test('two calls at once: the second waits for the first to end', () => {
  const h = harness();
  h.inc.start();
  h.inc.saveSchedule(weekly({ title: 'One' }), KNOWN);
  h.inc.saveSchedule(weekly({ title: 'Two' }), KNOWN);
  h.advance(5 * MIN);
  assert.equal(h.inc.state().ringing!.title, 'One');
  assert.deepEqual(h.inc.state().held.map((r) => [r.title, r.note]), [['Two', 'Another call was ringing.']]);
  h.inc.decline(h.inc.state().ringing!.id);
  assert.equal(h.inc.state().ringing!.title, 'Two');
  // The first ring's timer was cleared: the second rings its full time.
  h.advance(RING_SECONDS.default * 1000 - 1);
  assert.equal(h.inc.state().ringing!.title, 'Two');
});

test('editing, deleting, ringing now, and the limits on standing calls', () => {
  const h = harness();
  h.inc.start();
  const s = h.inc.saveSchedule(weekly({ time: '12:00' }), KNOWN);
  const edited = h.inc.saveSchedule({ ...weekly({ title: 'Renamed', time: '12:30' }), id: s.id }, KNOWN);
  assert.equal(edited.id, s.id);
  assert.equal(edited.createdAt, s.createdAt);
  assert.equal(h.inc.state().schedules.length, 1);
  assert.equal(h.inc.state().ringing, null, 'moving a call to a time already past today does not ring it now');
  assert.throws(() => h.inc.saveSchedule({ ...weekly(), id: 'gone' }, KNOWN), /no longer there/);
  assert.throws(() => h.inc.deleteSchedule('gone'), /no longer there/);
  assert.throws(() => h.inc.ringNow('gone'), /no longer there/);
  h.busy = true;
  assert.throws(() => h.inc.ringNow(s.id), /Leave the current call first/);
  h.busy = false;
  const now = h.inc.ringNow(s.id);
  assert.equal(h.inc.state().ringing!.id, now.id);
  assert.match(now.reason, /^Standing call\. Agenda:/);
  h.inc.decline(now.id);
  const bare = h.inc.saveSchedule(weekly({ agenda: '' }), KNOWN);
  assert.equal(h.inc.ringNow(bare.id).reason, 'Standing call.');
  h.inc.deleteSchedule(bare.id);
  h.inc.deleteSchedule(s.id);
  assert.deepEqual(h.inc.state().schedules, []);
  for (let i = 0; i < SCHEDULES_MAX; i++) h.inc.saveSchedule(weekly({ title: `S${i}` }), KNOWN);
  assert.throws(() => h.inc.saveSchedule(weekly(), KNOWN), /at most 20 standing calls/);
});

test('bots that left the account are taken out of standing calls and callbacks', () => {
  const h = harness();
  h.inc.start();
  const ab = h.inc.saveSchedule(weekly({ botIds: ['a', 'b'] }), KNOWN);
  const b = h.inc.saveSchedule(weekly({ botIds: ['b'] }), KNOWN);
  h.inc.addCallback('b', 'Bot B', 'Check in', { at: h.now + MIN, waitsFor: [] });
  h.inc.addCallback('a', 'Bot A', 'Check in', { at: h.now + MIN, waitsFor: [] });
  const before = h.changes;
  h.inc.forgetBots(new Set(['a', 'b']));
  assert.equal(h.changes, before, 'nothing gone: nothing saved');
  h.inc.forgetBots(new Set(['a']));
  const st = h.inc.state();
  assert.deepEqual(st.schedules.find((x) => x.id === ab.id)!.botIds, ['a']);
  const bOnly = st.schedules.find((x) => x.id === b.id)!;
  assert.deepEqual([bOnly.botIds, bOnly.enabled, bOnly.nextAt], [[], false, null]);
  assert.deepEqual(st.callbacks.map((c) => c.botId), ['a']);
});

test('a standing call paused because its bots left is still there after a restart', () => {
  const h = harness();
  h.inc.start();
  const b = h.inc.saveSchedule(weekly({ botIds: ['b'] }), KNOWN);
  h.inc.forgetBots(new Set(['a']));
  h.inc.stop();
  const again = h.make().state().schedules;
  assert.deepEqual(again.map((x) => [x.id, x.botIds, x.enabled, x.nextAt]), [[b.id, [], false, null]]);
  // Only a paused one may have no bots.
  assert.deepEqual(parseSaved({ schedules: [{ ...weekly({ botIds: [] }), id: 's', createdAt: 1 }] }, 'UTC', WED_1300).schedules, []);
});

// ---------- answering ----------

test('answer, decline, call back a missed one, and snooze', () => {
  const h = harness();
  h.inc.start();
  h.inc.saveSchedule(weekly(), KNOWN);
  h.advance(5 * MIN);
  const ring = h.inc.state().ringing!;
  assert.equal(h.inc.answer(ring.id).state, 'answered');
  assert.equal(h.inc.state().ringing, null);
  assert.throws(() => h.inc.answer(ring.id), /already answered/);
  assert.throws(() => h.inc.decline('nope'), /no longer there/);
  assert.equal(h.inc.ring('nope'), null);
  // The join failed: back to missed, so it can be called back.
  h.inc.answerFailed(ring.id, 'Voice setup failed');
  assert.equal(h.inc.ring(ring.id)!.note, 'Answering failed: Voice setup failed');
  h.inc.answerFailed(ring.id, 'again'); // not answered now: nothing
  h.inc.answerFailed('nope', 'x');
  assert.equal(h.inc.ring(ring.id)!.state, 'missed');
  assert.equal(h.inc.answer(ring.id).state, 'answered', 'calling back a missed call');
  // Snooze: rings again after the minutes.
  const again = h.inc.ringNow(h.inc.state().schedules[0].id);
  assert.throws(() => h.inc.snooze(again.id, 7), /minutes must be one of 5, 10, 15, 30, 60/);
  h.inc.snooze(again.id, 10);
  assert.equal(h.inc.ring(again.id)!.note, 'Snoozed for 10 min.');
  assert.deepEqual(h.inc.state().snoozed.map((r) => r.title), ['Standup']);
  h.advance(10 * MIN);
  const back = h.inc.state().ringing!;
  assert.deepEqual([back.source, back.title, back.reason], ['schedule', 'Standup', again.reason]);
  h.inc.clearMissed();
  assert.deepEqual(h.inc.state().missed, []);
  assert.equal(h.inc.state().ringing!.id, back.id, 'clearing missed calls keeps one that is ringing');
});

// "Later" turned a standing call into a call back from its first bot: no agenda, no other bots, a new title, held by
// quiet hours, and the bot told it was a promised call back.
test('Later rings the same call again: same bots, agenda and title, through quiet hours, after a restart, and can be cancelled', () => {
  const h = harness(newDir(), Date.parse('2026-11-18T22:30:00Z'));
  h.inc.start();
  const s = h.inc.saveSchedule(weekly(), KNOWN);
  const first = h.inc.ringNow(s.id);
  assert.equal(h.inc.state().ringing!.id, first.id, 'in quiet hours');
  h.inc.snooze(first.id, 5);
  const [snoozed] = h.inc.state().snoozed;
  assert.equal(snoozed.at, h.now + 5 * MIN);
  assert.deepEqual(h.inc.state().callbacks, []);
  assert.deepEqual(h.inc.state().held, []);
  assert.equal(h.inc.ringNow(s.id).id, snoozed.id, 'Ring now rings the snoozed one, not a second copy');
  assert.equal(h.inc.state().ringing!.id, snoozed.id);
  assert.deepEqual(h.inc.state().snoozed, []);
  h.inc.snooze(snoozed.id, 10);
  // Closed and opened again before it rings: it still rings at its time.
  h.inc.stop();
  const h2 = harness(h.dir, h.now);
  h2.inc.start();
  assert.equal(h2.inc.state().snoozed.length, 1);
  h2.advance(10 * MIN - 1);
  assert.equal(h2.inc.state().ringing, null);
  h2.advance(1);
  const again = h2.inc.state().ringing!;
  assert.deepEqual(
    [again.source, again.title, again.reason, again.botIds, again.agenda, again.scheduleId, again.createdAt],
    ['schedule', 'Standup', first.reason, ['a', 'b'], 'Yesterday, today, blockers', s.id, h2.now],
  );
  assert.deepEqual(h2.inc.state().snoozed, []);
  // Cancelled from Settings (Don't ring) before it rings.
  h2.inc.snooze(again.id, 15);
  const waiting = h2.inc.state().snoozed[0];
  h2.inc.decline(waiting.id);
  assert.deepEqual(h2.inc.state().snoozed, []);
  h2.advance(20 * MIN);
  assert.equal(h2.inc.state().ringing, null);
  h2.inc.clearMissed();
  // A bot's job ring snoozed keeps its own words; it waits for quiet hours like any job ring.
  h2.inc.seed([view()]);
  h2.inc.observe([view({ status: 'completed', summary: 'Draft ready' })], null);
  const job = h2.inc.state().held[0];
  assert.equal(job.title, 'Bot A has results');
  h2.inc.setSettings({ quietHours: { enabled: false } });
  h2.inc.snooze(h2.inc.state().ringing!.id, 5);
  h2.inc.setSettings({ quietHours: { enabled: true } });
  h2.advance(5 * MIN);
  assert.deepEqual(h2.inc.state().held.map((r) => [r.source, r.title, r.reason, r.note]), [['job', 'Bot A has results', 'Draft ready', 'It was during your quiet hours.']]);
  // Due long ago while the app was closed: missed, not rung.
  h2.inc.decline(h2.inc.state().held[0].id);
  h2.inc.ringNow(s.id);
  h2.inc.snooze(h2.inc.state().ringing!.id, 5);
  h2.inc.stop();
  const h3 = harness(h.dir, h2.now + 5 * MIN + HELD_MAX_MS + 1);
  h3.inc.start();
  assert.equal(h3.inc.state().ringing, null);
  assert.equal(h3.inc.state().missed[0].note, 'It was due while Alotbot was closed or the Mac was asleep.');
});

test('only the newest finished rings are kept', () => {
  const h = harness();
  h.inc.start();
  const s = h.inc.saveSchedule(weekly(), KNOWN);
  for (let i = 0; i < MISSED_KEPT + 3; i++) h.inc.decline(h.inc.ringNow(s.id).id);
  assert.equal(h.inc.state().missed.length, 0);
  const all = JSON.parse(fs.readFileSync(path.join(h.dir, INCOMING_FILE), 'utf8')).rings;
  assert.equal(all.length, MISSED_KEPT);
});

// ---------- callbacks ----------

test('a bot\'s callback rings at its time; overdue ones while the app was closed are missed', () => {
  const dir = newDir();
  const h = harness(dir);
  h.inc.start();
  const c = h.inc.addCallback('a', 'Bot A', '  Share   the draft ', { at: h.now + 20 * MIN, waitsFor: [] });
  assert.equal(c.reason, 'Share the draft');
  assert.equal(h.inc.state().callbacks.length, 1);
  h.advance(20 * MIN);
  const r = h.inc.state().ringing!;
  assert.deepEqual([r.source, r.title, r.reason, r.botIds], ['callback', 'Bot A is calling back', 'Share the draft', ['a']]);
  assert.deepEqual(h.inc.state().callbacks, []);
  h.inc.answer(r.id);
  h.inc.addCallback('a', 'Bot A', 'Old one', { at: h.now + MIN, waitsFor: [] });
  h.inc.stop();
  const later = harness(dir, h.now + MIN + HELD_MAX_MS + 1);
  later.inc.start();
  assert.equal(later.inc.state().ringing, null);
  assert.match(later.inc.state().missed[0].note, /due while Alotbot was closed/);
});

test('callbacks refuse what they cannot do, and can be cancelled', () => {
  const h = harness();
  h.inc.start();
  const at = (ms: number) => ({ at: h.now + ms, waitsFor: [] as string[] });
  assert.throws(() => h.inc.addCallback('a', 'Bot A', ' ', at(MIN)), /Give reason/);
  assert.throws(() => h.inc.addCallback('a', 'Bot A', 'r', at(0)), /in the future and within 7 days/);
  assert.throws(() => h.inc.addCallback('a', 'Bot A', 'r', at(CALLBACK_MAX_MS + 1)), /within 7 days/);
  assert.throws(() => h.inc.addCallback('a', 'Bot A', 'r', { at: null, waitsFor: [] }), /no job under way/);
  for (let i = 0; i < CALLBACKS_PER_BOT; i++) h.inc.addCallback('a', 'Bot A', `r${i}`, at(MIN * (i + 1)));
  assert.throws(() => h.inc.addCallback('a', 'Bot A', 'r', at(MIN)), /already have 5 callbacks waiting/);
  h.inc.addCallback('b', 'Bot B', 'r', at(MIN)); // another bot has its own limit
  const first = h.inc.state().callbacks[0];
  h.inc.cancelCallback(first.id);
  assert.throws(() => h.inc.cancelCallback(first.id), /no longer there/);
  h.inc.setSettings({ botCallbacks: false });
  assert.throws(() => h.inc.addCallback('c', 'Bot C', 'r', at(MIN)), /turned off bot callbacks/);
});

test('callbacks and bot rings wait for quiet hours and do-not-disturb to end; changing settings frees them', () => {
  const h = harness(newDir(), Date.parse('2026-11-18T21:50:00Z'));
  h.inc.start();
  h.inc.addCallback('a', 'Bot A', 'Late check', { at: h.now + 20 * MIN, waitsFor: [] });
  h.advance(20 * MIN);
  assert.equal(h.inc.state().ringing, null);
  assert.deepEqual(h.inc.state().held.map((r) => r.note), ['It was during your quiet hours.']);
  h.inc.setSettings({ quietHours: { enabled: false } });
  assert.equal(h.inc.state().ringing!.reason, 'Late check');
  h.inc.decline(h.inc.state().ringing!.id);
  h.inc.setSettings({ doNotDisturbUntil: h.now + 30 * MIN });
  h.inc.addCallback('a', 'Bot A', 'During DND', { at: h.now + MIN, waitsFor: [] });
  h.advance(MIN);
  assert.equal(h.inc.state().held[0].note, 'Do not disturb was on.');
  h.advance(29 * MIN - 1);
  assert.equal(h.inc.state().ringing, null);
  h.advance(1); // it rings the moment do-not-disturb ends
  assert.equal(h.inc.state().ringing!.reason, 'During DND');
  assert.equal(h.inc.state().ringing!.until, h.now + RING_SECONDS.default * 1000);
  h.inc.decline(h.inc.state().ringing!.id);
  // Quiet hours back on: a held ring rings the moment they end.
  h.inc.setSettings({ quietHours: { enabled: true } });
  h.inc.addCallback('a', 'Bot A', 'Morning', { at: h.now + MIN, waitsFor: [] });
  h.advance(MIN);
  assert.equal(h.inc.state().held[0].note, 'It was during your quiet hours.');
  h.jump(Date.parse('2026-11-19T07:30:00Z') - h.now); // the Mac slept; the held ring is now too old
  h.advance(30 * MIN);
  assert.equal(h.inc.state().ringing, null);
  assert.match(h.inc.state().missed[0].note, /quiet hours\. It waited too long/);
});

// ---------- bot work after a call ----------

test('a job from an ended call that finishes rings its bot; a live call\'s, a workspace\'s and app actions do not', () => {
  const h = harness();
  h.inc.start();
  h.inc.seed([view({ id: 'old', status: 'running' })]);
  h.inc.observe([view({ id: 'old', status: 'running' })], null);
  assert.equal(h.inc.state().ringing, null, 'no change: nothing');
  h.inc.observe([view({ id: 'old', status: 'completed', summary: 'Posted the thread.' })], null);
  const r = h.inc.state().ringing!;
  assert.deepEqual([r.source, r.title, r.reason, r.botIds], ['job', 'Bot A has results', 'Posted the thread.', ['a']]);
  h.inc.decline(r.id);
  // While its call is live, its news reaches the call.
  h.inc.observe([view({ id: 'live', callId: 'call-2-a' })], 'call-2');
  h.inc.observe([view({ id: 'live', callId: 'call-2-a', status: 'completed' })], 'call-2');
  for (const other of [view({ id: 'ws', callId: 'workspace' }), view({ id: 'app', target: 'app' })]) {
    h.inc.observe([other], null);
    h.inc.observe([{ ...other, status: 'completed' }], null);
  }
  // First seen already finished (it finished before the app watched it): no ring.
  h.inc.observe([view({ id: 'new', botId: 'b', status: 'completed' })], null);
  assert.equal(h.inc.state().ringing, null);
  assert.deepEqual(h.inc.state().held, []);
});

test('job results: failures say why; one ring per bot gathers its news; approvals take over the ring', () => {
  const h = harness();
  h.inc.start();
  h.busy = true; // rings wait, so news can gather
  h.inc.seed([view({ id: 'j1' }), view({ id: 'j2' }), view({ id: 'j3' }), view({ id: 'j4', botId: 'b' })]);
  h.inc.observe([view({ id: 'j1', status: 'failed', error: 'site was down' })], null);
  h.inc.observe([view({ id: 'j2', status: 'unknown' })], null);
  h.inc.observe([view({ id: 'j3', status: 'completed' })], null);
  h.inc.observe([view({ id: 'j5', status: 'waiting_approval', approvalSummary: 'Send the email to Sam' })], null);
  h.inc.observe([view({ id: 'j4', botId: 'b', botName: 'Bot B', status: 'waiting_approval' })], null);
  const [a, b] = h.inc.state().held;
  assert.deepEqual([a.source, a.title], ['approval', 'Bot A needs your OK']);
  assert.equal(a.reason, 'The job did not finish: site was down. Also: The job did not finish: unknown. Also: The job finished. Also: Send the email to Sam');
  assert.deepEqual([b.source, b.botIds, b.reason], ['approval', ['b'], 'Work is waiting for your approval.']);
});

test('settings can turn off job and approval rings; declining a bot quiets it for a while', () => {
  const h = harness();
  h.inc.start();
  h.inc.seed([view({ id: 'x' })]);
  h.inc.setSettings({ jobResults: false, approvals: false });
  h.inc.observe([view({ id: 'x', status: 'completed' }), view({ id: 'y', status: 'waiting_approval' })], null);
  assert.equal(h.inc.state().ringing, null);
  h.inc.setSettings({ jobResults: true, approvals: true });
  h.inc.observe([view({ id: 'z', status: 'waiting_approval' })], null);
  h.inc.decline(h.inc.state().ringing!.id);
  h.inc.observe([view({ id: 'w', status: 'waiting_approval' })], null);
  assert.equal(h.inc.state().ringing, null);
  assert.equal(h.inc.state().missed[0].note, 'You declined this bot\'s last call, so it did not ring.');
  // Another bot still rings, and the cooldown ends.
  h.inc.observe([view({ id: 'v', botId: 'b', status: 'waiting_approval' })], null);
  assert.equal(h.inc.state().ringing!.botIds[0], 'b');
  h.inc.decline(h.inc.state().ringing!.id);
  h.jump(DECLINE_COOLDOWN_MS + 1);
  h.inc.observe([view({ id: 'u', status: 'waiting_approval' })], null);
  assert.equal(h.inc.state().ringing!.botIds[0], 'a');
});

test('a callback waiting on jobs rings once all of them finished, with their results, instead of a job ring', () => {
  const h = harness();
  h.inc.start();
  h.inc.seed([view({ id: 'j1' }), view({ id: 'j2' }), view({ id: 'j3' })]);
  h.inc.addCallback('a', 'Bot A', 'Tell you about the posts', { at: null, waitsFor: ['j1', 'j2', 'j1'] });
  assert.deepEqual(h.inc.state().callbacks[0].waitsFor, ['j1', 'j2']);
  h.inc.addCallback('a', 'Bot A', 'Only j3', { at: null, waitsFor: ['j3'] });
  h.inc.addCallback('a', 'Bot A', 'A timed one is left alone', { at: h.now + 60 * MIN, waitsFor: [] });
  // Another bot's update doesn't have these jobs: nothing yet.
  h.inc.observe([view({ id: 'other', botId: 'b' })], null);
  h.inc.observe([view({ id: 'j1', status: 'completed', summary: 'Posted 3' }), view({ id: 'j2' })], null);
  assert.equal(h.inc.state().ringing, null, 'j2 is still running');
  h.inc.observe([view({ id: 'j1', status: 'completed', summary: 'Posted 3' }), view({ id: 'j2', status: 'failed', error: 'rate limit' })], null);
  const r = h.inc.state().ringing!;
  assert.deepEqual([r.source, r.reason], ['callback', 'Tell you about the posts Result: Posted 3; did not finish (rate limit)']);
  h.inc.decline(r.id);
  h.inc.observe([view({ id: 'j3', status: 'unknown' })], null);
  assert.equal(h.inc.state().ringing!.reason, 'Only j3 Result: did not finish (unknown)');
  h.inc.decline(h.inc.state().ringing!.id);
  h.inc.addCallback('a', 'Bot A', 'Again', { at: null, waitsFor: ['j4'] });
  h.inc.seed([view({ id: 'j4' })]);
  h.inc.observe([view({ id: 'j4', status: 'completed' })], null);
  assert.equal(h.inc.state().ringing!.reason, 'Again Result: done');
});

test('a callback whose jobs finish while their call is still on is dropped: the bot tells the result on the call', () => {
  const h = harness();
  h.inc.start();
  h.inc.seed([view({ id: 'j1', callId: 'call-9-a' })]);
  h.inc.addCallback('a', 'Bot A', 'Results', { at: null, waitsFor: ['j1'] });
  h.inc.observe([view({ id: 'j1', callId: 'call-9-a', status: 'completed' })], 'call-9');
  assert.deepEqual(h.inc.state().callbacks, []);
  assert.equal(h.inc.state().ringing, null);
  assert.deepEqual(h.inc.state().held, []);
  // Live call, but a job from another call: it rings (held while the call is on).
  h.inc.seed([view({ id: 'j2', callId: 'call-8-a' })]);
  h.inc.addCallback('a', 'Bot A', 'Old job', { at: null, waitsFor: ['j2'] });
  h.busy = true;
  h.inc.observe([view({ id: 'j2', callId: 'call-8-a', status: 'completed' })], 'call-9');
  assert.equal(h.inc.state().held[0].reason, 'Old job Result: done');
});

test('the action memory stays bounded', () => {
  const h = harness();
  h.inc.seed(Array.from({ length: 2005 }, (_, i) => view({ id: `a${i}` })));
  // The oldest were forgotten: seen again as finished for the first time, they don't ring.
  h.inc.observe([view({ id: 'a0', status: 'completed' })], null);
  assert.equal(h.inc.state().ringing, null);
  h.inc.observe([view({ id: 'a2004', status: 'completed' })], null);
  assert.equal(h.inc.state().ringing!.source, 'job');
});

test('an unreadable saved file starts fresh', () => {
  const dir = newDir();
  fs.writeFileSync(path.join(dir, INCOMING_FILE), '{not json');
  const h = harness(dir);
  assert.deepEqual(h.inc.state().schedules, []);
  assert.equal(h.inc.settings.botCallbacks, true);
});
