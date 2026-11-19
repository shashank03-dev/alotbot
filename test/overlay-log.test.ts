import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CallLog, loggedSocket, MicStats } from '../src/overlay/log.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'alotbot-log-'));
const read = (log: CallLog) => fs.readFileSync(log.file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('a log is a private JSON-lines file per call; two calls in the same second get their own files', () => {
  const dir = tmp();
  let now = Date.UTC(2026, 10, 10, 14, 20, 0, 500);
  const a = new CallLog(dir, () => now);
  const b = new CallLog(dir, () => now);
  assert.equal(a.name, 'call-2026-11-10T14-20-00Z.jsonl');
  assert.equal(b.name, 'call-2026-11-10T14-20-00Z-2.jsonl');
  assert.equal(fs.statSync(path.join(dir, 'logs')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
  now += 1500;
  a.write('join', { bots: ['Bot A'] });
  a.write('end');
  assert.deepEqual(read(a), [
    { at: '2026-11-10T14:20:02.000Z', ms: 1500, kind: 'join', bots: ['Bot A'] },
    { at: '2026-11-10T14:20:02.000Z', ms: 1500, kind: 'end' },
  ]);
  a.close();
  a.close(); // twice is fine
  assert.equal(a.open, false);
  a.write('late');
  assert.equal(read(a).length, 2, 'nothing is written after close');
  b.close();
});

test('voice messages: audio and word-by-word text are left out; anything that is not JSON is kept, cut short', () => {
  const log = new CallLog(tmp());
  log.voice('out', 'Bot A', JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAAA' }));
  log.voice('in', 'Bot A', JSON.stringify({ type: 'response.output_audio.delta', delta: 'AAAA' }));
  log.voice('in', 'Bot A', JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'He' }));
  log.voice('in', 'Bot A', JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'Hello.' }));
  log.voice('in', 'Bot A', 'not json'.repeat(100));
  log.voice('in', 'Bot A', 'null');
  const e = read(log);
  assert.deepEqual(e.map((x) => x.msg?.type ?? x.raw?.length ?? x.msg), ['response.output_audio_transcript.done', 500, null]);
  log.close();
});

test('a write that fails (disk full, folder gone) closes the log instead of breaking the call', () => {
  const log = new CallLog(tmp());
  fs.closeSync((log as any).fd); // the file handle goes bad underneath it
  assert.doesNotThrow(() => log.write('event', { text: 'x' }));
  assert.equal(log.open, false);
  assert.doesNotThrow(() => log.close());
});

test('loggedSocket logs both directions, opens, closes and errors under the bot\'s name', () => {
  const log = new CallLog(tmp());
  const sent: string[] = [];
  let closedWith: unknown[] = [];
  const raw: any = { send: (d: string) => sent.push(d), close: (...a: unknown[]) => (closedWith = a), onopen: null, onmessage: null, onclose: null, onerror: null };
  const ws = loggedSocket(raw, 'Bot A', log);
  const got: string[] = [];
  ws.onopen = () => got.push('open');
  ws.onmessage = (m) => got.push(String(m.data));
  ws.onclose = (e) => got.push(`close ${e?.code}`);
  ws.onerror = () => got.push('error');
  raw.onopen();
  ws.send('{"type":"response.create"}');
  raw.onmessage({ data: '{"type":"response.done"}' });
  raw.onclose();
  raw.onclose({ code: 1000, reason: Buffer.from('bye') });
  raw.onerror();
  raw.onerror(new Error('reset'));
  ws.close(1000, 'left');
  // Handlers may be cleared; the socket still logs.
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  raw.onopen();
  raw.onmessage({ data: '{"type":"x"}' });
  raw.onclose();
  raw.onerror();
  assert.deepEqual(sent, ['{"type":"response.create"}']);
  assert.deepEqual(closedWith, [1000, 'left']);
  assert.deepEqual(got, ['open', '{"type":"response.done"}', 'close undefined', 'close 1000', 'error', 'error']);
  const e = read(log).map(({ kind, dir, bot, msg, code, reason, error }) => ({ kind, dir, bot, type: msg?.type, code, reason, error }));
  assert.deepEqual(e.slice(0, 9), [
    { kind: 'voice-connect', dir: undefined, bot: 'Bot A', type: undefined, code: undefined, reason: undefined, error: undefined },
    { kind: 'voice-open', dir: undefined, bot: 'Bot A', type: undefined, code: undefined, reason: undefined, error: undefined },
    { kind: 'voice', dir: 'out', bot: 'Bot A', type: 'response.create', code: undefined, reason: undefined, error: undefined },
    { kind: 'voice', dir: 'in', bot: 'Bot A', type: 'response.done', code: undefined, reason: undefined, error: undefined },
    { kind: 'voice-closed', dir: undefined, bot: 'Bot A', type: undefined, code: null, reason: null, error: undefined },
    { kind: 'voice-closed', dir: undefined, bot: 'Bot A', type: undefined, code: 1000, reason: 'bye', error: undefined },
    { kind: 'voice-error', dir: undefined, bot: 'Bot A', type: undefined, code: undefined, reason: undefined, error: null },
    { kind: 'voice-error', dir: undefined, bot: 'Bot A', type: undefined, code: undefined, reason: undefined, error: 'reset' },
    { kind: 'voice-close', dir: undefined, bot: 'Bot A', type: undefined, code: undefined, reason: undefined, error: undefined },
  ]);
  assert.equal(e.length, 13, 'cleared handlers still log');
  log.close();
});

test('MicStats sums up a second of mic frames, and says nothing for a second without any', () => {
  const m = new MicStats(0);
  assert.equal(m.take(2000), null, 'no frames');
  m.add(0.1);
  m.add(0.30004);
  assert.equal(m.take(999), null, 'not a second yet');
  assert.deepEqual(m.take(1000), { frames: 2, max: 0.3, avg: 0.2 });
  assert.equal(m.take(2500), null, 'reset after taking');
});
