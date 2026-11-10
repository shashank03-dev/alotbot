import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BARGE_IN_LEVEL,
  Call,
  CORRECTION_WORDS,
  hasCorrection,
  heardPart,
  HOST,
  STUCK_SPEAKING_MS,
  tagOf,
  cleanTranscript,
  CONTEXT_LINES,
  contextText,
  findAddressee,
  floatTo16,
  fromBase64,
  groupInstructions,
  INVITE_TOOL,
  TOOLS,
  isNoiseOrEcho,
  matchBot,
  MIN_UPTIME_FOR_RETRY_MS,
  NEXT_TURN_LEAD_MS,
  normalize,
  pcm16ToFloat,
  Player,
  REPLY_GRACE_MS,
  resample,
  USER_ACTIVE_MS,
  rms,
  SAMPLE_RATE,
  toBase64,
  USER,
} from '../public/core.js';

// ---------- pure helpers ----------

test('normalize strips case, apostrophes and punctuation', () => {
  assert.equal(normalize("Hey, Shashank’s X-bot!"), 'hey shashanks x bot');
});

test('findAddressee: first named bot wins; longest name breaks ties', () => {
  const bots = [
    { id: 'a', name: 'My Bot' },
    { id: 'b', name: "Shashank's Bot" },
    { id: 'c', name: "Shashank's X bot" },
    { id: 'd', name: '!!!' },
  ];
  assert.equal(findAddressee("Shashank's X bot, what do you think?", bots), 'c');
  assert.equal(findAddressee("shashanks bot and my bot", bots), 'b');
  assert.equal(findAddressee('So, my bot, go ahead. Shashanks bot later', bots), 'a');
  assert.equal(findAddressee('nobody here', bots), null);
  assert.equal(findAddressee('mybot', bots), null);
  // same start position: the longer name is the better match
  assert.equal(findAddressee('alpha beta says hi', [{ id: 's', name: 'Alpha' }, { id: 'l', name: 'Alpha Beta' }]), 'l');
  assert.equal(findAddressee('alpha beta says hi', [{ id: 'l', name: 'Alpha Beta' }, { id: 's', name: 'Alpha' }]), 'l');
});

test('isNoiseOrEcho: empty speech and speaker echo are ignored, real speech is not', () => {
  assert.equal(isNoiseOrEcho('  ', ''), true);
  assert.equal(isNoiseOrEcho('ok', 'ok sure'), false); // too short to call echo
  assert.equal(isNoiseOrEcho('good to hear you what is on your mind', 'Hey Shashank, good to hear you. What is on your mind?'), true);
  assert.equal(isNoiseOrEcho('tell me about the weather today', 'Hey Shashank, good to hear you.'), false);
});

test('groupInstructions tells each bot who is in the call and how lines are tagged', () => {
  const text = groupInstructions('BASE', 'My Bot', ['My Bot', 'Other']);
  assert.ok(text.startsWith('BASE\n\n# Group call'));
  assert.match(text, /You are My Bot, in a live group voice call hosted by Shashank/);
  assert.match(text, /other Grok bots in the call: Other\./);
  assert.match(groupInstructions('B', 'Solo', ['Solo']), /No other bots are in the call right now/);
});

test('contextText lists the conversation', () => {
  assert.equal(contextText([{ who: 'A', text: 'hi' }, { who: 'B', text: 'yo' }]), 'Conversation so far in this call:\n[A]: hi\n[B]: yo');
});

test('audio helpers: resample, PCM16 round trip, base64, rms', () => {
  const same = new Float32Array([0.1, 0.2]);
  assert.equal(resample(same, 24000, 24000), same);
  const down = resample(new Float32Array([0, 1, 0, 1]), 48000, 24000);
  assert.deepEqual([...down], [0, 0]);
  const up = resample(new Float32Array([0, 1]), 24000, 48000);
  assert.deepEqual([...up], [0, 0.5, 1, 1]);
  const pcm = floatTo16(new Float32Array([-2, -1, 0, 0.5, 1, 2]));
  assert.deepEqual([...pcm], [-32768, -32768, 0, 16383, 32767, 32767]);
  assert.deepEqual([...fromBase64(toBase64(pcm))], [...pcm]);
  assert.deepEqual([...pcm16ToFloat(new Int16Array([-32768, 16384]))], [-1, 0.5]);
  assert.equal(fromBase64(btoa('abc')).length, 1); // odd byte dropped
  const big = new Int16Array(40000).fill(7); // more than one btoa chunk
  assert.deepEqual([...fromBase64(toBase64(big))].slice(-2), [7, 7]);
  assert.equal(rms(new Float32Array([])), 0);
  assert.equal(rms(new Float32Array([0.5, -0.5])), 0.5);
});

// ---------- fakes ----------

class FakeAudio {
  t = 0;
  played: { samples: Float32Array; when: number; stopped: boolean }[] = [];
  now() {
    return this.t;
  }
  play(samples: Float32Array, when: number) {
    const entry = { samples, when, stopped: false };
    this.played.push(entry);
    return { stop: () => (entry.stopped = true) };
  }
}

class FakeSocket {
  sent: any[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  protocols: string[];
  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.closed = true;
  }
  emit(type: string, extra: object = {}) {
    this.onmessage!({ data: JSON.stringify({ type, ...extra }) });
  }
  types() {
    return this.sent.map((m) => m.type);
  }
  said() {
    return this.sent.filter((m) => m.type === 'conversation.item.create').map((m) => m.item.content[0].text);
  }
}

const samples = (seconds: number) => new Float32Array(Math.round(seconds * SAMPLE_RATE)).fill(0.25);
const b64audio = (seconds: number) => toBase64(floatTo16(samples(seconds)));

function setup(opts: { mintFail?: (id: string) => Error | null } = {}) {
  const audio = new FakeAudio();
  const sockets = new Map<string, FakeSocket[]>();
  const timers: { fn: () => void; ms: number; id: number; done: boolean }[] = [];
  let clock = 0;
  let tid = 0;
  const mints: string[] = [];
  const call: any = new Call({
    mintVoice: async (id: string) => {
      mints.push(id);
      const err = opts.mintFail?.(id);
      if (err) throw err;
      return { clientSecret: `sec-${id}`, url: `wss://voice.test/${id}`, instructions: `I am ${id}.` };
    },
    openSocket: (url: string, protocols: string[]) => {
      const ws = new FakeSocket(url, protocols);
      const id = url.split('/').pop()!;
      sockets.set(id, [...(sockets.get(id) ?? []), ws]);
      return ws;
    },
    audio,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, id: ++tid, done: false };
      timers.push(t);
      return t.id;
    },
    clearTimer: (id: number) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.done = true;
    },
    now: () => clock,
  });
  const ws = (id: string) => sockets.get(id)!.at(-1)!;
  /** Wait for mint promises, then open the socket and confirm the session. */
  async function ready(id: string) {
    await flush();
    const s = ws(id);
    s.onopen!();
    s.emit('session.updated');
  }
  const runTimers = () => {
    for (const t of timers.filter((x) => !x.done)) {
      t.done = true;
      t.fn();
    }
  };
  return {
    call, audio, ws, ready, timers, runTimers, mints, sockets,
    setClock: (ms: number) => (clock = ms),
  };
}

const flush = () => new Promise((r) => setImmediate(r));
const bot = (id: string, extra: object = {}) => ({ id, name: `Bot ${id.toUpperCase()}`, voice: null, speed: 1, language: null, color: null, shape: null, ...extra });

/** A bot finishes speaking `text` with `seconds` of audio. */
function speak(s: FakeSocket, text: string, seconds = 1, item = `item-${Math.random()}`) {
  s.emit('response.created', { response: { id: 'r' } });
  s.emit('response.output_item.added', { item: { id: item } });
  s.emit('response.output_audio.delta', { delta: b64audio(seconds) });
  s.emit('response.output_audio_transcript.delta', { delta: text });
  s.emit('response.done', { response: { status: 'completed' } });
}

// ---------- Player ----------

test('Player queues voices back to back and reports what was heard when cut', () => {
  const audio = new FakeAudio();
  const p = new Player(audio);
  p.enqueue('a', 'i1', new Float32Array(0)); // empty: ignored
  assert.equal(p.speaking(), null);
  p.enqueue('a', 'i1', samples(1));
  p.enqueue('a', 'i1', samples(1));
  p.enqueue('b', 'i2', samples(1));
  assert.deepEqual(audio.played.map((x) => x.when), [0, 1, 2]);
  assert.equal(p.remainingMs(), 3000);
  audio.t = 1.5;
  assert.equal(p.speaking(), 'a');
  const cut = p.flush('a');
  assert.deepEqual([...cut], [['i1', { botId: 'a', ms: 1500 }]]);
  assert.equal(audio.played[1].stopped, true);
  assert.equal(audio.played[2].stopped, false);
  assert.equal(p.remainingMs(), 1500); // b still queued until t=3
  audio.t = 2.25;
  assert.equal(p.speaking(), 'b');
  assert.deepEqual([...p.flush()], [['i2', { botId: 'b', ms: 250 }]]);
  assert.equal(p.remainingMs(), 0);
  audio.t = 10;
  assert.deepEqual([...p.flush()], []);
});

// ---------- joining and the opening line ----------

test('join opens one voice session per chosen bot with its own voice and the group instructions', async () => {
  const { call, ws, ready, mints } = setup();
  call.join([bot('a', { voice: 'carina', speed: 1.2, language: 'en' }), bot('b')]);
  assert.throws(() => call.join([]), /already in a call/);
  await flush();
  assert.deepEqual(mints, ['a', 'b']);
  assert.deepEqual(ws('a').protocols, ['xai-client-secret.sec-a']);
  ws('a').onopen!();
  const update = ws('a').sent[0];
  assert.equal(update.type, 'session.update');
  assert.equal(update.session.voice, 'carina');
  assert.equal(update.session.audio.output.speed, 1.2);
  assert.equal(update.session.audio.input.transcription.language_hint, 'en');
  assert.deepEqual(update.session.turn_detection, { type: 'server_vad' });
  assert.match(update.session.instructions, /^I am a\.\n\n# Group call/);
  assert.match(update.session.instructions, /other Grok bots in the call: Bot B\./);
  ws('b').onopen!();
  assert.equal(ws('b').sent[0].session.voice, undefined, 'default voice when none is set');
  assert.equal(ws('b').sent[0].session.audio.input.transcription.language_hint, undefined);
  assert.deepEqual(call.view().bots.map((b: any) => b.status), ['connecting', 'connecting']);
  ws('a').emit('session.updated');
  ws('a').emit('session.updated'); // repeat is ignored
  // First bot ready opens the call and becomes the one hearing Shashank.
  assert.deepEqual(ws('a').said(), [`[Call]: ${USER} just joined. Open the call with one short spoken line.`]);
  assert.ok(ws('a').types().includes('response.create'));
  assert.equal(call.ear.bot.id, 'a');
  assert.equal(call.view().bots[0].status, 'thinking');
  await ready('b');
  assert.equal(call.ear.bot.id, 'a');
  assert.deepEqual(ws('b').said(), []);
});

test('bot audio plays, then its words are passed to the others, and the next bot answers', async () => {
  const { call, ws, ready, audio, timers, runTimers } = setup();
  call.join([bot('a'), bot('b'), bot('c')]);
  await ready('a');
  await ready('b');
  await ready('c');
  speak(ws('a'), 'Hello everyone.', 2, 'ia');
  assert.equal(call.view().bots[0].status, 'speaking');
  assert.equal(audio.played.length, 1);
  assert.deepEqual(ws('b').said(), ['[Bot A]: Hello everyone.']);
  assert.deepEqual(ws('c').said(), ['[Bot A]: Hello everyone.']);
  // Next bot is cued to start shortly before the current voice ends.
  const t = timers.at(-1)!;
  assert.equal(t.ms, 2000 - NEXT_TURN_LEAD_MS);
  runTimers();
  assert.equal(ws('b').types().at(-1), 'response.create', 'round-robin: B follows A');
  assert.equal(call.ear.bot.id, 'a', 'Shashank now talks to whoever spoke last');
});

test('a bot that names another hands the turn to that bot', async () => {
  const { call, ws, ready, runTimers } = setup();
  call.join([bot('a'), bot('b'), bot('c')]);
  for (const id of ['a', 'b', 'c']) await ready(id);
  speak(ws('a'), 'Bot C, what do you think?');
  runTimers();
  assert.equal(ws('c').types().at(-1), 'response.create');
  assert.ok(!ws('b').types().includes('response.create'));
  // and from the last bot, round-robin wraps to the first
  speak(ws('c'), 'I agree.');
  runTimers();
  assert.equal(ws('a').types().filter((x: string) => x === 'response.create').length, 2);
});

test('there is no fixed turn limit: bots keep talking until one of them stops it', async () => {
  const { call, ws, ready, timers, runTimers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  for (let i = 0; i < 20; i++) {
    speak(ws(i % 2 ? 'b' : 'a'), `turn ${i}`);
    assert.equal(timers.filter((t) => !t.done).length, 1, `turn ${i} cues the next bot`);
    runTimers();
  }
  assert.equal(ws('a').types().filter((x: string) => x === 'response.create').length, 11);
});

test('a single bot answers and then waits', async () => {
  const { call, ws, ready, timers } = setup();
  call.join([bot('a')]);
  await ready('a');
  speak(ws('a'), 'Hi Shashank.');
  assert.equal(timers.filter((t) => !t.done).length, 0);
});

test('a bot told to respond after Shashank starts talking stays quiet', async () => {
  const { call, ws, ready, timers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'Over to you.');
  ws('a').emit('input_audio_buffer.speech_started');
  timers.forEach((t) => t.fn()); // even a stale timer firing does nothing
  assert.ok(!ws('b').types().includes('response.create'));
});

// ---------- Shashank talking ----------

test('Shashank speaks: mic goes to the listening bot, others get his words as text, the bot replies', async () => {
  const { call, ws, ready, runTimers, timers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  call.micAudio(new Int16Array([1, 2, 3]), 0.2);
  assert.equal(ws('a').sent.at(-1).type, 'input_audio_buffer.append');
  assert.deepEqual([...fromBase64(ws('a').sent.at(-1).audio)], [1, 2, 3]);
  assert.ok(!ws('b').types().includes('input_audio_buffer.append'));
  ws('a').emit('input_audio_buffer.speech_started');
  assert.equal(call.view().userSpeaking, true);
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: ' What is the plan for today? ' });
  assert.equal(call.view().userSpeaking, false);
  assert.deepEqual(ws('b').said(), ['[Shashank (host)]: What is the plan for today?']);
  assert.deepEqual(ws('a').said().slice(1), [], 'the listening bot heard the audio itself');
  assert.equal(call.lines.at(-1).text, 'What is the plan for today?');
  // A replies on its own (server VAD); the nudge timer is cleared when it starts.
  const nudge = timers.at(-1)!;
  assert.equal(nudge.ms, REPLY_GRACE_MS);
  speak(ws('a'), 'Let us start with email.');
  assert.equal(nudge.done, true);
  assert.deepEqual(ws('b').said().at(-1), '[Bot A]: Let us start with email.');
  runTimers();
});

test('if the listening bot does not reply by itself, it is nudged', async () => {
  const { call, ws, ready, timers } = setup();
  call.join([bot('a')]);
  await ready('a');
  speak(ws('a'), 'Hi there.');
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'are you there buddy' });
  const before = ws('a').types().filter((x: string) => x === 'response.create').length;
  timers.at(-1)!.fn();
  assert.equal(ws('a').types().filter((x: string) => x === 'response.create').length, before + 1);
  // a nudge is skipped when the bot is already replying
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'and now what next please' });
  ws('a').emit('response.created');
  const n = ws('a').types().length;
  timers.filter((t) => t.ms === REPLY_GRACE_MS).at(-1)!.fn();
  assert.equal(ws('a').types().length, n);
});

test('Shashank names another bot: the listener is held back and the named bot answers', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'Bot B, tell me a joke.' });
  assert.equal(ws('b').types().at(-1), 'response.create');
  assert.equal(call.ear.bot.id, 'b', 'mic now goes to B');
  assert.equal(ws('a').types().at(-1), 'input_audio_buffer.clear');
  // A's automatic reply starts anyway: it is cancelled and its audio never plays.
  ws('a').emit('response.created');
  assert.equal(ws('a').types().at(-1), 'response.cancel');
  ws('a').emit('response.output_audio.delta', { delta: b64audio(1) });
  assert.equal(call.player.chunks.length, 0);
  ws('a').emit('response.done', { response: { status: 'cancelled' } });
  assert.equal(call.lines.length, 1, 'only Shashank’s line was recorded');
});

test('Shashank names a bot while the listener is already replying: that reply is cut', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  ws('a').emit('response.created');
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'Bot B answer this one' });
  assert.ok(ws('a').types().includes('response.cancel'));
  assert.equal(call.view().bots[0].status, 'idle');
});

test('barge-in: Shashank talking over a bot silences it and cuts its reply where he stopped hearing it', async () => {
  const { call, ws, ready, audio, timers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  ws('a').emit('response.created');
  ws('a').emit('response.output_item.added', { item: { id: 'ia' } });
  ws('a').emit('response.output_audio.delta', { delta: b64audio(3) });
  ws('b').emit('response.created'); // B is also generating
  ws('b').emit('response.done', { response: { status: 'completed' } }); // with no words: ignored
  ws('b').types();
  ws('a').emit('response.done', { response: { status: 'completed' } }); // text empty: ignored
  audio.t = 1.25;
  // B was cued but hasn't started
  call.ear = call.links.get('a');
  call.links.get('b').respond();
  ws('a').emit('input_audio_buffer.speech_started');
  assert.equal(audio.played[0].stopped, true);
  assert.deepEqual(ws('a').sent.at(-1), { type: 'conversation.item.truncate', item_id: 'ia', content_index: 0, audio_end_ms: 1250 });
  assert.equal(call.links.get('b').suppressNext, true, 'B’s pending reply will be cancelled');
  ws('b').emit('response.created');
  assert.equal(ws('b').types().at(-1), 'response.cancel');
  assert.equal(timers.filter((t) => !t.done && t.ms !== STUCK_SPEAKING_MS).length, 0, 'no bot turn queued');
});

test('barge-in while a bot is mid-reply sends a cancel', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a')]);
  await ready('a');
  ws('a').emit('response.created');
  ws('a').emit('input_audio_buffer.speech_started');
  assert.equal(ws('a').types().at(-1), 'response.cancel');
  // speech events from a bot that is not listening are ignored
  call.addBot(bot('z'));
  await ready('z');
  ws('z').emit('input_audio_buffer.speech_started');
  ws('z').emit('conversation.item.input_audio_transcription.completed', { transcript: 'ignored words here now' });
  assert.equal(call.lines.length, 0);
});

test('speaker echo and empty speech are dropped and the auto reply is suppressed', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a')]);
  await ready('a');
  speak(ws('a'), 'Good to hear you, what is on your mind today?', 3);
  ws('a').emit('input_audio_buffer.speech_started'); // while A's voice is still playing
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'what is on your mind today' });
  assert.equal(call.lines.length, 1);
  ws('a').emit('response.created');
  assert.equal(ws('a').types().at(-1), 'response.cancel');
  ws('a').emit('conversation.item.input_audio_transcription.completed', {});
  assert.equal(call.lines.length, 1);
});

test('a bot finishing while Shashank is mid-sentence does not steal his mic', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  ws('a').emit('input_audio_buffer.speech_started');
  speak(ws('b'), 'Late line.');
  assert.equal(call.ear.bot.id, 'a');
});

test('mic: held back while a bot talks unless Shashank is loud; preroll keeps his first word', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a')]);
  call.micAudio(new Int16Array([9]), 1); // nobody listening yet: dropped
  await ready('a');
  speak(ws('a'), 'Long answer', 5);
  const appends = () => ws('a').sent.filter((m) => m.type === 'input_audio_buffer.append');
  const quiet = new Int16Array(2400); // 100 ms
  for (let i = 0; i < 5; i++) call.micAudio(quiet, BARGE_IN_LEVEL / 2);
  assert.equal(appends().length, 0, 'echo-level audio is held back');
  call.micAudio(new Int16Array([5]), BARGE_IN_LEVEL * 2);
  assert.equal(appends().length, 4, '300 ms preroll + the loud chunk');
  call.setMuted(true);
  call.micAudio(new Int16Array([5]), 1);
  assert.equal(appends().length, 4, 'muted: nothing sent');
  assert.equal(call.view().muted, true);
  call.setMuted(false);
  ws('a').emit('input_audio_buffer.speech_started');
  call.micAudio(quiet, 0); // once he is speaking, quiet audio still goes through
  assert.equal(appends().length, 5);
});

// ---------- per-bot selection during the call ----------

test('adding a bot mid-call: it gets the conversation so far and everyone learns the new roster', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a')]);
  await ready('a');
  speak(ws('a'), 'Hello.');
  call.addBot(bot('b'));
  call.addBot(bot('b')); // already in: ignored
  await ready('b');
  assert.deepEqual(ws('b').said(), ['Conversation so far in this call:\n[Bot A]: Hello.']);
  const update = ws('a').sent.filter((m) => m.type === 'session.update').at(-1);
  assert.match(update.session.instructions, /other Grok bots in the call: Bot B\./);
  assert.equal(Object.keys(update.session).length, 1);
});

test('context for a late joiner is capped', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a')]);
  await ready('a');
  for (let i = 0; i < CONTEXT_LINES + 5; i++) call.lines.push({ who: 'X', text: `l${i}` });
  call.addBot(bot('b'));
  await ready('b');
  assert.equal(ws('b').said()[0].split('\n').length, CONTEXT_LINES + 1);
});

test('removing a bot closes it, silences it, and moves the mic if it was listening', async () => {
  const { call, ws, ready, audio } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  ws('a').emit('response.created');
  ws('a').emit('response.output_audio.delta', { delta: b64audio(1) });
  call.removeBot('a');
  call.removeBot('nope');
  assert.equal(ws('a').closed, true);
  assert.equal(audio.played[0].stopped, true);
  assert.equal(call.ear.bot.id, 'b');
  assert.deepEqual(call.view().bots.map((b: any) => b.id), ['b']);
  assert.match(ws('b').sent.at(-1).session.instructions, /No other bots are in the call/);
  // late events from the removed bot change nothing
  speak(ws('a'), 'ghost line');
  assert.equal(call.lines.length, 0);
  call.removeBot('b');
  assert.equal(call.ear, null);
  call.micAudio(new Int16Array([1]), 1);
});

test('adding a bot before joining or after leaving does nothing', () => {
  const { call, mints } = setup();
  call.addBot(bot('a'));
  assert.equal(mints.length, 0);
  call.leave(); // not in a call: no-op
});

// ---------- connection problems ----------

test('a bot whose voice session cannot start shows the reason; the rest of the call goes on', async () => {
  const { call, ws, ready } = setup({ mintFail: (id) => (id === 'a' ? new Error('Included usage used up') : null) });
  call.join([bot('a'), bot('b')]);
  await ready('b');
  const [a, b] = call.view().bots;
  assert.deepEqual([a.status, a.error], ['error', 'Included usage used up']);
  assert.equal(b.status, 'thinking', 'B opens the call instead');
  assert.equal(call.ear.bot.id, 'b');
  assert.ok(ws('b').types().includes('response.create'));
});

test('a failure with no message gets a generic one', async () => {
  const { call } = setup({ mintFail: () => ({}) as Error });
  call.join([bot('a')]);
  await flush();
  assert.equal(call.view().bots[0].error, 'Could not connect.');
});

test('a dropped bot reconnects once with the conversation so far', async () => {
  const { call, ws, ready, sockets, setClock } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'Hello.');
  const first = ws('b');
  first.onerror!();
  first.onclose!();
  assert.equal(call.view().bots[1].status, 'reconnecting');
  await ready('b');
  assert.equal(sockets.get('b')!.length, 2);
  assert.deepEqual(ws('b').said(), ['Conversation so far in this call:\n[Bot A]: Hello.']);
  first.onclose!(); // stale socket: ignored
  // Dropping again right away means it is not coming back.
  ws('b').onclose!();
  assert.deepEqual([call.view().bots[1].status, call.view().bots[1].error], ['error', 'Connection lost.']);
  void setClock;
});

test('a bot that stayed up a while may reconnect again', async () => {
  const { call, ws, ready, sockets, setClock } = setup();
  call.join([bot('a')]);
  await ready('a');
  ws('a').onclose!(); // first drop: reconnect (no context yet)
  await ready('a');
  assert.deepEqual(ws('a').said(), []);
  setClock(MIN_UPTIME_FOR_RETRY_MS + 1);
  ws('a').onclose!();
  await ready('a');
  assert.equal(sockets.get('a')!.length, 3);
  assert.equal(call.ear.bot.id, 'a');
});

test('a listening bot that fails hands the mic to another bot', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  // the reconnect attempt fails at mint
  call.d.mintVoice = async () => {
    throw new Error('nope');
  };
  ws('a').onclose!();
  await flush();
  assert.equal(call.view().bots[0].status, 'error');
  assert.equal(call.ear.bot.id, 'b');
});

test('the first ready bot becomes the listener if the opener failed', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  call.d.mintVoice = async () => {
    throw new Error('down');
  };
  ws('a').onclose!();
  await flush();
  assert.equal(call.ear, null);
  call.d.mintVoice = async (id: string) => ({ clientSecret: 's', url: `wss://voice.test/${id}`, instructions: '' });
  await ready('b');
  assert.equal(call.ear.bot.id, 'b');
});

test('leaving closes every bot; a bot still connecting is dropped quietly', async () => {
  const { call, ws, ready, audio, mints, sockets } = setup();
  call.join([bot('a')]);
  await ready('a');
  speak(ws('a'), 'Hi.', 2);
  call.addBot(bot('b')); // still minting when Shashank leaves
  call.leave();
  await flush();
  assert.equal(ws('a').closed, true);
  assert.equal(audio.played[0].stopped, true);
  assert.equal(call.view().phase, 'idle');
  assert.deepEqual(call.view().bots, []);
  assert.equal(mints.length, 2);
  // B's mint finished after leaving: no socket was opened
  assert.equal(sockets.has('b'), false);
  // and a fresh call works after leaving
  call.join([bot('c')]);
  await ready('c');
  assert.equal(call.ear.bot.id, 'c');
});

test('bad or unknown socket messages are ignored', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a')]);
  await ready('a');
  ws('a').onmessage!({ data: 'not json' });
  ws('a').onmessage!({ data: 'null' });
  ws('a').emit('error', { error: { message: 'no active response' } });
  ws('a').emit('response.output_audio.delta', { delta: 42 });
  ws('a').emit('response.output_audio_transcript.delta', { delta: 42 });
  ws('a').emit('response.output_audio_transcript.done', { transcript: 42 });
  ws('a').emit('response.output_item.added', {});
  ws('a').emit('response.output_audio.delta', { delta: b64audio(0.5) });
  assert.equal(call.player.chunks[0].itemId, 'a:reply');
  ws('a').emit('response.output_audio_transcript.done', { transcript: 'Final words.' });
  ws('a').emit('response.done', {});
  assert.equal(call.lines.at(-1).text, 'Final words.');
});

// ---------- bots pulling other bots into the call ----------

/** Bot `s` speaks `text` and calls a tool in the same reply. */
function useTool(s: FakeSocket, name: string, args: unknown, text = '', status = 'completed') {
  s.emit('response.created');
  if (text) s.emit('response.output_audio_transcript.done', { transcript: text });
  s.emit('response.function_call_arguments.done', { call_id: 'call-1', name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
  s.emit('response.done', { response: { status } });
}
const outputs = (s: FakeSocket) => s.sent.filter((m) => m.type === 'conversation.item.create' && m.item.type === 'function_call_output').map((m) => m.item);

test('groupInstructions lists who can be invited, or says nobody is left', () => {
  assert.match(groupInstructions('B', 'A', ['A'], ['C', 'D']), /invite_bot tool\. Bots you can invite: C, D\./);
  assert.match(groupInstructions('B', 'A', ['A']), /already in the call, so there is nobody to invite/);
});

test('matchBot: exact name first, then a name mentioned in the request', () => {
  const pool = [{ id: '1', name: "Shashank's Bot" }, { id: '2', name: "Shashank's X bot" }];
  assert.equal(matchBot("shashank's x bot", pool), '2');
  assert.equal(matchBot('please get Shashanks Bot in here', pool), '1');
  assert.equal(matchBot('', pool), null);
  assert.equal(matchBot('nobody', pool), null);
});

test('every bot gets the invite tool and the list of bots it can pull in', async () => {
  const { call, ws } = setup();
  call.join([bot('a')], [bot('a'), bot('b'), bot('c')]);
  await flush();
  ws('a').onopen!();
  const update = ws('a').sent[0].session;
  assert.deepEqual(update.tools, TOOLS);
  assert.deepEqual(update.tools[0], INVITE_TOOL);
  assert.match(update.instructions, /Bots you can invite: Bot B, Bot C\./);
});

test('a bot pulls another bot in: it joins, hears the conversation, says hello, and the inviter confirms', async () => {
  const { call, ws, ready, mints } = setup();
  call.join([bot('a'), bot('b')], [bot('a'), bot('b'), bot('c')]);
  await ready('a');
  await ready('b');
  speak(ws('b'), 'We should ask Bot C.');
  useTool(ws('a'), 'invite_bot', { name: 'Bot C' }, 'Let me bring in Bot C.');
  assert.deepEqual(outputs(ws('a')), [{ type: 'function_call_output', call_id: 'call-1', output: 'Bot C is joining the call now. Tell everyone in one short line.' }]);
  assert.equal(ws('a').types().at(-1), 'response.create', 'inviter speaks again to confirm');
  assert.deepEqual(ws('b').said().at(-1), '[Bot A]: Let me bring in Bot C.');
  assert.deepEqual(mints.at(-1), 'c');
  assert.deepEqual(call.view().bots.map((x: any) => x.id), ['a', 'b', 'c']);
  // everyone already in the call learns the new roster, and that nobody is left to invite
  const latest = ws('b').sent.filter((m) => m.type === 'session.update').at(-1).session.instructions;
  assert.match(latest, /other Grok bots in the call: Bot A, Bot C\./);
  assert.match(latest, /nobody to invite/);
  await ready('c');
  assert.deepEqual(ws('c').said(), [
    'Conversation so far in this call:\n[Bot B]: We should ask Bot C.',
    '[Bot A]: Let me bring in Bot C.',
    '[Call]: Bot A just pulled you into this call. Say a short hello.',
  ]);
  assert.equal(ws('c').types().at(-1), 'response.create');
  assert.equal(call.invited.size, 0);
});

test('invite refusals: unknown bot, already in the call, bad arguments, unknown tool', async () => {
  const { call, ws, ready, mints } = setup();
  call.join([bot('a'), bot('b')], [bot('a'), bot('b'), bot('c')]);
  await ready('a');
  await ready('b');
  useTool(ws('a'), 'invite_bot', { name: 'Grok Prime' });
  useTool(ws('a'), 'invite_bot', { name: 'Bot B' });
  useTool(ws('a'), 'invite_bot', 'not json');
  useTool(ws('a'), 'invite_bot', 'null');
  useTool(ws('a'), 'end_the_call', {});
  assert.deepEqual(outputs(ws('a')).map((o: any) => o.output), [
    'There is no Grok Bot called "Grok Prime". Bots you can invite: Bot C.',
    'Bot B is already in the call.',
    'There is no Grok Bot called "". Bots you can invite: Bot C.',
    'There is no Grok Bot called "". Bots you can invite: Bot C.',
    'Unknown tool "end_the_call". Tools in this call: invite_bot, pass, hand_to, wait_for_host, leave_call.',
  ]);
  assert.equal(mints.length, 2, 'nobody new was minted');
  // with nobody left to invite, the refusal says so
  call.addBot(bot('c'));
  useTool(ws('a'), 'invite_bot', { name: 'Grok Prime' });
  assert.equal(outputs(ws('a')).at(-1).output, 'There is no Grok Bot called "Grok Prime". Bots you can invite: nobody.');
});

test('a tool call in a reply Shashank cut off is not run', async () => {
  const { call, ws, ready, mints } = setup();
  call.join([bot('a')], [bot('a'), bot('c')]);
  await ready('a');
  ws('a').emit('response.created');
  ws('a').emit('input_audio_buffer.speech_started'); // barge-in: reply discarded
  ws('a').emit('response.function_call_arguments.done', { call_id: 'x', name: 'invite_bot' });
  ws('a').emit('response.done', { response: { status: 'cancelled' } });
  assert.equal(outputs(ws('a'))[0].output, 'Not done: this reply was cut off before anyone heard it.');
  assert.equal(mints.length, 1);
  // a server-cancelled reply is not run either, and the bot does not speak again while Shashank talks
  useTool(ws('a'), 'invite_bot', { name: 'Bot C' }, '', 'cancelled');
  assert.equal(mints.length, 1);
  useTool(ws('a'), 'invite_bot', { name: 'Bot C' });
  assert.equal(mints.length, 2, 'runs once the reply completes');
  assert.notEqual(ws('a').types().at(-1), 'response.create', 'no follow-up while Shashank is mid-sentence');
});

test('tool call events without an id or name are ignored; an invited bot removed before it connects is forgotten', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a')], [bot('a'), bot('c')]);
  await ready('a');
  ws('a').emit('response.created');
  ws('a').emit('response.function_call_arguments.done', { name: 'invite_bot' });
  ws('a').emit('response.done', { response: { status: 'completed' } });
  assert.equal(outputs(ws('a')).length, 0);
  useTool(ws('a'), 'invite_bot', { name: 'Bot C' });
  assert.equal(call.invited.get('c'), 'Bot A');
  call.removeBot('c');
  assert.equal(call.invited.size, 0);
});

test('Shashank starting to talk as a bot finishes keeps his mic on the same bot', async () => {
  const { call, ws, ready, setClock } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  assert.equal(call.ear.bot.id, 'a');
  setClock(50_000);
  call.micAudio(new Int16Array(10), 0.2); // loud: he is starting a sentence, the server hasn't said so yet
  setClock(50_000 + USER_ACTIVE_MS - 1);
  speak(ws('b'), 'Done talking.');
  assert.equal(call.ear.bot.id, 'a', 'mic stays put');
  setClock(50_000 + USER_ACTIVE_MS);
  speak(ws('b'), 'Done again.');
  assert.equal(call.ear.bot.id, 'b', 'once he has been quiet a moment, the mic follows the last speaker');
});

test('leaked voice-model markup is stripped before other bots hear a line', async () => {
  assert.equal(
    cleanTranscript("Hey, I'm here. <response_segment_0_already_spoken> Hey, I'm here. </response_segment_0_already_spoken>"),
    "Hey, I'm here.",
  );
  assert.equal(cleanTranscript('a <b/> c </x> d'), 'a c d');
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'Hi. <seg>Hi.</seg>');
  assert.equal(ws('b').said().at(-1), '[Bot A]: Hi.');
});

test('the next bot is not cued again if it is already about to speak', async () => {
  const { call, ws, ready, runTimers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'Over to B.');
  call.links.get('b').respond(); // e.g. its hello as a newly invited bot
  const before = ws('b').types().filter((x: string) => x === 'response.create').length;
  runTimers();
  assert.equal(ws('b').types().filter((x: string) => x === 'response.create').length, before);
  ws('b').emit('response.created'); // now active rather than pending
  speak(ws('a'), 'Still over to B.');
  runTimers();
  assert.equal(ws('b').types().filter((x: string) => x === 'response.create').length, before);
});

// ---------- corrections reach the bots ----------

test('hasCorrection matches whole correction words only', () => {
  assert.deepEqual(CORRECTION_WORDS, ['no', 'wait', 'stop', 'actually', 'wrong']);
  for (const t of ['No, not that.', 'WAIT a second', 'please stop', 'actually let us do X', 'that is wrong']) assert.equal(hasCorrection(t), true, t);
  for (const t of ['I know nothing', 'nonstop waiting', 'wrongly', '', 'actual numbers']) assert.equal(hasCorrection(t), false, t);
});

test('isNoiseOrEcho never drops a correction, even when it repeats the bot', () => {
  const bot = 'No wait, the plan is to stop the old service and fix what is wrong';
  assert.equal(isNoiseOrEcho('the plan is to stop the old service', bot), false);
  assert.equal(isNoiseOrEcho('the plan is the old service', bot), true);
  assert.equal(isNoiseOrEcho('the plan is the old service', ''), false, 'no bot audio: only empty speech is dropped');
  assert.equal(isNoiseOrEcho('', ''), true);
});

test('tagOf and contextText label the host and cut-off lines', () => {
  assert.equal(HOST, 'Shashank (host)');
  assert.equal(tagOf({ who: USER, text: 'x' }), HOST);
  assert.equal(tagOf({ who: 'Bot A', text: 'x' }), 'Bot A');
  assert.equal(tagOf({ who: 'Bot A', text: 'x', cut: true }), 'Bot A (cut off by the host)');
  assert.equal(
    contextText([{ who: USER, text: 'hi' }, { who: 'B', text: 'half', cut: true }]),
    'Conversation so far in this call:\n[Shashank (host)]: hi\n[B (cut off by the host)]: half',
  );
});

test('groupInstructions tells bots the host comes before the current topic', () => {
  const text = groupInstructions('B', 'A', ['A']);
  assert.match(text, /lines are tagged "\[Shashank \(host\)\]"/);
  assert.match(text, /What the host says comes before the current topic/);
  assert.match(text, /\(cut off by the host\)" is only the part the host heard/);
});

test('heardPart keeps whole words up to the share of audio heard', () => {
  const t = 'aaaa bbbb cccc dddd';
  assert.equal(heardPart(t, 2000, 4000), 'aaaa bbbb');
  assert.equal(heardPart(t, 1000, 4000), 'aaaa');
  assert.equal(heardPart(t, 100, 4000), '', 'mid first word: nothing whole was heard');
  assert.equal(heardPart(t, 4000, 4000), t);
  assert.equal(heardPart(t, 5000, 4000), t);
  assert.equal(heardPart('', 1, 1), '');
  assert.equal(heardPart(t, 0, 4000), '');
  assert.equal(heardPart(t, 10, 0), '');
});

test('the host’s words reach the other bots tagged as host', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'focus on pricing' });
  assert.deepEqual(ws('b').said(), ['[Shashank (host)]: focus on pricing']);
  call.addBot(bot('c'));
  await ready('c');
  assert.equal(ws('c').said()[0], 'Conversation so far in this call:\n[Shashank (host)]: focus on pricing');
});

test('echo check runs only while bot audio plays: the same words with nothing playing are kept', async () => {
  const { call, ws, ready, audio } = setup();
  call.join([bot('a')]);
  await ready('a');
  speak(ws('a'), 'Good to hear you, what is on your mind today?', 1);
  audio.t = 5; // A's voice finished playing
  ws('a').emit('input_audio_buffer.speech_started');
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'what is on your mind today' });
  assert.equal(call.lines.at(-1).who, USER);
  // a transcript with no speech_started before it is not treated as echo either
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'what is on your mind today' });
  assert.equal(call.lines.filter((l: any) => l.who === USER).length, 2);
});

test('a correction spoken over a bot is kept even if it sounds like the bot', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a')]);
  await ready('a');
  speak(ws('a'), 'We should ship the old version today', 3);
  ws('a').emit('input_audio_buffer.speech_started');
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'no we should not ship the old version' });
  assert.equal(call.lines.at(-1).text, 'no we should not ship the old version');
});

/** Bot `s` starts a reply with `seconds` of audio and `text`, but does not finish it. */
function startReply(s: FakeSocket, text: string, seconds: number, item: string) {
  s.emit('response.created');
  s.emit('response.output_item.added', { item: { id: item } });
  s.emit('response.output_audio.delta', { delta: b64audio(seconds) });
  s.emit('response.output_audio_transcript.delta', { delta: text });
}

test('cutting a bot off: the others get only the part the host heard', async () => {
  const { call, ws, ready, audio } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  startReply(ws('a'), 'aaaa bbbb cccc dddd', 4, 'ia');
  audio.t = 2;
  ws('a').emit('input_audio_buffer.speech_started');
  // audio still streaming after the cut counts toward the whole reply but never plays
  ws('a').emit('response.output_audio.delta', { delta: b64audio(4) });
  assert.equal(call.player.chunks.length, 0);
  ws('a').emit('response.done', { response: { status: 'cancelled' } });
  assert.deepEqual(ws('b').said(), ['[Bot A (cut off by the host)]: aaaa']);
  assert.deepEqual(call.lines, [{ who: 'Bot A', text: 'aaaa', cut: true }]);
  assert.deepEqual(ws('a').said(), [`[Call]: ${USER} just joined. Open the call with one short spoken line.`], 'the cut bot is not sent its own line');
  assert.equal(call.links.get('a').heardMs, 0);
});

test('cut off before any audio played: nothing is passed on', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  startReply(ws('a'), 'never heard', 2, 'ia');
  ws('a').emit('input_audio_buffer.speech_started');
  ws('a').emit('response.done', { response: { status: 'cancelled' } });
  assert.deepEqual(ws('b').said(), []);
  assert.equal(call.lines.length, 0);
});

test('cut off after all its audio had played: the whole reply is passed on', async () => {
  const { call, ws, ready, audio } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  startReply(ws('a'), 'short and done', 1, 'ia');
  audio.t = 1.5;
  ws('a').emit('input_audio_buffer.speech_started');
  ws('a').emit('response.done', { response: { status: 'cancelled' } });
  assert.deepEqual(ws('b').said(), ['[Bot A (cut off by the host)]: short and done']);
});

test('a cut bot removed before its reply ends passes nothing on; idle bots are untouched', async () => {
  const { call, ws, ready, audio } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  startReply(ws('b'), 'aaaa bbbb', 2, 'ib');
  audio.t = 1;
  ws('a').emit('input_audio_buffer.speech_started');
  assert.equal(call.links.get('a').heardMs, 0, 'A had no reply running');
  assert.equal(call.links.get('b').heardMs, 1000);
  call.removeBot('b');
  ws('b').emit('response.done', { response: { status: 'cancelled' } });
  assert.equal(call.lines.length, 0);
});

test('stuck "host is talking" state is reset when the mic goes quiet and no transcript comes', async () => {
  const { call, ws, ready, timers, setClock } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  setClock(1000);
  call.micAudio(new Int16Array(10), 0.2);
  ws('a').emit('input_audio_buffer.speech_started');
  assert.equal(call.view().userSpeaking, true);
  const stuck = timers.filter((t) => t.ms === STUCK_SPEAKING_MS && !t.done);
  assert.equal(stuck.length, 1);
  // still loud recently: keep waiting
  setClock(1000 + STUCK_SPEAKING_MS - 1);
  stuck[0].done = true;
  stuck[0].fn();
  assert.equal(call.view().userSpeaking, true);
  const again = timers.filter((t) => t.ms === STUCK_SPEAKING_MS && !t.done);
  assert.equal(again.length, 1, 're-armed');
  // quiet long enough: unstick, clear the half-heard audio, and let the listener answer
  setClock(1000 + STUCK_SPEAKING_MS);
  again[0].done = true;
  again[0].fn();
  assert.equal(call.view().userSpeaking, false);
  assert.equal(ws('a').types().at(-1), 'input_audio_buffer.clear');
  assert.equal(timers.at(-1)!.ms, REPLY_GRACE_MS);
  // with the call unstuck, bots take turns again
  speak(ws('a'), 'Anyway.');
  assert.ok(timers.some((t) => !t.done && t.ms === 0), 'next bot turn cued');
});

test('stuck timer: cleared by a transcript, harmless after leaving, and fine with no listener', async () => {
  const { call, ws, ready, timers } = setup();
  call.join([bot('a')]);
  await ready('a');
  ws('a').emit('input_audio_buffer.speech_started');
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'hello there friend' });
  assert.ok(timers.filter((t) => t.ms === STUCK_SPEAKING_MS).every((t) => t.done));
  call.checkStuck(); // not speaking: nothing happens
  ws('a').emit('input_audio_buffer.speech_started');
  call.removeBot('a'); // the listener leaves mid-sentence
  call.checkStuck(); // no listener left: just unsticks
  assert.equal(call.view().userSpeaking, false);
  call.leave();
  assert.equal(call.stuckTimer, null);
});

// ---------- bots managing turns ----------

const creates = (s: FakeSocket) => s.types().filter((x: string) => x === 'response.create').length;

test('groupInstructions explains the turn tools', () => {
  const text = groupInstructions('B', 'A', ['A', 'C']);
  for (const name of ['hand_to', 'pass', 'wait_for_host', 'leave_call']) assert.match(text, new RegExp(name));
  assert.deepEqual(TOOLS.map((t: any) => t.name), ['invite_bot', 'pass', 'hand_to', 'wait_for_host', 'leave_call']);
  for (const t of TOOLS) assert.equal((t as any).type, 'function');
});

test('hand_to gives the next turn to that bot, over a name in the words and over round-robin', async () => {
  const { call, ws, ready, runTimers } = setup();
  call.join([bot('a'), bot('b'), bot('c')]);
  for (const id of ['a', 'b', 'c']) await ready(id);
  useTool(ws('a'), 'hand_to', { name: 'Bot C' }, 'Bot B made a point. Over to someone else.');
  assert.equal(outputs(ws('a')).at(-1).output, 'Bot C speaks next.');
  assert.notEqual(ws('a').types().at(-1), 'response.create', 'no follow-up reply after a turn tool');
  runTimers();
  assert.equal(creates(ws('c')), 1);
  assert.equal(creates(ws('b')), 0);
});

test('hand_to with an unknown bot, itself, or bad arguments: refused, turn goes on as usual', async () => {
  const { call, ws, ready, runTimers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  useTool(ws('a'), 'hand_to', { name: 'Grok Prime' }, 'Hmm.');
  assert.equal(outputs(ws('a')).at(-1).output, 'No bot called "Grok Prime" can take the turn. Bots in the call: Bot B. The turn goes on as usual.');
  runTimers();
  assert.equal(creates(ws('b')), 1, 'round-robin');
  useTool(ws('a'), 'hand_to', { name: 'Bot A' }, 'Me again.');
  assert.match(outputs(ws('a')).at(-1).output, /No bot called "Bot A"/);
  useTool(ws('a'), 'hand_to', 'not json', 'Ok.');
  assert.match(outputs(ws('a')).at(-1).output, /No bot called ""/);
  call.removeBot('b');
  useTool(ws('a'), 'hand_to', { name: 'Bot B' }, 'Alone.');
  assert.match(outputs(ws('a')).at(-1).output, /Bots in the call: nobody\./);
});

test('a hand_to target that left before its turn: falls back to round-robin', async () => {
  const { call, ws, ready, runTimers } = setup();
  call.join([bot('a'), bot('b'), bot('c')]);
  for (const id of ['a', 'b', 'c']) await ready(id);
  ws('a').emit('response.created');
  ws('a').emit('response.output_audio_transcript.done', { transcript: 'Thoughts?' });
  ws('a').emit('response.function_call_arguments.done', { call_id: 'h', name: 'hand_to', arguments: '{"name":"Bot C"}' });
  // C drops out as the tool output is being made: simulate by removing it right after the tool ran
  const orig = call.onToolCall.bind(call);
  call.onToolCall = (l: any, c: any) => {
    const r = orig(l, c);
    call.removeBot('c');
    return r;
  };
  ws('a').emit('response.done', { response: { status: 'completed' } });
  runTimers();
  assert.equal(creates(ws('b')), 1);
});

test('pass: the bot says nothing and the turn moves on; when every bot passes, they wait for the host', async () => {
  const { call, ws, ready, runTimers, timers } = setup();
  call.join([bot('a'), bot('b'), bot('c')]);
  for (const id of ['a', 'b', 'c']) await ready(id);
  speak(ws('a'), 'What does everyone think?');
  runTimers();
  useTool(ws('b'), 'pass', {});
  assert.equal(outputs(ws('b')).at(-1).output, 'You passed this turn.');
  assert.equal(call.passes, 1);
  runTimers();
  assert.equal(creates(ws('c')), 1, 'C is up after B passed');
  useTool(ws('c'), 'pass', {});
  runTimers();
  useTool(ws('a'), 'pass', {});
  assert.equal(call.waitingForHost, true, 'three passes in a row');
  assert.equal(timers.filter((t) => !t.done).length, 0);
  assert.equal(call.view().waitingForHost, true);
  // a real line resets the count
  call.hostSpoke();
  useTool(ws('a'), 'pass', {});
  speak(ws('b'), 'I have something.');
  assert.equal(call.passes, 0);
});

test('a solo bot that passes waits for the host', async () => {
  const { call, ws, ready, timers } = setup();
  call.join([bot('a')]);
  await ready('a');
  useTool(ws('a'), 'pass', {});
  assert.equal(call.waitingForHost, true);
  assert.equal(timers.filter((t) => !t.done).length, 0);
});

test('wait_for_host stops bot turns until the host speaks', async () => {
  const { call, ws, ready, timers, runTimers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'Bot B, quick one.');
  useTool(ws('b'), 'wait_for_host', {}, 'Let us check with Shashank.');
  assert.equal(outputs(ws('b')).at(-1).output, 'The bots now wait for Shashank to speak.');
  assert.equal(call.waitingForHost, true);
  // a queued cue from before is skipped too
  runTimers();
  assert.equal(creates(ws('b')), 0);
  // another bot finishing a line does not restart the chatter
  speak(ws('a'), 'Agreed.');
  assert.equal(timers.filter((t) => !t.done).length, 0);
  // an echo-dropped line does not count as the host speaking
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: '' });
  assert.equal(call.waitingForHost, true);
  ws('a').emit('response.created'); // the server's auto-reply to that noise is cancelled
  ws('a').emit('response.done', { response: { status: 'cancelled' } });
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'ok go on both of you' });
  assert.equal(call.waitingForHost, false);
  speak(ws('a'), 'Sure.');
  assert.equal(timers.filter((t) => !t.done).length, 1, 'bots take turns again');
});

test('leave_call: the bot says goodbye, leaves once it has played, and the others are told', async () => {
  const { call, ws, ready, timers, runTimers } = setup();
  call.join([bot('a'), bot('b'), bot('c')]);
  for (const id of ['a', 'b', 'c']) await ready(id);
  ws('b').emit('response.created');
  ws('b').emit('response.output_item.added', { item: { id: 'ib' } });
  ws('b').emit('response.output_audio.delta', { delta: b64audio(2) });
  ws('b').emit('response.output_audio_transcript.done', { transcript: 'Goodbye all.' });
  ws('b').emit('response.function_call_arguments.done', { call_id: 'l', name: 'leave_call', arguments: '{}' });
  ws('b').emit('response.done', { response: { status: 'completed' } });
  assert.equal(outputs(ws('b')).at(-1).output, 'You are leaving the call.');
  const leaveTimer = timers.find((t) => t.ms === 2000)!;
  assert.ok(leaveTimer, 'leaves after its 2 s goodbye');
  assert.equal(call.links.get('b').leaving, true);
  assert.ok(!call.readyLinks().some((l: any) => l.bot.id === 'b'), 'not offered turns or the mic while leaving');
  runTimers();
  assert.deepEqual(call.view().bots.map((x: any) => x.id), ['a', 'c']);
  assert.equal(ws('b').closed, true);
  assert.equal(ws('a').said().at(-1), '[Call]: Bot B left the call.');
  assert.equal(creates(ws('c')), 1, 'the turn still went on to C');
});

test('leave_call: a bot already removed by the host is not removed twice; the last bot leaving ends nothing else', async () => {
  const { call, ws, ready, timers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  useTool(ws('a'), 'leave_call', {}, 'Bye.');
  call.removeBot('a');
  call.addBot(bot('a')); // re-added: a new link with the same id
  timers.filter((t) => !t.done).forEach((t) => t.fn());
  assert.deepEqual(call.view().bots.map((x: any) => x.id), ['b', 'a']);
  useTool(ws('b'), 'leave_call', {});
  timers.filter((t) => !t.done).forEach((t) => {
    t.done = true;
    t.fn();
  });
  assert.deepEqual(call.view().bots.map((x: any) => x.id), ['a']);
});

test('turn tools combined with invite_bot wait for the follow-up reply', async () => {
  const { call, ws, ready, runTimers } = setup();
  call.join([bot('a'), bot('b')], [bot('a'), bot('b'), bot('c')]);
  await ready('a');
  await ready('b');
  ws('a').emit('response.created');
  ws('a').emit('response.output_audio_transcript.done', { transcript: 'Getting Bot C.' });
  ws('a').emit('response.function_call_arguments.done', { call_id: 'i', name: 'invite_bot', arguments: '{"name":"Bot C"}' });
  ws('a').emit('response.function_call_arguments.done', { call_id: 'w', name: 'wait_for_host', arguments: '{}' });
  ws('a').emit('response.done', { response: { status: 'completed' } });
  assert.equal(ws('a').types().at(-1), 'response.create', 'speaks again about the invite');
  assert.equal(call.waitingForHost, false, 'decision held until the follow-up');
  speak(ws('a'), 'Bot C is coming.');
  assert.equal(call.waitingForHost, true);
  runTimers();
});

test('a turn decision in a reply the host cut off is dropped', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  useTool(ws('a'), 'wait_for_host', {}, 'Wait.', 'cancelled');
  assert.equal(call.waitingForHost, false);
  assert.equal(call.links.get('a').turn, null);
});
