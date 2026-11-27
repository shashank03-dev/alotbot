import assert from 'node:assert/strict';
import { test } from 'node:test';
import { USER } from '../public/core.js';
import { PHONE_CONFIRM_TOOL, PHONE_DETAILS_MAX, PHONE_EXPIRE_MS, PHONE_GOAL_MAX, PHONE_KEPT, PHONE_PENDING_MAX, PHONE_TOOL, PHONE_WHO_MAX, PhoneDesk, PhoneError, phoneNumber, phoneTask } from '../src/overlay/phone.ts';

const desk = () => {
  let now = 1000;
  let n = 0;
  const d = new PhoneDesk(() => now, () => `p${++n}`);
  return { d, at: (ms: number) => (now = ms) };
};

test('the phone tools ask for who and goal, and confirm takes an id and a decision', () => {
  assert.equal(PHONE_TOOL.name, 'call_someone');
  assert.deepEqual(PHONE_TOOL.parameters.required, ['who', 'goal']);
  assert.match(PHONE_TOOL.description, /Nothing is dialed until he approves/);
  assert.equal(PHONE_CONFIRM_TOOL.name, 'confirm_phone_call');
  assert.deepEqual(PHONE_CONFIRM_TOOL.parameters.required, ['id', 'decision']);
});

test('phone numbers: digits with an optional +, none when empty, junk and short or emergency numbers refused', () => {
  assert.equal(phoneNumber(undefined), null);
  assert.equal(phoneNumber('  '), null);
  assert.equal(phoneNumber(42), null);
  assert.equal(phoneNumber('+1 (415) 555-0134'), '+14155550134');
  assert.equal(phoneNumber('020 7946 0958'), '02079460958');
  assert.throws(() => phoneNumber('call mom'), (e: Error) => e instanceof PhoneError && /is not a phone number/.test(e.message));
  assert.throws(() => phoneNumber('911'), /emergency or short numbers/);
  assert.throws(() => phoneNumber('112'), /emergency or short numbers/);
  assert.throws(() => phoneNumber('1'.repeat(16)), /7 to 15 digits/);
});

test('a request is checked, kept pending, and the same one asked again is the same request', () => {
  const { d } = desk();
  assert.throws(() => d.propose('a', 'Bot A', { goal: 'x' }), /Give who/);
  assert.throws(() => d.propose('a', 'Bot A', { who: 'Mom' }), /Give goal/);
  assert.throws(() => d.propose('a', 'Bot A', { who: 'x'.repeat(PHONE_WHO_MAX + 1), goal: 'g' }), /who is too long/);
  assert.throws(() => d.propose('a', 'Bot A', { who: 'w', goal: 'x'.repeat(PHONE_GOAL_MAX + 1) }), /goal is too long/);
  assert.throws(() => d.propose('a', 'Bot A', { who: 'w', goal: 'g', details: 'x'.repeat(PHONE_DETAILS_MAX + 1) }), /details is too long/);
  assert.throws(() => d.propose('a', 'Bot A', { who: 'w', goal: 'g', number: '911' }), PhoneError);
  assert.equal(d.version, 0);
  const r = d.propose('a', 'Bot A', { who: '  Dr. Lee’s   office ', goal: 'Book a cleaning', number: '+1 415 555 0134', details: 'Tue or Wed mornings' });
  assert.deepEqual(r, { id: 'p1', botId: 'a', botName: 'Bot A', who: 'Dr. Lee’s office', number: '+14155550134', goal: 'Book a cleaning', details: 'Tue or Wed mornings', status: 'pending', createdAt: 1000, decidedAt: null, error: null });
  assert.equal(d.version, 1);
  assert.equal(d.propose('a', 'Bot A', { who: 'dr. lee’s office', goal: 'book a cleaning', number: '+14155550134' }), r);
  assert.equal(d.version, 1);
  assert.notEqual(d.propose('a', 'Bot A', { who: 'Dr. Lee’s office', goal: 'Book a cleaning' }).id, r.id, 'a different number is another request');
  // The list is a copy.
  d.requests()[0].status = 'denied';
  assert.equal(d.requests()[0].status, 'pending');
});

test('each bot may have a few requests waiting', () => {
  const { d } = desk();
  for (let i = 0; i < PHONE_PENDING_MAX; i++) d.propose('a', 'Bot A', { who: `P${i}`, goal: 'g' });
  assert.throws(() => d.propose('a', 'Bot A', { who: 'more', goal: 'g' }), new RegExp(`already have ${PHONE_PENDING_MAX} calls waiting for ${USER}`));
  assert.equal(d.propose('b', 'Bot B', { who: 'more', goal: 'g' }).botId, 'b');
});

test('decisions: approve or deny once; a bot can only decide its own; unknown ids are refused', () => {
  const { d, at } = desk();
  const r = d.propose('a', 'Bot A', { who: 'Mom', goal: 'Say happy birthday' });
  const s = d.propose('a', 'Bot A', { who: 'Shop', goal: 'Ask opening hours' });
  assert.throws(() => d.decide('nope', 'approve'), /There is no phone request "nope"\./);
  assert.throws(() => d.decide(r.id, 'approve', 'b'), /There is no phone request "p1" of yours\./);
  at(2000);
  assert.equal(d.decide(r.id, 'approve', 'a').status, 'approved');
  assert.equal(d.requests()[0].decidedAt, 2000);
  assert.throws(() => d.decide(r.id, 'deny'), /already approved/);
  assert.equal(d.decide(s.id, 'deny').status, 'denied');
  const v = d.version;
  d.failed(r.id, 'x'.repeat(600));
  assert.equal(d.requests()[0].status, 'failed');
  assert.equal(d.requests()[0].error!.length, 500);
  assert.equal(d.version, v + 1);
  d.failed('gone', 'no');
  assert.equal(d.version, v + 1);
});

test('unanswered requests expire, and the end of the call closes the rest', () => {
  const { d, at } = desk();
  const r = d.propose('a', 'Bot A', { who: 'Mom', goal: 'g' });
  at(1000 + PHONE_EXPIRE_MS - 1);
  assert.equal(d.requests()[0].status, 'pending');
  at(1000 + PHONE_EXPIRE_MS);
  assert.equal(d.requests()[0].status, 'expired');
  assert.throws(() => d.decide(r.id, 'approve'), /already expired/);
  const s = d.propose('a', 'Bot A', { who: 'Dad', goal: 'g' });
  d.decide(s.id, 'approve');
  d.propose('a', 'Bot A', { who: 'Gran', goal: 'g' });
  d.endAll();
  assert.deepEqual(d.requests().map((x) => x.status), ['expired', 'approved', 'expired']);
});

test('only the newest decided requests are kept; pending ones always stay', () => {
  const { d } = desk();
  for (let i = 0; i < PHONE_KEPT; i++) d.decide(d.propose('a', 'Bot A', { who: `P${i}`, goal: 'g' }).id, 'deny');
  d.propose('a', 'Bot A', { who: 'new', goal: 'g' });
  const list = d.requests();
  assert.equal(list.length, PHONE_KEPT);
  assert.equal(list[0].who, 'P1');
  assert.equal(list.at(-1)!.who, 'new');
  // All pending: nothing can be dropped.
  const { d: full } = desk();
  for (let i = 0; i < PHONE_KEPT + 1; i++) full.propose(`b${i}`, 'B', { who: 'w', goal: 'g' });
  assert.equal(full.requests().length, PHONE_KEPT + 1);
});

test('the agent is told who, why, what it may share, to say it is an AI, and to report back', () => {
  const { d } = desk();
  const withAll = phoneTask(d.propose('a', 'Bot A', { who: 'Dr. Lee', goal: 'Book a cleaning', number: '+14155550134', details: 'Tue mornings' }));
  assert.match(withAll, new RegExp(`^${USER} approved this phone call just now in Alotbot\\. Place it with your phone calling tool\\.`));
  assert.match(withAll, /Call: Dr\. Lee at \+14155550134\.\nGoal: Book a cleaning\nYou may share: Tue mornings\n/);
  assert.match(withAll, new RegExp(`AI assistant calling on behalf of ${USER}`));
  assert.match(withAll, /Don't pay/);
  assert.match(withAll, /report back/);
  const bare = phoneTask(d.propose('a', 'Bot A', { who: 'Pizza place', goal: 'Order a margherita' }));
  assert.match(bare, /Call: Pizza place\.\nNo number was given: find the right number/);
  assert.doesNotMatch(bare, /You may share/);
});

test('request ids are random by default', () => {
  const d = new PhoneDesk(() => 0);
  assert.match(d.propose('a', 'Bot A', { who: 'Mom', goal: 'g' }).id, /^[0-9a-f-]{36}$/);
});
