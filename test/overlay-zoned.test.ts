import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, clockMinutes, inWindow, localParts, nextWeekly, validZone, zoneOffset, zonedTime } from '../src/overlay/zoned.ts';

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

test('validZone accepts IANA names and UTC, and refuses anything else', () => {
  for (const z of ['UTC', 'Europe/London', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe']) assert.equal(validZone(z), true, z);
  for (const z of ['', 'Mars/Base', 'x'.repeat(65), 5, null, undefined, {}]) assert.equal(validZone(z), false, String(z));
});

test('localParts and zoneOffset read the wall clock of a zone', () => {
  const t = Date.parse('2026-11-18T10:00:00Z');
  assert.deepEqual(localParts(t, 'UTC'), { year: 2026, month: 11, day: 18, hour: 10, minute: 0, weekday: 3 });
  assert.deepEqual(localParts(t, 'Asia/Kolkata'), { year: 2026, month: 11, day: 18, hour: 15, minute: 30, weekday: 3 });
  assert.deepEqual(localParts(Date.parse('2026-11-19T04:59:00Z'), 'America/New_York'), { year: 2026, month: 11, day: 18, hour: 23, minute: 59, weekday: 3 });
  assert.equal(zoneOffset(t, 'Asia/Kolkata'), 5.5 * 3600_000);
  assert.equal(zoneOffset(t, 'America/New_York'), -5 * 3600_000);
  assert.equal(zoneOffset(t + 999, 'UTC'), 0, 'sub-second parts are ignored');
});

test('zonedTime: ordinary times, a time that happens twice, and a time that never happens', () => {
  assert.equal(iso(zonedTime(2026, 11, 18, 9, 0, 'Asia/Kolkata')), '2026-11-18T03:30:00.000Z');
  assert.equal(iso(zonedTime(2026, 7, 1, 9, 0, 'Europe/London')), '2026-07-01T08:00:00.000Z');
  // New York, clocks back on Nov 1 2026: 01:30 happens twice; the first (still daylight time) is used.
  assert.equal(iso(zonedTime(2026, 11, 1, 1, 30, 'America/New_York')), '2026-11-01T05:30:00.000Z');
  // Clocks forward on Mar 8 2026: 02:30 never happens; it moves forward by the gap, to 03:30.
  assert.equal(iso(zonedTime(2026, 3, 8, 2, 30, 'America/New_York')), '2026-03-08T07:30:00.000Z');
  // Lord Howe moves 30 minutes: 02:15 becomes 02:45.
  assert.equal(iso(zonedTime(2026, 10, 4, 2, 15, 'Australia/Lord_Howe')), '2026-10-03T15:45:00.000Z');
});

test('addDays crosses months, years and leap days', () => {
  assert.deepEqual(addDays(2026, 12, 31, 1), { year: 2027, month: 1, day: 1, weekday: 5 });
  assert.deepEqual(addDays(2028, 2, 28, 1), { year: 2028, month: 2, day: 29, weekday: 2 });
  assert.deepEqual(addDays(2026, 3, 1, -1), { year: 2026, month: 2, day: 28, weekday: 6 });
});

test('clockMinutes reads 24-hour HH:MM only', () => {
  assert.equal(clockMinutes('00:00'), 0);
  assert.equal(clockMinutes('09:30'), 570);
  assert.equal(clockMinutes('23:59'), 1439);
  for (const bad of ['24:00', '9:30', '12:60', '12:30pm', '', null, 930]) assert.equal(clockMinutes(bad), null, String(bad));
});

test('nextWeekly: later today, a later day, next week, and across a change of clocks', () => {
  const ny = 'America/New_York';
  // Wed Nov 18 2026, 08:00 in New York.
  const wed8 = Date.parse('2026-11-18T13:00:00Z');
  assert.equal(iso(nextWeekly(wed8, [3], 9 * 60, ny)), '2026-11-18T14:00:00.000Z', 'later today');
  assert.equal(iso(nextWeekly(wed8, [3], 7 * 60, ny)), '2026-11-25T12:00:00.000Z', 'today has passed: next week');
  assert.equal(iso(nextWeekly(wed8, [1, 5], 9 * 60, ny)), '2026-11-20T14:00:00.000Z', 'the next listed day');
  assert.equal(iso(nextWeekly(Date.parse('2026-11-18T14:00:00Z'), [3], 9 * 60, ny)), '2026-11-25T14:00:00.000Z', 'exactly now is not next');
  assert.equal(nextWeekly(wed8, [], 540, ny), null);
  // Sunday Oct 25 2026 09:00 in New York is daylight time; the next Sunday is standard time: same wall clock.
  assert.equal(iso(nextWeekly(Date.parse('2026-10-25T14:00:00Z'), [0], 9 * 60, ny)), '2026-11-01T14:00:00.000Z');
  assert.equal(iso(nextWeekly(Date.parse('2026-10-24T14:00:00Z'), [0], 9 * 60, ny)), '2026-10-25T13:00:00.000Z');
});

test('inWindow: a daytime window, one past midnight, and an empty one', () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 10, 18, h, m);
  assert.equal(inWindow(at(10), 9 * 60, 17 * 60, 'UTC'), true);
  assert.equal(inWindow(at(17), 9 * 60, 17 * 60, 'UTC'), false, 'the end is outside');
  assert.equal(inWindow(at(8, 59), 9 * 60, 17 * 60, 'UTC'), false);
  assert.equal(inWindow(at(23), 22 * 60, 8 * 60, 'UTC'), true);
  assert.equal(inWindow(at(3), 22 * 60, 8 * 60, 'UTC'), true);
  assert.equal(inWindow(at(12), 22 * 60, 8 * 60, 'UTC'), false);
  assert.equal(inWindow(at(12), 600, 600, 'UTC'), false);
});
