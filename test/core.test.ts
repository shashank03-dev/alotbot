import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DECISIONS_MAX,
  hostName,
  BARGE_IN_LEVEL,
  Call,
  ACTION_ITEMS_MAX,
  cleanNote,
  MESSAGE_MAX_CHARS,
  TIMELINE_MAX,
  exportMarkdown,
  lastCallText,
  openItems,
  SUMMARY_LINES,
  SUMMARY_MAX_CHARS,
  WRAP_UP_MS,
  wrapUpInstructions,
  CORRECTION_WORDS,
  NOTE_MAX_CHARS,
  NOTEPAD_MAX,
  notepadText,
  DIRECTION_MAX,
  directionText,
  isDirection,
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
  SEARCH_TOOLS,
  TOOLS,
  isNoiseOrEcho,
  isRepeat,
  isStopCommand,
  GATE_HOLD_MS,
  STOP_MAX_WORDS,
  MAX_TOOL_ROUNDS,
  MAX_APP_TOOL_ROUNDS,
  FOCUS_IDLE_MS,
  CLOSING_MAX_WORDS,
  RESPONSE_START_MS,
  RESPONSE_STALL_MS,
  CONNECT_TIMEOUT_MS,
  isFiller,
  hasRealWords,
  PASS_TOOL,
  spokenWords,
  groupRulesText,
  callHarnessTools,
  SETUP_RETRY_MS,
  LANDED_POLL_MS,
  USER_FIRST_GRACE_MS,
  SILENCE_MS,
  agentText,
  withParam,
  MAX_APPS_LISTED,
  namedBots,
  nameForms,
  spokenTo,
  wantsAnswer,
  isGroupAddress,
  isClosing,
  focusText,
  suggestionPrompt,
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
  assert.equal(findAddressee('mybot', bots), 'a', 'run together, as speech-to-text writes it');
  // same start position: the longer name is the better match
  assert.equal(findAddressee('alpha beta says hi', [{ id: 's', name: 'Alpha' }, { id: 'l', name: 'Alpha Beta' }]), 'l');
  assert.equal(findAddressee('alpha beta says hi', [{ id: 'l', name: 'Alpha Beta' }, { id: 's', name: 'Alpha' }]), 'l');
});

test('isNoiseOrEcho: empty speech and speaker echo are ignored, real speech is not', () => {
  assert.equal(isNoiseOrEcho('  ', ''), true);
  assert.equal(isNoiseOrEcho('ok', 'ok sure'), true, 'a short line of the bot\'s own words is echo too');
  assert.equal(isNoiseOrEcho('ok', ''), false, 'nothing was playing');
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
  updates() {
    return this.sent.filter((m) => m.type === 'async_update.add').map((m) => m.async_update.payload[0].message.content);
  }
  said() {
    return this.sent.filter((m) => m.type === 'conversation.item.create' && m.item.type === 'message').map((m) => m.item.content[0].text);
  }
}

const samples = (seconds: number) => new Float32Array(Math.round(seconds * SAMPLE_RATE)).fill(0.25);
const b64audio = (seconds: number) => toBase64(floatTo16(samples(seconds)));

type ToolReq = { id: string; req: any; resolve: (v: any) => void; reject: (e: Error) => void };
function setup(opts: { mintFail?: (id: string) => Error | null; tools?: (id: string) => object[]; apps?: (id: string) => unknown; voice?: object; mintWait?: (id: string) => Promise<void> | undefined } = {}) {
  const toolCalls: ToolReq[] = [];
  const audio = new FakeAudio();
  const sockets = new Map<string, FakeSocket[]>();
  const timers: { fn: () => void; ms: number; id: number; done: boolean }[] = [];
  let clock = 0;
  let tid = 0;
  const mints: string[] = [];
  const call: any = new Call({
    mintVoice: async (id: string) => {
      mints.push(id);
      await opts.mintWait?.(id);
      const err = opts.mintFail?.(id);
      if (err) throw err;
      return { clientSecret: `sec-${id}`, url: `wss://voice.test/${id}`, instructions: `I am ${id}.`, tools: opts.tools?.(id), apps: opts.apps?.(id), ...opts.voice };
    },
    openSocket: (url: string, protocols: string[], id: string) => {
      const ws = new FakeSocket(url, protocols);
      assert.equal(new URL(url).pathname, `/${id}`, 'told whose session the socket is for');
      sockets.set(id, [...(sockets.get(id) ?? []), ws]);
      return ws;
    },
    audio,
    callTool: (id: string, req: any) => new Promise((resolve, reject) => toolCalls.push({ id, req, resolve, reject })),
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
    call, audio, ws, ready, timers, runTimers, mints, sockets, toolCalls,
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
  assert.equal(ws('b').sent[0].session.audio.input.transcription.language_hint, 'en', 'auto language is heard as English');
  assert.deepEqual(update.session.audio.input.transcription.keyterms, ['Shashank', 'Bot A', 'Bot B']);
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

// Voice server of 2026-11-18: "completed" arrives several times per item while he is still talking, each one longer;
// only the one after the item is committed is final (call-2026-11-18T18-10-32Z: 5 lines for one sentence).
test('transcripts sent before the item is committed are partial: one line per spoken item, passed on once', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  const item = { item_id: 'u1' };
  ws('a').emit('input_audio_buffer.speech_started', item);
  ws('a').emit('conversation.item.input_audio_transcription.completed', { ...item, transcript: 'Okay, let us decide' });
  ws('a').emit('conversation.item.input_audio_transcription.completed', { ...item, transcript: 'Okay, let us decide to ship' });
  assert.equal(call.view().userSpeaking, true, 'still talking');
  assert.deepEqual(ws('b').said(), []);
  ws('a').emit('input_audio_buffer.speech_started', item); // the server repeats it for the same item
  ws('a').emit('input_audio_buffer.committed', item);
  ws('a').emit('conversation.item.input_audio_transcription.completed', { ...item, transcript: 'Okay, let us decide to ship on Friday.' });
  ws('a').emit('conversation.item.input_audio_transcription.completed', { ...item, transcript: 'Okay, let us decide to ship on Friday.' });
  assert.equal(call.view().userSpeaking, false);
  assert.deepEqual(ws('b').said(), ['[Shashank (host)]: Okay, let us decide to ship on Friday.']);
  assert.deepEqual(call.lines.filter((l: { who: string }) => l.who === USER).map((l: { text: string }) => l.text), ['Okay, let us decide to ship on Friday.']);
  // The next item is heard as usual; a commit for some other item does not end it early.
  ws('a').emit('input_audio_buffer.speech_started', { item_id: 'u2' });
  ws('a').emit('input_audio_buffer.committed', { item_id: 'other' });
  ws('a').emit('conversation.item.input_audio_transcription.completed', { item_id: 'u2', transcript: 'And the code' });
  assert.equal(ws('b').said().length, 1);
  ws('a').emit('input_audio_buffer.committed', { item_id: 'u2' });
  ws('a').emit('conversation.item.input_audio_transcription.completed', { item_id: 'u2', transcript: 'And the code word is pineapple.' });
  assert.equal(ws('b').said().at(-1), '[Shashank (host)]: And the code word is pineapple.');
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
  assert.equal(call.view().bots[0].status, 'quiet', 'naming B starts a one-on-one with B');
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
  assert.equal(call.nextTimer, null, 'no bot turn queued');
  assert.equal(timers.filter((t) => !t.done && t.ms === RESPONSE_STALL_MS).length, 1, 'only B\'s watchdog, waiting for its cancel to be confirmed');
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
  const { call, timers } = setup({ mintFail: () => ({}) as Error });
  call.join([bot('a')]);
  await flush();
  await useUpRetries(timers);
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
  const { call, ws, ready, timers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  // the reconnect attempt fails at mint
  call.d.mintVoice = async () => {
    throw new Error('nope');
  };
  ws('a').onclose!();
  await flush();
  assert.equal(call.view().bots[0].status, 'reconnecting', 'tries again first');
  await useUpRetries(timers);
  assert.equal(call.view().bots[0].status, 'error');
  assert.equal(call.ear.bot.id, 'b');
});

test('the first ready bot becomes the listener if the opener failed', async () => {
  const { call, ws, ready, timers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  call.d.mintVoice = async () => {
    throw new Error('down');
  };
  ws('a').onclose!();
  await flush();
  await useUpRetries(timers);
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

test('groupInstructions: the turn tools read as one list, and garbled names map to the closest bot', () => {
  const text = groupInstructions('B', 'A', ['A', 'B']);
  // leave_call had drifted three sentences away from the list it belongs to ("... and leave_call takes you out").
  assert.match(text, /wait_for_host stops the bots and waits for Shashank \(use it when the topic is done or you are going in circles\), and leave_call takes you out of the call\. Never repeat/);
  assert.match(text, /"X bot" may come through as "export" or "ex-bot"\): read it as the closest bot name\./);
});

test('matchBot: exact name first, then a name mentioned in the request', () => {
  const pool = [{ id: '1', name: "Shashank's Bot" }, { id: '2', name: "Shashank's X bot" }];
  assert.equal(matchBot("shashank's x bot", pool), '2');
  assert.equal(matchBot('please get Shashanks Bot in here', pool), '1');
  assert.equal(matchBot('', pool), null);
  assert.equal(matchBot('nobody', pool), null);
});

test('short names: "Xbot" and "X bot" reach Shashank\'s X bot, unless the short form is generic or shared', () => {
  // A call: "Hey Xbot, what's up?" was answered by My Bot, because only the full name was recognised.
  const pool = [{ id: 'a', name: 'My Bot' }, { id: 'x', name: "Shashank's X bot" }, { id: 's', name: "Shashank's Bot" }];
  assert.equal(findAddressee("Hey Xbot, what's up?", pool), 'x');
  assert.equal(findAddressee("Hey X bot, what's up?", pool), 'x');
  assert.equal(findAddressee('x-bot, your take?', pool), 'x');
  assert.equal(findAddressee("Hey Shashank's X bot", pool), 'x', 'the full name still wins');
  assert.equal(findAddressee('mybot what do you think', pool), 'a');
  assert.equal(findAddressee('this bot thing is odd', pool), null, '"Shashank\'s Bot" does not shrink to just "bot"');
  assert.equal(findAddressee('use the X search for that', pool), null, 'a one-letter short form is never used');
  assert.deepEqual(namedBots('Xbot and My Bot, both of you', pool), ['a', 'x']);
  assert.deepEqual(namedBots("Shashank's X bot and xbot", pool), ['x'], 'one bot named twice counts once');
  assert.equal(matchBot('Xbot', pool), 'x');
  assert.equal(matchBot('please pull in X bot', pool), 'x');
  // Two bots that shorten to the same thing: neither gets the short form.
  const twins = [{ id: '1', name: "Ann's Helper" }, { id: '2', name: "Bob's Helper" }];
  assert.equal(findAddressee('helper, go ahead', twins), null);
  assert.equal(findAddressee("Bob's Helper, go ahead", twins), '2');
  assert.deepEqual(nameForms([]), []);
});

test('misheard names: speech-to-text writing "X bot" as "export" or "ex-bot" still reaches the X bot', () => {
  // Calls of 2026-11-11: "Call in my export." made My Bot search past chats for "export" (12:55); "Hey, export, I
  // wanted to know about today's post" was answered by My Bot instead (11:42); "call in my ex-bot" (17:15).
  const pool = [{ id: 'a', name: 'My Bot' }, { id: 'x', name: "Shashank's X bot" }, { id: 's', name: "Shashank's Bot" }];
  assert.equal(findAddressee("Hey, export, um, I wanted to know about the statistics of today's post.", pool), 'x');
  assert.equal(findAddressee('I would say for Shashank, call in my ex-bot basically.', pool), 'x');
  assert.equal(findAddressee('exbot, go', pool), 'x');
  assert.equal(matchBot('export', pool), 'x');
  assert.equal(matchBot('Call in my export.', pool), 'x');
  assert.equal(spokenTo('Hey export, check the reach.', pool), 'x');
  assert.equal(findAddressee('export the report', [{ id: 'a', name: 'My Bot' }]), null, 'only a bot whose name is X bot');
  // two X bots: neither gets the heard forms
  assert.equal(findAddressee('export, go', [{ id: '1', name: "Ann's X bot" }, { id: '2', name: "Bob's X bot" }]), null);
});

test('short names work in stop, wrap-up and pass lines too', () => {
  const names = ['My Bot', "Shashank's X bot"];
  assert.equal(isStopCommand('xbot stop', names), true);
  assert.equal(isStopCommand('okay mybot, wait', names), true);
  assert.equal(isClosing('thanks xbot', names), true);
  assert.equal(isFiller('Pass, mybot.', names), true);
});

test('every bot gets the invite tool and the list of bots it can pull in', async () => {
  const { call, ws } = setup();
  call.join([bot('a')], [bot('a'), bot('b'), bot('c')]);
  await flush();
  ws('a').onopen!();
  const update = ws('a').sent[0].session;
  assert.deepEqual(update.tools, [...TOOLS, ...SEARCH_TOOLS]);
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
  assert.deepEqual(outputs(ws('a')), [{ type: 'function_call_output', call_id: 'call-1', output: 'Bot C is connecting now and says hello itself once it is in; you will hear if it cannot join. Say in one short line that it is on its way, not that it is here.' }]);
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

test('a bot that cannot join: the others are told, the bot that invited it says so, and it can be invited again', async () => {
  // Call of 2026-11-11 12:57: My Bot said "X bot's in." and "All three of us are here now." while both bots it
  // invited timed out connecting; nobody on the call was told, and the host waited in silence.
  const { call, ws, ready, mints } = setup();
  call.join([bot('a'), bot('b')], [bot('a'), bot('b'), bot('c')]);
  await ready('a');
  await ready('b');
  useTool(ws('a'), 'invite_bot', { name: 'Bot C' }, 'Bringing in Bot C.');
  ws('a').emit('response.created');
  ws('a').emit('response.done', { response: { status: 'completed' } });
  await flush();
  const before = creates(ws('a'));
  call.links.get('c').fail(new Error('Timed out connecting.'));
  for (const id of ['a', 'b']) assert.equal(ws(id).said().at(-1), '[Call]: Bot C could not join the call (Timed out connecting.). It is not in the call; it can be invited again.');
  assert.equal(creates(ws('a')), before + 1, 'the bot that invited it tells the host');
  assert.equal(creates(ws('b')), 0);
  const latest = ws('b').sent.filter((m) => m.type === 'session.update').at(-1).session.instructions;
  assert.match(latest, /other Grok bots in the call: Bot A\./);
  assert.match(latest, /Bots you can invite: Bot C\./);
  assert.deepEqual(call.roster(), ['Bot A', 'Bot B']);
  assert.equal(call.invited.size, 0);
  // invited again: a fresh connection
  useTool(ws('a'), 'invite_bot', { name: 'Bot C' }, 'Trying Bot C again.');
  assert.match(outputs(ws('a')).at(-1).output, /^Bot C is connecting now/);
  assert.deepEqual(mints.filter((m) => m === 'c').length, 2);
  await ready('c');
  assert.equal(call.links.get('c').ready, true);
  assert.deepEqual(call.roster(), ['Bot A', 'Bot B', 'Bot C']);
  // a bot in the call that drops for good; the host had added it, so nobody is asked to speak
  const aCreates = creates(ws('a'));
  call.links.get('c').joined = true;
  call.links.get('c').fail(new Error('Connection lost.'));
  assert.equal(ws('b').said().at(-1), '[Call]: Bot C dropped out of the call (Connection lost.). It is not in the call; it can be invited again.');
  assert.equal(creates(ws('a')), aCreates);
});

test('hand_to a bot that is still joining says so, instead of "nobody"', async () => {
  // Calls of 2026-11-11 11:42 and 17:14: right after invite_bot, hand_to the new bot got "Bots in the call: nobody."
  const { call, ws, ready } = setup();
  call.join([bot('a')], [bot('a'), bot('b')]);
  await ready('a');
  useTool(ws('a'), 'invite_bot', { name: 'Bot B' }, 'Bringing in Bot B.');
  useTool(ws('a'), 'hand_to', { name: 'Bot B' }, 'Over to Bot B.');
  assert.equal(outputs(ws('a')).at(-1).output, 'Bot B is still joining; it says hello itself once it is in.');
  assert.equal(call.links.get('a').turn, null);
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
    'Unknown tool "end_the_call". Tools in this call: invite_bot, pass, hand_to, wait_for_host, leave_call, list_tasks, add_task, done_task, save_summary.',
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
  const { call, ws, ready, timers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'Over to B.');
  call.links.get('b').respond(); // e.g. its hello as a newly invited bot
  const before = ws('b').types().filter((x: string) => x === 'response.create').length;
  fire(timers, call.nextTimer);
  assert.equal(ws('b').types().filter((x: string) => x === 'response.create').length, before);
  ws('b').emit('response.created'); // now active rather than pending
  speak(ws('a'), 'Still over to B.');
  fire(timers, call.nextTimer);
  assert.equal(ws('b').types().filter((x: string) => x === 'response.create').length, before);
});

// ---------- corrections reach the bots ----------

test('hasCorrection matches whole correction words only', () => {
  assert.deepEqual(CORRECTION_WORDS, ['no', 'wait', 'stop', 'actually', 'wrong']);
  for (const t of ['No, not that.', 'WAIT a second', 'please stop', 'actually let us do X', 'that is wrong']) assert.equal(hasCorrection(t), true, t);
  for (const t of ['I know nothing', 'nonstop waiting', 'wrongly', '', 'actual numbers']) assert.equal(hasCorrection(t), false, t);
});

test('isNoiseOrEcho keeps a correction word the bots did not say, and drops the bots\' own one coming back', () => {
  const bot = 'Let us ship the old service today';
  assert.equal(isNoiseOrEcho('no ship the old service', bot), false, '"no" was not said by the bot: the host said it');
  assert.equal(isNoiseOrEcho('wrong', bot), false);
  const echo = 'Actually, no, let us wait for Shashank on this one';
  assert.equal(isNoiseOrEcho('actually no let us wait for shashank', echo), true, 'the bot\'s own correction words are echo');
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
  audio.t = 1;
  ws('a').emit('input_audio_buffer.speech_started');
  // passed on at once, from what was generated by then: 1 s of 4 s heard
  assert.deepEqual(ws('b').said(), ['[Bot A (cut off by the host)]: aaaa']);
  assert.deepEqual(call.lines, [{ who: 'Bot A', text: 'aaaa', cut: true }]);
  assert.deepEqual(ws('a').said(), [`[Call]: ${USER} just joined. Open the call with one short spoken line.`], 'the cut bot is not sent its own line');
  // audio still streaming after the cut never plays, and the reply ending adds nothing more
  ws('a').emit('response.output_audio.delta', { delta: b64audio(4) });
  assert.equal(call.player.chunks.length, 0);
  ws('a').emit('response.done', { response: { status: 'cancelled' } });
  assert.equal(call.lines.length, 1);
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

test('cutting off a bot that is not the listener; a reply already being dropped is not passed on twice', async () => {
  const { call, ws, ready, audio } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  startReply(ws('b'), 'aaaa bbbb', 2, 'ib');
  audio.t = 1;
  ws('a').emit('input_audio_buffer.speech_started');
  assert.deepEqual(call.lines, [{ who: 'Bot B', text: 'aaaa', cut: true }]);
  call.stopAll(); // B's reply is already being dropped
  assert.equal(call.lines.length, 1);
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
  assert.deepEqual(TOOLS.map((t: any) => t.name), ['invite_bot', 'pass', 'hand_to', 'wait_for_host', 'leave_call', 'list_tasks', 'add_task', 'done_task', 'save_summary']);
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
  call.hostSpoke('');
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
  const leaveTimer = timers.find((t) => t.ms === 2000 && !t.done)!;
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

test('wait_for_host in the same reply as invite_bot is honoured at once', async () => {
  const { call, ws, ready, runTimers } = setup();
  call.join([bot('a'), bot('b')], [bot('a'), bot('b'), bot('c')]);
  await ready('a');
  await ready('b');
  ws('a').emit('response.created');
  ws('a').emit('response.output_audio_transcript.done', { transcript: 'Getting Bot C.' });
  ws('a').emit('response.function_call_arguments.done', { call_id: 'i', name: 'invite_bot', arguments: '{"name":"Bot C"}' });
  ws('a').emit('response.function_call_arguments.done', { call_id: 'w', name: 'wait_for_host', arguments: '{}' });
  ws('a').emit('response.done', { response: { status: 'completed' } });
  assert.notEqual(ws('a').types().at(-1), 'response.create', 'wait_for_host wins: no follow-up line');
  assert.equal(call.waitingForHost, true);
  runTimers();
  assert.equal(creates(ws('b')), 0, 'and nobody takes a turn');
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

// ---------- pinned current direction ----------

test('isDirection: a correction of at least three words', () => {
  assert.equal(isDirection('No, focus on pricing'), true);
  assert.equal(isDirection('actually let us talk about hiring'), true);
  assert.equal(isDirection('no stop'), false);
  assert.equal(isDirection('focus on pricing now'), false);
});

test('isDirection: a question or a "no" in the middle of a line is not a direction', () => {
  assert.equal(isDirection("No, no. Shashank's what?"), false);
  assert.equal(isDirection('You, no, I, I sent a support request. They said they would be reviewing.'), false);
  assert.equal(isDirection('Uh, no, focus on pricing'), true);
  assert.equal(isDirection('No, no, consider the first guy.'), true);
});

test('a new bot on the account: bots already talking expect its name, without resending other settings', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a')]);
  await ready('a');
  const before = ws('a').sent.length;
  call.setAvailable([bot('a'), bot('n')]);
  const update = ws('a').sent.slice(before).find((m: any) => m.session?.audio);
  assert.deepEqual(update.session, { audio: { input: { transcription: { model: 'grok-transcribe', language_hint: 'en', keyterms: ['Shashank', 'Bot A', 'Bot N'] } } } });
  assert.match(ws('a').sent.at(-1).session.instructions, /Bot N/);
});

test('speech-to-text is biased toward every bot name, short names included, and the host', async () => {
  const { call, ws, ready } = setup();
  const x = { ...bot('x'), name: "Shashank's X bot" };
  const m = { ...bot('m'), name: 'My Bot' };
  const o = { ...bot('o'), name: 'Research Desk' };
  call.join([x], [x, m, o]);
  await ready('x');
  assert.deepEqual(ws('x').sent[0].session.audio.input.transcription.keyterms, ['Shashank', "Shashank's X bot", 'X bot', 'My Bot', 'Research Desk']);
});

test('directionText lists the pinned corrections, newest last, or nothing', () => {
  assert.equal(directionText([]), '');
  assert.equal(
    directionText(['no, focus on pricing', 'wait, only Europe']),
    '\n\n# Current direction (pinned by the host)\nShashank corrected the bots during this call. Follow this over anything said before it; the newest is last:\n- "no, focus on pricing"\n- "wait, only Europe"',
  );
  assert.ok(groupInstructions('B', 'A', ['A'], [], ['no, focus on pricing']).endsWith('- "no, focus on pricing"'));
  assert.ok(!groupInstructions('B', 'A', ['A']).includes('Current direction'));
});

const lastInstructions = (s: FakeSocket) => s.sent.filter((m) => m.type === 'session.update').at(-1).session.instructions;

test('a host correction is pinned for every bot, and kept for bots that join or reconnect later', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'tell me about the market' });
  assert.deepEqual(call.direction, [], 'not a correction');
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: ' No, focus on pricing only. ' });
  assert.deepEqual(call.direction, ['No, focus on pricing only.']);
  assert.deepEqual(call.view().direction, ['No, focus on pricing only.']);
  for (const id of ['a', 'b']) assert.match(lastInstructions(ws(id)), /# Current direction \(pinned by the host\)[\s\S]*- "No, focus on pricing only\."$/);
  // a short nudge is passed on as a line but not pinned
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'wait' });
  assert.equal(call.direction.length, 1);
  call.addBot(bot('c'));
  await flush();
  ws('c').onopen!();
  assert.match(ws('c').sent[0].session.instructions, /- "No, focus on pricing only\."$/);
  // reconnecting bot gets it in its new session too
  ws('b').onclose!();
  await flush();
  ws('b').onopen!();
  assert.match(ws('b').sent.at(-1).session.instructions, /- "No, focus on pricing only\."$/);
});

test('only the newest DIRECTION_MAX corrections are kept, and leaving clears them', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a')]);
  await ready('a');
  for (let i = 0; i < DIRECTION_MAX + 2; i++) {
    ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: `no, do step ${i}` });
  }
  assert.equal(call.direction.length, DIRECTION_MAX);
  assert.equal(call.direction[0], 'no, do step 2');
  assert.equal(call.direction.at(-1), `no, do step ${DIRECTION_MAX + 1}`);
  call.leave();
  assert.deepEqual(call.direction, []);
});

// ---------- shared notepad ----------

test('notepadText shows notes and tasks, or says it is empty', () => {
  assert.equal(notepadText([], []), 'The task list is empty.');
  assert.equal(notepadText([{ text: 'Price is $10', by: 'Bot A' }], []), 'Notes:\n- Price is $10 (Bot A)');
  assert.equal(
    notepadText([], [
      { id: 1, text: 'Email Sam', by: 'Bot A', done: false, doneBy: null },
      { id: 2, text: 'Book room', by: 'Bot A', done: true, doneBy: 'Bot B' },
    ]),
    'Tasks:\n- [ ] 1. Email Sam (added by Bot A)\n- [x] 2. Book room (done by Bot B)',
  );
  assert.equal(notepadText([{ text: 'n', by: 'X' }], [{ id: 1, text: 't', by: 'X', done: false, doneBy: null }]), 'Notes:\n- n (X)\nTasks:\n- [ ] 1. t (added by X)');
});

test('cleanNote trims, joins lines and caps length', () => {
  assert.equal(cleanNote('  a\n\n b  '), 'a b');
  assert.equal(cleanNote(undefined), '');
  assert.equal(cleanNote(42), '42');
  assert.equal(cleanNote('x'.repeat(NOTE_MAX_CHARS + 50)).length, NOTE_MAX_CHARS);
});

test('groupInstructions explains tasks without offering a notepad', () => {
  const text = groupInstructions('B', 'A', ['A']);
  for (const name of ['add_task', 'done_task', 'list_tasks', '"[Tasks]:"']) assert.ok(text.includes(name), name);
  assert.doesNotMatch(text, /notepad|write_note|read_notes/i);
});

test('added tasks are shared with the other bots and the page', async () => {
  const { call, ws } = await two();
  const v0 = call.view().notepadVersion;
  useTool(ws('b'), 'add_task', { text: 'Email the designer' });
  assert.equal(outputs(ws('b')).at(-1).output, 'Task 1 added.');
  assert.equal(ws('b').types().at(-1), 'response.create', 'wrote silently: gets to speak');
  assert.equal(ws('a').said().at(-1), '[Tasks]: Bot B added task 1: "Email the designer"');
  useTool(ws('b'), 'add_task', { text: 'Book a room' }, 'And a room.');
  const v = call.view();
  assert.deepEqual(v.notes, []);
  assert.deepEqual(v.tasks.map((t: any) => [t.id, t.text, t.by, t.done]), [[1, 'Email the designer', 'Bot B', false], [2, 'Book a room', 'Bot B', false]]);
  assert.equal(v.notepadVersion, v0 + 2);
});

test('empty or full task writes are refused; historical notes do not take task slots', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a')]);
  await ready('a');
  useTool(ws('a'), 'add_task', { text: '   ' }, 'Hmm.');
  assert.equal(outputs(ws('a')).at(-1).output, 'Nothing written: the text was empty.');
  useTool(ws('a'), 'add_task', 'bad json', 'Hmm.');
  assert.equal(outputs(ws('a')).at(-1).output, 'Nothing written: the text was empty.');
  call.notes = Array.from({ length: NOTEPAD_MAX }, (_, i) => ({ text: `n${i}`, by: 'X' }));
  useTool(ws('a'), 'add_task', { text: 'First task' }, 'One.');
  assert.equal(call.tasks.length, 1);
  call.tasks = Array.from({ length: NOTEPAD_MAX }, (_, i) => ({ id: i + 1, text: `t${i}`, by: 'X', done: false, doneBy: null }));
  useTool(ws('a'), 'add_task', { text: 'one more' }, 'Hmm.');
  assert.equal(outputs(ws('a')).at(-1).output, `Nothing written: the task list is full (${NOTEPAD_MAX} items).`);
  assert.equal(call.tasks.length, NOTEPAD_MAX);
});

test('done_task: ticks a task, accepts "#2" or "2", refuses unknown or done ones', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  useTool(ws('a'), 'add_task', { text: 'One' }, 'x');
  useTool(ws('a'), 'add_task', { text: 'Two' }, 'x');
  useTool(ws('b'), 'done_task', { id: '#2' }, 'Done with two.');
  assert.equal(outputs(ws('b')).at(-1).output, 'Task 2 marked done.');
  assert.ok(ws('a').said().includes('[Tasks]: Bot B marked task 2 done: "Two"'));
  assert.deepEqual(call.tasks[1], { id: 2, text: 'Two', by: 'Bot A', done: true, doneBy: 'Bot B' });
  useTool(ws('b'), 'done_task', { id: 2 }, 'x');
  assert.equal(outputs(ws('b')).at(-1).output, 'Task 2 is already done.');
  useTool(ws('b'), 'done_task', { id: 9 }, 'x');
  assert.equal(outputs(ws('b')).at(-1).output, 'There is no task 9. Open tasks: 1.');
  useTool(ws('b'), 'done_task', {}, 'x');
  assert.equal(outputs(ws('b')).at(-1).output, 'There is no task . Open tasks: 1.');
  useTool(ws('b'), 'done_task', { id: 1 }, 'x');
  useTool(ws('b'), 'done_task', { id: 7 }, 'x');
  assert.equal(outputs(ws('b')).at(-1).output, 'There is no task 7. Open tasks: none.');
  // new ids keep counting up after the highest
  useTool(ws('a'), 'add_task', { text: 'Three' }, 'x');
  assert.equal(call.tasks.at(-1).id, 3);
});

test('list_tasks returns tasks without historical notes and the bot speaks with them', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a')]);
  await ready('a');
  useTool(ws('a'), 'list_tasks', {}, 'Let me check.');
  assert.equal(outputs(ws('a')).at(-1).output, 'The task list is empty.');
  assert.equal(ws('a').types().at(-1), 'response.create', 'speaks after reading');
  call.notes = [{ text: 'Old note', by: 'Bot A' }];
  useTool(ws('a'), 'add_task', { text: 'Review budget' }, 'ok');
  useTool(ws('a'), 'list_tasks', {});
  assert.equal(outputs(ws('a')).at(-1).output, 'Tasks:\n- [ ] 1. Review budget (added by Bot A)');
  call.leave();
  assert.deepEqual([call.notes, call.tasks], [[], []]);
});

// ---------- web and X search ----------

test('every bot gets web search and X search', async () => {
  assert.deepEqual(SEARCH_TOOLS, [{ type: 'web_search' }, { type: 'x_search' }]);
  const { call, ws } = setup();
  call.join([bot('a'), bot('b')]);
  await flush();
  for (const id of ['a', 'b']) {
    ws(id).onopen!();
    const { tools, instructions } = ws(id).sent[0].session;
    assert.deepEqual(tools.slice(-2), SEARCH_TOOLS);
    assert.match(instructions, /You can search the web and X/);
  }
  ws('a').emit('session.updated');
  assert.equal(call.view().bots[0].search, true);
});

test('if a session refuses the setup, the bot retries once without search and still joins', async () => {
  const { call, ws } = setup();
  call.join([bot('a')]);
  await flush();
  ws('a').onopen!();
  ws('a').emit('error', { error: { message: 'unsupported tool type' } });
  const retry = ws('a').sent[1];
  assert.equal(retry.type, 'session.update');
  assert.deepEqual(retry.session.tools, TOOLS, 'no search tools this time');
  ws('a').emit('session.updated');
  assert.equal(call.view().bots[0].status, 'thinking', 'joined and opening the call');
  assert.equal(call.view().bots[0].search, false);
  // a second refusal is not retried again (the bot would stay connecting, as before)
  ws('a').emit('error', {});
  assert.equal(ws('a').sent.filter((m) => m.type === 'session.update').length, 2);
});

test('an error before the socket exists, or after setup, does not resend the setup', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a')]);
  const link = call.links.get('a');
  link.onEvent(JSON.stringify({ type: 'error' })); // still minting: no socket yet
  assert.equal(link.search, true);
  await ready('a');
  ws('a').emit('error', {});
  assert.equal(ws('a').sent.filter((m) => m.type === 'session.update').length, 1);
});

// ---------- memory between calls and the end-of-call export ----------

const memory = (extra: object = {}) => ({ summary: 'We picked May for launch.', actionItems: ['Email Sam'], notes: [{ text: 'Budget 5k', by: 'Bot A' }], ...extra });

test('lastCallText gives the summary and open items, or nothing when there is no memory', () => {
  assert.equal(lastCallText(null), '');
  assert.equal(lastCallText({ summary: '', actionItems: [], notes: [] }), '');
  const text = lastCallText(memory());
  assert.match(text, /^\n\n# Your last call with Shashank\nSummary: We picked May for launch\.\nOpen action items:\n- Email Sam\nUnfinished work carries/);
  assert.doesNotMatch(lastCallText(memory({ summary: '', actionItems: [] })), /Summary|Open action items/);
  assert.ok(groupInstructions('B', 'A', ['A'], [], [], memory() as any).includes('# Your last call'));
});

test('openItems merges open tasks and summary items without repeats', () => {
  const tasks = [
    { id: 1, text: 'Email Sam', by: 'X', done: false, doneBy: null },
    { id: 2, text: 'Done one', by: 'X', done: true, doneBy: 'Y' },
  ];
  assert.deepEqual(openItems(tasks, ['email sam!', 'Book room', '', '  ']), ['Email Sam', 'Book room']);
  assert.deepEqual(openItems([], []), []);
});

test('wrapUpInstructions holds the record of the call, capped', () => {
  const lines = Array.from({ length: SUMMARY_LINES + 3 }, (_, i) => ({ who: USER, text: `l${i}` }));
  const text = wrapUpInstructions(lines, [], []);
  assert.match(text, /^Shashank is ending this group voice call now\. Do not speak\. Call the save_summary tool/);
  assert.ok(!text.includes('[Shashank (host)]: l2\n'));
  assert.ok(text.includes(`[Shashank (host)]: l${SUMMARY_LINES + 2}`));
  assert.ok(text.endsWith('Tasks and saved context:\nThe task list is empty.'));
});

test('exportMarkdown: summary, items, done tasks, notes, direction and transcript', () => {
  const data = {
    startedAt: 0,
    endedAt: 125_000,
    bots: ['Bot A', 'Bot B'],
    lines: [{ who: USER, text: 'Hi' }, { who: 'Bot A', text: 'Half', cut: true }],
    summary: 'Talked.',
    notes: [{ text: 'n1', by: 'Bot A' }],
    tasks: [{ id: 1, text: 'Ship', by: 'Bot A', done: true, doneBy: 'Bot B' }],
    direction: ['no, focus on X'],
    memory: { summary: 'Talked.', actionItems: ['Call Sam'], notes: [] },
  };
  assert.equal(
    exportMarkdown(data, (ms) => `T${ms}`),
    [
      '# Grok Call, T0', '', 'Bots: Bot A, Bot B  ', 'Length: 2 min', '',
      '## Summary', '', 'Talked.', '',
      '## Action items', '', '- [ ] Call Sam', '',
      '## Done during the call', '', '- [x] Ship (Bot B)', '',
      '## Notes', '', '- n1 (Bot A)', '',
      '## Current direction', '', '- no, focus on X', '',
      '## Transcript', '', '**Shashank (host):** Hi  ', '**Bot A (cut off by the host):** Half  ', '',
    ].join('\n'),
  );
  const empty = exportMarkdown({ ...data, endedAt: -5, bots: [], lines: [], summary: '', notes: [], tasks: [], direction: [], memory: { summary: '', actionItems: [], notes: [] } });
  assert.match(empty, /^# Grok Call, 1970-01-01T00:00:00\.000Z\n\nBots: none  \nLength: 0 min/);
  for (const t of ['_No summary was saved._', '## Action items\n\n_None._', '_Nothing was said._']) assert.ok(empty.includes(t), t);
  assert.ok(!empty.includes('## Notes') && !empty.includes('## Done during') && !empty.includes('## Current direction'));
  assert.ok(!empty.includes('## Decisions'), 'old exports without decisions');
  const decided = exportMarkdown({ ...data, decisions: ['Ship in May'] }, (ms) => `T${ms}`);
  assert.match(decided, /## Summary\n\nTalked\.\n\n## Decisions\n\n- Ship in May\n\n## Action items/);
  assert.ok(!exportMarkdown({ ...data, decisions: [] }).includes('## Decisions'));
});

test('joining with last call memory: bots are told, and the notepad starts with its notes and open items', async () => {
  const { call, ws } = setup();
  const m = memory();
  call.join([bot('a')], [bot('a')], m);
  await flush();
  ws('a').onopen!();
  assert.match(ws('a').sent[0].session.instructions, /# Your last call with Shashank\nSummary: We picked May for launch\./);
  assert.deepEqual(call.notes, [{ text: 'Budget 5k', by: 'Bot A' }]);
  assert.notEqual(call.notes[0], m.notes[0], 'a copy, not the saved object');
  assert.deepEqual(call.tasks, [{ id: 1, text: 'Email Sam', by: 'Last call', done: false, doneBy: null }]);
});

test('Leave: one bot saves the summary silently, then the export is ready', async () => {
  const { call, ws, ready, setClock } = setup();
  setClock(1_000);
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'Let us launch in May.');
  useTool(ws('b'), 'add_task', { text: 'Email Sam' }, 'Adding a task.');
  assert.equal(call.ear.bot.id, 'b', 'B spoke last, so B is listening');
  ws('b').emit('conversation.item.input_audio_transcription.completed', { transcript: 'sounds good' });
  const pending = call.wrapUp();
  assert.equal(call.view().phase, 'wrapping');
  assert.ok(!ws('a').sent.some((m) => m.response?.instructions), 'only the listening bot is asked');
  const ask = ws('b').sent.filter((m) => m.type === 'response.create').at(-1);
  assert.match(ask.response.instructions, /Call the save_summary tool[\s\S]*\[Bot A\]: Let us launch in May\.[\s\S]*Tasks:\n- \[ \] 1\. Email Sam/);
  // the mic and late speech events are ignored while wrapping up
  const appends = ws('b').types().filter((t: string) => t === 'input_audio_buffer.append').length;
  call.micAudio(new Int16Array([1]), 1);
  assert.equal(ws('b').types().filter((t: string) => t === 'input_audio_buffer.append').length, appends);
  ws('b').emit('input_audio_buffer.speech_started');
  ws('b').emit('conversation.item.input_audio_transcription.completed', { transcript: 'ignored now please' });
  assert.equal(call.view().userSpeaking, false);
  setClock(61_000);
  useTool(ws('b'), 'save_summary', { summary: 'We chose May.', action_items: ['Email Sam', 'Book a venue', ''], decisions: ['Launch in May', ' ', ...Array.from({ length: DECISIONS_MAX + 3 }, (_, i) => `d${i}`)] });
  assert.equal(outputs(ws('b')).at(-1).output, 'Saved.');
  assert.notEqual(ws('b').types().at(-1), 'response.create', 'no follow-up while wrapping');
  const data = await pending;
  assert.equal(data.summary, 'We chose May.');
  assert.deepEqual(data.memory.actionItems, ['Email Sam', 'Book a venue']);
  assert.equal(data.decisions.length, DECISIONS_MAX);
  assert.equal(data.decisions[0], 'Launch in May');
  assert.deepEqual([data.startedAt, data.endedAt], [1_000, 61_000]);
  assert.deepEqual(data.bots, ['Bot A', 'Bot B']);
  assert.equal(data.lines.length, 3);
  call.leave();
  assert.equal(call.view().phase, 'idle');
  assert.equal(await call.wrapUp(), null, 'not in a call');
});

test('Leave: every summary request comes with a new message, so a bot that spoke last still has a turn to answer', async () => {
  // Calls of 2026-11-11 12:57 and 13:28, 2026-11-12 09:48 and 2026-11-13 18:42: the bot had the last word, so a bare
  // response.create gave the voice model nothing new. It repeated its last line, the retry never started, and the
  // call was saved without a summary. Every call where something new came last saved one.
  const { call, ws, ready } = setup();
  call.join([bot('a')]);
  await ready('a');
  speak(ws('a'), 'Same wall as before.');
  const pending = call.wrapUp();
  const requestsBeforeEachAsk = () => {
    const sent = ws('a').sent;
    return sent.flatMap((m: any, i: number) => (m.type === 'response.create' && m.response?.instructions ? [sent[i - 1]] : []));
  };
  let before = requestsBeforeEachAsk();
  assert.equal(before.length, 1);
  assert.equal(before[0].type, 'conversation.item.create');
  assert.equal(before[0].item.role, 'user');
  assert.match(before[0].item.content[0].text, /ending the call[\s\S]*save_summary/);
  speak(ws('a'), 'Same wall as before.'); // it talks instead of saving: asked once more, again with a new message
  before = requestsBeforeEachAsk();
  assert.equal(before.length, 2);
  assert.equal(before[1].type, 'conversation.item.create');
  useTool(ws('a'), 'save_summary', { summary: 'Blocked on Full Disk Access.' });
  assert.equal((await pending).summary, 'Blocked on Full Disk Access.');
});

test('Leave: a summary request the voice server never starts goes to the next bot, or ends the call at once', async () => {
  // Calls of 2026-11-11 11:45 and 13:42: the summary request never started; Leave then sat out its full 20 s and the
  // call was saved without a summary.
  const { call, ws, ready, timers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'Launch in May.');
  const pending = call.wrapUp();
  const asked = ws('a').sent.filter((m) => m.type === 'response.create').at(-1);
  assert.match(asked.response.instructions, /save_summary/);
  timers.filter((x) => !x.done && x.ms === RESPONSE_START_MS).at(-1)!.fn(); // A never starts
  const next = ws('b').sent.filter((m) => m.type === 'response.create').at(-1);
  assert.match(next.response.instructions, /save_summary/, 'B is asked instead');
  timers.filter((x) => !x.done && x.ms === RESPONSE_START_MS).at(-1)!.fn(); // B never starts either
  const data = await pending;
  assert.equal(data.summary, '');
  assert.ok(timers.find((x) => x.ms === WRAP_UP_MS)!.done, 'ended without waiting out the 20 s');
  // a late loss from a bot no longer asked changes nothing
  call.wrap = null;
});

test('Leave: the second bot asked can still save the summary', async () => {
  const { call, ws, ready, timers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'Launch in May.');
  const pending = call.wrapUp();
  timers.filter((x) => !x.done && x.ms === RESPONSE_START_MS).at(-1)!.fn();
  call.wrap.lost(call.links.get('a')); // a stale loss from the bot no longer asked
  useTool(ws('b'), 'save_summary', { summary: 'May launch.' });
  assert.equal((await pending).summary, 'May launch.');
});

test('Leave: the summary bot is never heard; if it talks instead of saving, it is asked once more, then the call ends at once', async () => {
  const { call, ws, ready, timers } = setup();
  call.join([bot('a')]);
  await ready('a');
  speak(ws('a'), 'Hi.');
  const lines = call.lines.length;
  const pending = call.wrapUp();
  const asks = () => ws('a').sent.filter((m) => m.type === 'response.create' && m.response?.instructions);
  assert.deepEqual(asks()[0].response.modalities, ['text'], 'asked for text only, so it cannot speak');
  speak(ws('a'), 'Hey Shashank. What is on your mind?'); // it talks anyway
  assert.equal(call.player.chunks.length, 0, 'its voice is not played');
  assert.equal(call.lines.length, lines, 'and not added to the call');
  assert.equal(asks().length, 2, 'asked once more');
  assert.deepEqual(asks()[1].response.modalities, ['text']);
  speak(ws('a'), 'Still talking.');
  assert.equal(asks().length, 2, 'not asked a third time');
  const data = await pending; // no 20 s wait
  assert.equal(data.summary, '');
  assert.ok(timers.find((t) => t.ms === WRAP_UP_MS)!.done, 'the wait timer is cleared');
  call.leave();
});

test('Leave: a reply from a bot other than the one writing the summary does not count as its answer', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'Hi.');
  const pending = call.wrapUp();
  speak(ws('b'), 'Me too.'); // b was not asked
  const asks = ws('a').sent.filter((m) => m.type === 'response.create' && m.response?.instructions);
  assert.equal(asks.length, 1);
  useTool(ws('a'), 'save_summary', { summary: 'Short call.', action_items: [] });
  assert.equal((await pending).summary, 'Short call.');
  call.leave();
});

test('Leave: a bot mid-reply is cut, then asked once its reply has ended', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a')]);
  await ready('a');
  speak(ws('a'), 'Hi.');
  ws('a').emit('response.created');
  void call.wrapUp();
  assert.equal(ws('a').types().at(-1), 'response.cancel');
  ws('a').emit('response.done', { response: { status: 'cancelled' } });
  assert.match(ws('a').sent.at(-1).response.instructions, /save_summary/);
  assert.equal(ws('a').sent.filter((m) => m.response?.instructions).length, 1, 'the cut reply does not count as an answer');
  call.leave();
});

test('Leave: no answer in time ends with no summary; summary text is capped and odd arguments are handled', async () => {
  const { call, ws, ready, timers } = setup();
  call.join([bot('a')]);
  await ready('a');
  speak(ws('a'), 'Hi.');
  const pending = call.wrapUp();
  timers.find((t) => t.ms === WRAP_UP_MS && !t.done)!.fn();
  const data = await pending;
  assert.equal(data.summary, '');
  assert.deepEqual(data.memory.actionItems, []);
  call.leave();
  // a save_summary mid-call (not asked for) just stores what it got
  call.join([bot('b')]);
  await ready('b');
  useTool(ws('b'), 'save_summary', { summary: 'x'.repeat(SUMMARY_MAX_CHARS + 9), action_items: 'not a list' });
  assert.equal(call.summary.length, SUMMARY_MAX_CHARS);
  assert.deepEqual(call.actionItems, []);
  useTool(ws('b'), 'save_summary', { action_items: Array.from({ length: ACTION_ITEMS_MAX + 5 }, (_, i) => `a${i}`) });
  assert.equal(call.summary, '');
  assert.equal(call.actionItems.length, ACTION_ITEMS_MAX);
});

test('Leave with nothing said, or no bot ready: no summary is asked for', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a')]);
  await ready('a');
  const data = await call.wrapUp();
  assert.deepEqual(data.lines, []);
  assert.equal(data.notepadChanged, false);
  assert.ok(!ws('a').sent.some((m) => m.response?.instructions));
  call.leave();
  call.join([bot('b')]);
  call.lines.push({ who: USER, text: 'hello' });
  const d2 = await call.wrapUp(); // b is still connecting
  assert.equal(d2.summary, '');
  call.leave();
});

test('Leave while the listening bot has left: another ready bot writes the summary; leaving mid-wrap-up resolves at once', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'Hi.');
  call.ear = null;
  const pending = call.wrapUp();
  assert.match(ws('a').sent.at(-1).response.instructions, /save_summary/, 'first ready bot');
  call.leave();
  const data = await pending;
  assert.equal(data.summary, '');
});

test('with no new summary, the last call’s summary is kept for next time; notepad changes are flagged', async () => {
  const { call, ws, ready, timers } = setup();
  call.join([bot('a')], [bot('a')], memory());
  await ready('a');
  let data = await call.wrapUp(); // nothing said: no summary asked for
  assert.equal(data.summary, '', 'this call has no summary of its own');
  assert.equal(data.memory.summary, 'We picked May for launch.');
  assert.deepEqual(data.memory.actionItems, ['Email Sam']);
  assert.equal(data.notepadChanged, false, 'carried-over notes alone are not a change');
  call.leave();
  call.join([bot('a')], [bot('a')], memory());
  await ready('a');
  useTool(ws('a'), 'done_task', { id: 1 }, 'Done.');
  useTool(ws('a'), 'save_summary', { summary: 'New one.', action_items: [] });
  const pending = call.wrapUp(); // asks again; nobody answers this time
  timers.find((t) => t.ms === WRAP_UP_MS && !t.done)!.fn();
  data = await pending;
  assert.equal(data.notepadChanged, true);
  assert.equal(data.memory.summary, 'New one.');
  assert.deepEqual(data.memory.actionItems, [], 'done task is not carried over');
  call.leave();
});

// ---------- typing to the bots, the stop hotkey, and the timeline ----------

test('a typed message reaches every bot as the host, and the listening bot answers', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  assert.equal(call.sendText('  What   is next? '), true);
  for (const id of ['a', 'b']) assert.equal(ws(id).said().at(-1), '[Shashank (host)]: What is next?');
  assert.equal(ws('a').types().at(-1), 'response.create', 'A was listening, so A answers');
  assert.equal(call.lines.at(-1).who, USER);
});

test('a typed message naming a bot: that bot answers and gets the mic; a correction is pinned; it ends a wait', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  call.waitingForHost = true;
  call.sendText('No, Bot B should take this one');
  assert.equal(ws('b').types().at(-1), 'response.create');
  assert.equal(call.ear.bot.id, 'b');
  assert.deepEqual(call.direction, ['No, Bot B should take this one']);
  assert.equal(call.waitingForHost, false);
});

test('a typed message cuts off the bot talking; the bot answering waits for its own reply to end', async () => {
  const { call, ws, ready, audio } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  startReply(ws('a'), 'aaaa bbbb cccc dddd', 4, 'ia');
  audio.t = 2;
  const before = creates(ws('a'));
  call.sendText('one more thing');
  assert.ok(ws('a').types().includes('response.cancel'));
  assert.equal(creates(ws('a')), before, 'not asked while its cut reply is still ending');
  ws('a').emit('response.done', { response: { status: 'cancelled' } });
  assert.equal(creates(ws('a')), before + 1);
  assert.deepEqual(ws('b').said().slice(-2), ['[Bot A (cut off by the host)]: aaaa bbbb', '[Shashank (host)]: one more thing']);
});

test('a typed message is refused when empty, outside a call, with no bot ready, or capped when long', async () => {
  const { call, ws, ready } = setup();
  assert.equal(call.sendText('hi'), false, 'not in a call');
  call.join([bot('a')]);
  assert.equal(call.sendText('hi'), false, 'no bot ready yet');
  await ready('a');
  assert.equal(call.sendText('   '), false);
  assert.equal(call.sendText(undefined), false);
  call.ear = null; // listener gone: the first ready bot answers
  assert.equal(call.sendText('x'.repeat(MESSAGE_MAX_CHARS + 10)), true);
  assert.equal(call.lines.at(-1).text.length, MESSAGE_MAX_CHARS);
  assert.equal(call.ear.bot.id, 'a');
  assert.equal(ws('a').types().at(-1), 'response.create');
  void call.wrapUp();
  assert.equal(call.sendText('too late'), false, 'not while wrapping up');
  call.leave();
});

test('stop hotkey: every bot goes quiet, queued turns and nudges are dropped, and they wait for the host', async () => {
  const { call, ws, ready, audio, timers, runTimers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'Bot B, go.', 2); // B is cued
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'quick question here' }); // A gets a nudge timer
  startReply(ws('b'), 'talking', 2, 'ib');
  audio.t = 0.5;
  call.stopAll();
  assert.ok(audio.played.every((p) => p.stopped), 'all audio stopped');
  assert.equal(ws('b').types().at(-1), 'response.cancel');
  assert.equal(call.waitingForHost, true);
  assert.ok(timers.filter((t) => t.ms === REPLY_GRACE_MS).every((t) => t.done), 'nudge cleared');
  const n = creates(ws('a')) + creates(ws('b'));
  runTimers();
  assert.equal(creates(ws('a')) + creates(ws('b')), n, 'nobody starts talking again');
  assert.equal(call.timeline.at(-1).text, 'You stopped every bot');
  call.leave();
  call.stopAll(); // not in a call: nothing happens
  assert.deepEqual(call.timeline, []);
});

test('timeline: joins, lines, cut-offs, tools, notepad, direction, leaves, errors, in order with times', async () => {
  const { call, ws, ready, audio, setClock, runTimers } = setup({ mintFail: (id) => (id === 'z' ? new Error('No usage left') : null) });
  setClock(10_000);
  call.join([bot('a'), bot('b')], [bot('a'), bot('b'), bot('c'), bot('z')]);
  setClock(11_000);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'Hi all.');
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'no, talk about pricing first' });
  useTool(ws('a'), 'list_tasks', {}, 'Noted.');
  useTool(ws('a'), 'add_task', { text: 'Price list' }, 'ok');
  useTool(ws('b'), 'done_task', { id: 1 }, 'ok');
  useTool(ws('b'), 'list_tasks', {});
  useTool(ws('b'), 'hand_to', { name: 'Bot A' }, 'Over to A.');
  useTool(ws('a'), 'pass', {});
  useTool(ws('b'), 'wait_for_host', {}, 'Waiting.');
  useTool(ws('a'), 'invite_bot', { name: 'Bot Z' }, 'Getting Z.');
  await flush();
  startReply(ws('b'), 'aaaa bbbb', 2, 'ib'); // queued after A's 1 s line
  audio.t = 2.6; // 1.6 s of B's 2 s heard
  ws('a').emit('input_audio_buffer.speech_started');
  ws('b').emit('response.done', { response: { status: 'cancelled' } });
  useTool(ws('b'), 'leave_call', {}, 'Bye.');
  runTimers();
  ws('a').onclose!(); // drops and comes back
  await ready('a');
  useTool(ws('a'), 'save_summary', { summary: 's', action_items: [] });
  const texts = call.timeline.map((e: any) => `${e.kind}|${e.text}`);
  assert.deepEqual(texts, [
    'join|Bot A joined',
    'join|Bot B joined',
    'bot|Bot A: Hi all.',
    'host|Shashank (host): no, talk about pricing first',
    'direction|Direction pinned: "no, talk about pricing first"',
    'tool|Bot A read the task list',
    'bot|Bot A: Noted.',
    'task|Bot A added task 1: "Price list"',
    'bot|Bot A: ok',
    'task|Bot B marked task 1 done: "Price list"',
    'bot|Bot B: ok',
    'tool|Bot B read the task list',
    'tool|Bot B handed the turn to Bot A',
    'bot|Bot B: Over to A.',
    'tool|Bot A passed',
    'tool|The other bots had nothing to add: waiting for you',
    'tool|Bot B asked the bots to wait for you',
    'bot|Bot B: Waiting.',
    'tool|Bot A pulled Bot Z into the call',
    'bot|Bot A: Getting Z.',
    'error|Bot Z: No usage left',
    'cut|Bot B (cut off by the host): aaaa',
    'tool|Bot B is leaving the call',
    'bot|Bot B: Bye.',
    'stuck|Your mic went quiet with no words heard: stopped waiting for you',
    'leave|Bot B left the call',
    'error|Bot A lost its connection: reconnecting',
    'join|Bot A reconnected',
    'tool|Bot A saved the call summary',
  ]);
  assert.equal(call.timeline[0].at, 1_000, 'ms since the call started');
  assert.deepEqual(call.timeline.map((e: any) => e.seq), texts.map((_, i) => i + 1));
  assert.equal(call.view().timeline, call.timeline);
});

test('timeline: stuck mic, refused search and every-bot-passed are shown; it keeps only the newest entries', async () => {
  const { call, ws, ready, timers } = setup();
  call.join([bot('a')]);
  await flush();
  ws('a').onopen!();
  ws('a').emit('error', {});
  ws('a').emit('session.updated');
  ws('a').emit('input_audio_buffer.speech_started');
  timers.find((t) => t.ms === STUCK_SPEAKING_MS && !t.done)!.fn();
  useTool(ws('a'), 'pass', {});
  assert.deepEqual(call.timeline.map((e: any) => e.kind), ['error', 'join', 'stuck', 'tool', 'tool']);
  assert.equal(call.timeline[0].text, 'Bot A: web and X search were refused, joining without them');
  assert.equal(call.timeline.at(-1).text, 'Every bot passed: waiting for you');
  for (let i = 0; i < TIMELINE_MAX + 5; i++) call.event('tool', `e${i}`);
  assert.equal(call.timeline.length, TIMELINE_MAX);
  assert.equal(call.timeline.at(-1).text, `e${TIMELINE_MAX + 4}`);
  assert.equal(call.timeline.at(-1).seq, TIMELINE_MAX + 10);
});

// ---------- the host can always stop the bots; echo and loops can't keep them going ----------

test('isStopCommand: short "stop talking" lines only', () => {
  for (const t of ['stop', 'Wait!', 'hold on', 'hang on a sec', 'okay guys, stop talking please', 'be quiet', 'shut up', 'let me talk', 'no no stop', 'give me a second', "that's enough", 'My Bot, stop', 'everyone pause']) {
    assert.equal(isStopCommand(t, ['My Bot']), true, t);
  }
  for (const t of ['', 'wait, I meant the other plan', 'stop the old service', 'no no no', 'ok', 'let us go', 'my bot stop', 'stop '.repeat(STOP_MAX_WORDS + 1)]) {
    assert.equal(isStopCommand(t), false, t);
  }
});

test('isRepeat: most key words of a line were already said', () => {
  const earlier = ['We should launch the pricing page next Tuesday morning.', 'Hi.'];
  assert.equal(isRepeat('So, launch the pricing page next Tuesday.', earlier), true);
  assert.equal(isRepeat('What about hiring a designer for the launch?', earlier), false);
  assert.equal(isRepeat('Yes, that is it.', earlier), false, 'too few key words to judge');
  assert.equal(isRepeat('Great, launch pricing tuesday', ['Hi there.']), false, 'earlier line too short to judge');
  assert.equal(isRepeat('anything at all here', []), false);
});

test('groupInstructions tells bots not to repeat themselves and to go quiet on stop', () => {
  const text = groupInstructions('B', 'A', ['A']);
  assert.match(text, /Never repeat a point already made in the call; if you have nothing new, pass\./);
  assert.match(text, /When the host says stop or wait, every bot goes quiet until the host speaks again\./);
});

test('a bot\'s own "wait for Shashank" coming back through the speakers does not restart the talk', async () => {
  const { call, ws, ready, audio, runTimers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  const s = ws('a');
  s.emit('response.created');
  s.emit('response.output_item.added', { item: { id: 'ia' } });
  s.emit('response.output_audio.delta', { delta: b64audio(3) });
  s.emit('response.output_audio_transcript.done', { transcript: 'Actually, let us wait for Shashank on this one.' });
  s.emit('response.function_call_arguments.done', { call_id: 'w', name: 'wait_for_host', arguments: '{}' });
  s.emit('response.done', { response: { status: 'completed' } });
  assert.equal(call.waitingForHost, true);
  audio.t = 1; // still playing; the mic picks it up
  s.emit('input_audio_buffer.speech_started');
  s.emit('conversation.item.input_audio_transcription.completed', { transcript: 'actually let us wait for Shashank' });
  assert.equal(call.waitingForHost, true, 'echo does not un-pause the call');
  assert.deepEqual(call.direction, [], 'nor get pinned as the host\'s direction');
  assert.equal(call.lines.filter((l: any) => l.who === USER).length, 0);
  assert.equal(call.timeline.at(-1).text, 'Ignored as speaker echo: "actually let us wait for Shashank"');
  assert.equal(call.links.get('a').suppressNext, true, 'its own reply to the echo never plays');
  runTimers();
  assert.equal(creates(ws('b')), 0);
});

test('saying "stop" over a bot: every bot goes quiet and waits, nobody answers it, and the next host line starts things again', async () => {
  const { call, ws, ready, audio, runTimers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'Bot B, what about the stop sign idea?', 3); // B is cued, and "stop" is in the bot's own words
  audio.t = 1;
  ws('a').emit('input_audio_buffer.speech_started');
  ws('a').emit('response.created'); // the server's own reply to what it heard
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'Stop!' });
  assert.equal(call.waitingForHost, true);
  assert.deepEqual(call.direction, [], 'a stop is not a direction');
  assert.equal(ws('b').said().at(-1), '[Shashank (host)]: Stop!');
  assert.ok(ws('a').types().includes('response.cancel'), 'the listener\'s reply is cancelled');
  assert.equal(call.timeline.at(-1).text, 'You said "Stop!": every bot is waiting for you');
  ws('a').emit('response.done', { response: { status: 'cancelled' } });
  const before = creates(ws('a'));
  runTimers();
  assert.equal(creates(ws('b')), 0, 'B\'s cued turn is gone');
  assert.equal(creates(ws('a')), before);
  ws('a').emit('input_audio_buffer.speech_started');
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'ok go on about pricing' });
  assert.equal(call.waitingForHost, false);
  runTimers();
  assert.equal(creates(ws('a')), before + 1, 'the listener answers the next host line');
});

test('typing "stop" works like the stop hotkey', async () => {
  const { call, ws, ready, runTimers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'Bot B, go.', 2);
  const before = creates(ws('a'));
  assert.equal(call.sendText('wait'), true);
  assert.equal(call.waitingForHost, true);
  assert.deepEqual(call.lines.at(-1), { who: USER, text: 'wait' });
  runTimers();
  assert.equal(creates(ws('b')), 0);
  assert.equal(creates(ws('a')), before, 'nobody answers a stop');
});

test('mic gate stays open a moment after a loud frame, so his quieter sounds get through', async () => {
  const { call, ws, ready, setClock } = setup();
  call.join([bot('a')]);
  await ready('a');
  speak(ws('a'), 'Long answer', 5);
  const appends = () => ws('a').sent.filter((m) => m.type === 'input_audio_buffer.append').length;
  setClock(10_000);
  call.micAudio(new Int16Array([5]), 1);
  assert.equal(appends(), 1);
  setClock(10_000 + GATE_HOLD_MS - 1);
  call.micAudio(new Int16Array([5]), 0);
  assert.equal(appends(), 2, 'a quiet frame right after a loud one goes through');
  setClock(10_000 + GATE_HOLD_MS);
  call.micAudio(new Int16Array([5]), 0);
  assert.equal(appends(), 2, 'held back again once the hold is over');
});

test('cutting in drops reply nudges and queued replies asked for before the cut', async () => {
  const { call, ws, ready, runTimers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  call.links.get('b').expectReply();
  ws('a').emit('response.created'); // A is giving its opener
  call.links.get('a').respondWhenFree('later');
  assert.equal(call.links.get('a').queued, 'later');
  ws('a').emit('input_audio_buffer.speech_started');
  assert.equal(call.links.get('a').queued, null);
  const before = creates(ws('b'));
  runTimers();
  assert.equal(creates(ws('b')), before, 'B\'s old nudge never fires');
});

test('echo that cut a bot off: the talk goes on with the next bot', async () => {
  const { call, ws, ready, audio, runTimers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  startReply(ws('b'), 'Pricing should start at ten dollars a month for everyone', 4, 'ib');
  audio.t = 2;
  ws('a').emit('input_audio_buffer.speech_started');
  assert.equal(call.cutBot, call.links.get('b'));
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: 'ten dollars a month' });
  assert.equal(call.lines.filter((l: any) => l.who === USER).length, 0);
  ws('b').emit('response.done', { response: { status: 'cancelled' } });
  const before = creates(ws('a'));
  runTimers();
  assert.equal(creates(ws('a')), before + 1, 'A, next after B, takes the turn');
});

test('nothing resumes after echo when the cut bot has left, or after noise when nobody was cut', async () => {
  const { call, ws, ready, audio } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  startReply(ws('b'), 'aaaa bbbb', 2, 'ib');
  audio.t = 1;
  ws('a').emit('input_audio_buffer.speech_started');
  call.removeBot('b');
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: '' });
  assert.equal(call.nextTimer, null);
  assert.equal(call.cutBot, null);
  ws('a').emit('input_audio_buffer.speech_started');
  ws('a').emit('conversation.item.input_audio_transcription.completed', { transcript: '  ' });
  assert.equal(call.nextTimer, null);
  assert.equal(call.timeline.filter((e: any) => e.kind === 'echo').length, 0, 'empty speech is not logged as echo');
});

test('a bot repeating what was already said stops the round and waits for the host', async () => {
  const { call, ws, ready, runTimers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  speak(ws('a'), 'We should launch the pricing page next Tuesday.');
  runTimers();
  speak(ws('b'), 'Agreed, launch the pricing page next Tuesday.');
  assert.equal(call.waitingForHost, true);
  assert.equal(call.timeline.at(-1).text, 'Bot B repeated what was already said: waiting for you');
  assert.equal(ws('a').said().at(-1), '[Bot B]: Agreed, launch the pricing page next Tuesday.', 'the line was heard, so it is still passed on');
  const before = creates(ws('a'));
  runTimers();
  assert.equal(creates(ws('a')), before);
});

test('a bot that keeps using tools without speaking gets a few rounds, then the turn moves on', async () => {
  const { call, ws, ready, runTimers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
    const before = creates(ws('a'));
    useTool(ws('a'), 'add_task', { text: `task ${i}` });
    assert.equal(creates(ws('a')), before + 1, 'asked to speak');
  }
  const before = creates(ws('a'));
  useTool(ws('a'), 'add_task', { text: 'one too many' });
  assert.equal(creates(ws('a')), before, 'no more follow-ups');
  assert.equal(call.links.get('a').toolRounds, 0);
  runTimers();
  assert.equal(creates(ws('b')), 1, 'the turn goes to B');
});

test('a bot that speaks and uses a tool every round gets a few follow-ups, then the turn moves on', async () => {
  // A call with My Bot and X bot: X bot said a line and read something on every reply, and was asked to speak
  // again each time, so it kept talking with nobody else getting a turn.
  const { call, ws, ready, runTimers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  const lines = ['Catching up on the day.', 'Quiet afternoon here.', 'Following along with everyone.', 'Nothing new from me yet.'];
  for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
    const before = creates(ws('a'));
    useTool(ws('a'), 'list_tasks', {}, lines[i]);
    assert.equal(creates(ws('a')), before + 1, `follow-up ${i + 1} is given`);
  }
  const before = creates(ws('a'));
  useTool(ws('a'), 'list_tasks', {}, lines[3]);
  assert.equal(creates(ws('a')), before, 'no more follow-ups, even though it spoke');
  runTimers();
  assert.equal(creates(ws('b')), 1, 'the turn goes to B');
  // A new turn starts counting again.
  useTool(ws('a'), 'list_tasks', {}, 'A fresh point about the budget.');
  assert.equal(creates(ws('a')), before + 1);
});

test('a bot repeating itself while using a tool stops the round instead of getting a follow-up', async () => {
  const { call, ws, ready, runTimers } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  useTool(ws('a'), 'list_tasks', {}, 'Cost. Per-ticket spend, not speed.');
  const before = creates(ws('a'));
  useTool(ws('a'), 'list_tasks', {}, 'Cost. Per-ticket spend, not speed.');
  assert.equal(creates(ws('a')), before, 'no follow-up for a repeat');
  assert.equal(call.waitingForHost, true);
  assert.equal(call.timeline.at(-1).text, 'Bot A repeated what was already said: waiting for you');
  runTimers();
  assert.equal(creates(ws('b')), 0, 'nobody else is cued either');
});

test('no tool follow-up while the call waits for the host, or when the bot also passed', async () => {
  const { call, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  call.waitingForHost = true;
  const before = creates(ws('a'));
  useTool(ws('a'), 'add_task', { text: 'x' });
  assert.equal(creates(ws('a')), before);
  call.waitingForHost = false;
  ws('a').emit('response.created');
  ws('a').emit('response.function_call_arguments.done', { call_id: 'n', name: 'add_task', arguments: '{"text":"y"}' });
  ws('a').emit('response.function_call_arguments.done', { call_id: 'p', name: 'pass', arguments: '{}' });
  ws('a').emit('response.done', { response: { status: 'completed' } });
  assert.equal(creates(ws('a')), before, 'pass ends the turn: no follow-up');
  assert.equal(call.passes, 1);
});

// ---------- one-on-one: only the bot Shashank names talks; the others may suggest once it is over ----------

/** Shashank says `text` into the mic, heard by bot socket `s`. */
function hostSays(s: FakeSocket, text: string) {
  s.emit('input_audio_buffer.speech_started');
  s.emit('conversation.item.input_audio_transcription.completed', { transcript: text });
}
/** Runs one pending timer by id. */
/** Fires each new-try wait of a failing voice setup until the tries are used up. */
async function useUpRetries(timers: { fn: () => void; ms: number; id: number; done: boolean }[]) {
  for (let i = 0; i < SETUP_RETRY_MS.length; i++) {
    const t = timers.find((x) => !x.done && x.ms === SETUP_RETRY_MS[i]);
    assert.ok(t, `try ${i + 2} is waiting`);
    t.done = true;
    t.fn();
    await flush();
  }
}

function fire(timers: { fn: () => void; id: number; done: boolean }[], id: number) {
  const t = timers.find((x) => x.id === id)!;
  assert.equal(t.done, false, 'timer still pending');
  t.done = true;
  t.fn();
}
const three = async () => {
  const t = setup();
  t.call.join([bot('a'), bot('b'), bot('c')]);
  await t.ready('a');
  await t.ready('b');
  await t.ready('c');
  return t;
};

test('namedBots finds every bot named, without counting a name inside a longer one', () => {
  const bots = [{ id: 'm', name: 'My Bot' }, { id: 'b', name: 'Bot' }, { id: 'x', name: 'X' }, { id: 'e', name: '' }];
  assert.deepEqual(namedBots('My Bot, what do you think?', bots), ['m']);
  assert.deepEqual(namedBots('My Bot and Bot, compare', bots), ['m', 'b']);
  assert.deepEqual(namedBots('x and my bot', bots), ['m', 'x']);
  assert.deepEqual(namedBots('nobody here', bots), []);
});

test('isGroupAddress: talking to every bot', () => {
  for (const t of ['Everyone, thoughts?', 'what do you guys think', 'does anyone know', 'all of you, listen', 'what do you all say', "y'all ready"]) assert.equal(isGroupAddress(t), true, t);
  for (const t of ['that is all', 'tell me about it', '']) assert.equal(isGroupAddress(t), false, t);
});

test('isClosing: short "we are done" lines only', () => {
  for (const t of ['Thanks!', 'Thank you so much', 'got it, thanks', "That's all", 'perfect', 'Bot A, thanks', 'ok cool thanks guys', 'that makes sense']) {
    assert.equal(isClosing(t, ['Bot A']), true, t);
  }
  for (const t of ['', 'ok', 'great', 'thanks but what about teams', 'got it what next', 'thank you very much for all the help'.slice(0, 200)]) {
    assert.equal(isClosing(t), false, t);
  }
  assert.ok('thank you very much for all the help'.split(' ').length > CLOSING_MAX_WORDS);
});

test('focusText and suggestionPrompt: what each side of a one-on-one is told', () => {
  assert.equal(focusText('A', null), '');
  assert.match(focusText('A', 'A'), /talking with you one-on-one\. The other bots are listening and stay quiet/);
  assert.match(focusText('B', 'A'), /talking with A one-on-one\. Stay completely silent/);
  assert.match(groupInstructions('x', 'B', ['A', 'B'], [], [], null, 'A' as any), /# One-on-one right now/);
  assert.match(groupInstructions('x', 'B', ['A', 'B']), /When the host names one bot, that is a one-on-one/);
  const p = suggestionPrompt('Bot A');
  assert.match(p, /^\[Call\]: Shashank's one-on-one with Bot A just ended/);
  assert.match(p, /Otherwise call the pass tool without speaking: no "pass", no "silence"/);
});

test('one-on-one: only the named bot talks, follow-ups stay with it, then "thanks" opens a suggestion round and the call waits', async () => {
  const { call, ws, timers } = await three();
  hostSays(ws('a'), 'Bot A, how should we price the app?');
  assert.equal(call.focus, call.links.get('a'));
  assert.equal(call.view().focus, 'Bot A');
  assert.match(lastInstructions(ws('a')), /talking with you one-on-one/);
  assert.match(lastInstructions(ws('b')), /talking with Bot A one-on-one\. Stay completely silent/);
  assert.equal(call.timeline.find((e: any) => e.kind === 'focus').text, 'One-on-one with Bot A: the other bots stay quiet');
  speak(ws('a'), 'Start at five dollars a month.', 2);
  assert.equal(call.nextTimer, null, 'no other bot is cued');
  assert.deepEqual(call.view().bots.map((b: any) => b.status), ['speaking', 'quiet', 'quiet']);
  assert.equal(timers.find((t) => t.id === call.focusTimer)!.ms, 2000 + FOCUS_IDLE_MS);
  // a follow-up with no name stays in the one-on-one
  hostSays(ws('a'), 'and for teams?');
  assert.equal(call.focus, call.links.get('a'));
  assert.equal(call.focusTimer, null, 'him talking resets the quiet clock');
  speak(ws('a'), 'Teams pay twenty.', 1);
  assert.equal(call.nextTimer, null);
  // he wraps up; A answers, then the others get their turn to suggest
  hostSays(ws('a'), 'Got it, thanks');
  assert.equal(call.focusClosing, true);
  assert.equal(call.timeline.at(-1).text, 'You wrapped up with Bot A');
  speak(ws('a'), 'Happy to help.', 1);
  assert.ok(call.focus === null);
  assert.doesNotMatch(lastInstructions(ws('b')), /One-on-one right now/);
  assert.equal(call.timeline.at(-1).text, 'The others may now add a suggestion about your talk with Bot A');
  assert.equal(creates(ws('b')), 0);
  fire(timers, call.nextTimer);
  assert.equal(ws('b').said().at(-1), suggestionPrompt('Bot A'));
  assert.equal(creates(ws('b')), 1);
  useTool(ws('b'), 'pass', {});
  fire(timers, call.nextTimer);
  assert.equal(ws('c').said().at(-1), suggestionPrompt('Bot A'));
  speak(ws('c'), 'Consider a free tier for students.');
  assert.ok(call.suggesting === null);
  assert.equal(call.waitingForHost, true);
  assert.equal(call.timeline.at(-1).text, 'Suggestions done: waiting for you');
  assert.equal(call.nextTimer, null);
  assert.equal(call.passes, 0, 'passing in the round does not count toward "every bot passed"');
});

test('one-on-one ends by itself after a quiet spell, unless he or the bot is still going', async () => {
  const { call, ws, timers, setClock } = await three();
  hostSays(ws('a'), 'Bot A, a question');
  speak(ws('a'), 'Sure, go ahead.');
  const a = call.links.get('a');
  call.userSpeaking = true;
  fire(timers, call.focusTimer);
  assert.notEqual(call.focusTimer, null, 'he is talking: wait again');
  call.userSpeaking = false;
  a.active = true;
  fire(timers, call.focusTimer);
  a.active = false;
  a.pending = true;
  fire(timers, call.focusTimer);
  a.pending = false;
  setClock(100_000);
  call.micAudio(new Int16Array(10), 1); // loud a moment ago
  fire(timers, call.focusTimer);
  assert.ok(call.focus, 'still in the one-on-one');
  setClock(100_000 + USER_ACTIVE_MS);
  fire(timers, call.focusTimer);
  assert.ok(call.focus === null);
  assert.equal(call.timeline.at(-2).text, 'No reply for a while: the one-on-one with Bot A is over');
  assert.ok(call.suggesting);
});

test('addressing everyone or several bots ends the one-on-one and the group talk comes back', async () => {
  const { call, ws, timers } = await three();
  hostSays(ws('a'), 'Bot A, what do you think?');
  speak(ws('a'), 'I like it.');
  hostSays(ws('a'), 'What do you all think, everyone?');
  assert.ok(call.focus === null);
  assert.equal(call.timeline.at(-1).text.startsWith('One-on-one with Bot A ended'), true);
  speak(ws('a'), 'I still like it.');
  fire(timers, call.nextTimer);
  assert.equal(creates(ws('b')), 1, 'the round goes on to B');
  // two bots named: no one-on-one; the first named answers
  hostSays(ws('a'), 'Bot C and Bot B, compare these');
  assert.ok(call.focus === null);
  assert.equal(call.ear, call.links.get('c'));
  // one bot named but talking to everyone: no one-on-one either
  hostSays(ws('c'), 'Bot B, and everyone else, listen up');
  assert.ok(call.focus === null);
  // several named while in a one-on-one ends it
  hostSays(ws('b'), 'Bot B, one thing');
  assert.equal(call.focus, call.links.get('b'));
  hostSays(ws('b'), 'Bot A and Bot C, you too');
  assert.ok(call.focus === null);
});

test('naming another bot moves the one-on-one to it; a lone bot never gets one', async () => {
  const { call, ws } = await three();
  hostSays(ws('a'), 'Bot A, hi');
  hostSays(ws('a'), 'Bot B, your view?');
  assert.equal(call.focus, call.links.get('b'));
  assert.equal(call.ear, call.links.get('b'));
  assert.equal(call.timeline.filter((e: any) => e.kind === 'focus').length, 2);
  hostSays(ws('b'), 'Bot B, thanks'); // naming the same bot again while wrapping up
  assert.equal(call.focusClosing, true);
  hostSays(ws('b'), 'oh wait, one more thing');
  assert.equal(call.focusClosing, false, 'he kept going');

  const solo = setup();
  solo.call.join([bot('a')]);
  await solo.ready('a');
  hostSays(solo.ws('a'), 'Bot A, hi');
  assert.equal(solo.call.focus, null);
});

test('in a one-on-one the bot cannot hand the turn away, and another bot speaking does not take the mic', async () => {
  const { call, ws } = await three();
  hostSays(ws('a'), 'Bot A, plan this with me');
  useTool(ws('a'), 'hand_to', { name: 'Bot B' }, 'Let me ask B.');
  assert.match(outputs(ws('a')).at(-1).output, /talking with you one-on-one, so the other bots stay quiet/);
  assert.equal(call.nextTimer, null);
  speak(ws('c'), 'Hello, I just joined.'); // e.g. a bot A pulled in
  assert.equal(call.ear, call.links.get('a'));
  assert.equal(call.focus, call.links.get('a'));
});

test('spokenTo: only a name set off at the start of a sentence speaks to that bot', () => {
  const bots = [{ id: 'm', name: 'My Bot' }, { id: 'x', name: "Shashank's X bot" }, { id: 's', name: "Shashank's Bot" }];
  // the line from the call of 2026-11-11 17:15 UTC
  assert.equal(spokenTo("Shashank's X bot, Shashank wants you to check whether his X reach today is up from yesterday.", bots), 'x');
  assert.equal(spokenTo('Hey X bot, check the reach.', bots), 'x', 'short name after a greeting');
  assert.equal(spokenTo('Okay, My Bot: your turn', bots), 'm');
  assert.equal(spokenTo('Got it. X bot — pull the numbers.', bots), 'x', 'second sentence');
  assert.equal(spokenTo('Sure! And Shashank\'s Bot, you too?', bots), 's');
  for (const t of ["Shashank's Bot is here.", 'Bringing in My Bot.', 'Over to you, X bot.', 'Thanks, My Bot.', 'Hey, sure.', '', 'Bot, do it.', 'X bot can check that.']) {
    assert.equal(spokenTo(t, bots), null, t);
  }
});

test('in a one-on-one, the bot speaking to another bot by name passes the one-on-one to it, and that bot answers', async () => {
  const { call, ws, timers } = await three();
  hostSays(ws('a'), 'Bot A, tell C what it needs to do.');
  assert.equal(call.focus, call.links.get('a'));
  speak(ws('a'), 'Bot C, Shashank wants you to check the reach and report the numbers.', 2);
  assert.ok(call.nextTimer !== null, 'C is cued');
  assert.equal(timers.find((t) => t.id === call.nextTimer)!.ms, 2000 - NEXT_TURN_LEAD_MS);
  assert.equal(call.focus, call.links.get('a'), 'the one-on-one moves only when C starts');
  fire(timers, call.nextTimer);
  assert.equal(call.focus, call.links.get('c'));
  assert.equal(call.timeline.filter((e: any) => e.kind === 'focus').at(-1).text, 'One-on-one with Bot C: the other bots stay quiet');
  assert.match(lastInstructions(ws('c')), /talking with you one-on-one/);
  assert.match(lastInstructions(ws('a')), /talking with Bot C one-on-one\. Stay completely silent/);
  assert.equal(creates(ws('c')), 1, 'C answers without being named by the host');
  assert.equal(creates(ws('b')), 0);
  speak(ws('c'), 'On it.');
  assert.equal(call.nextTimer, null, 'back to the host, still one-on-one with C');
  hostSays(ws('c'), 'and yesterday?');
  assert.equal(call.focus, call.links.get('c'));
});

test('in a one-on-one, a hand-off by name is dropped when the host cuts in, and a bot only mentioned keeps the one-on-one', async () => {
  let t = await three();
  hostSays(t.ws('a'), 'Bot A, tell C.');
  speak(t.ws('a'), 'Bot C, check the reach.', 2);
  assert.notEqual(t.call.nextTimer, null);
  hostSays(t.ws('a'), 'wait, never mind');
  assert.equal(t.call.nextTimer, null, 'the cue is dropped');
  assert.equal(t.call.focus, t.call.links.get('a'), 'he cut in: still with A');
  assert.equal(creates(t.ws('c')), 0);

  t = await three();
  hostSays(t.ws('a'), 'Bot A, who else is here?');
  speak(t.ws('a'), 'Bot C is on the line too.', 1);
  assert.equal(t.call.nextTimer, null);
  assert.notEqual(t.call.focusTimer, null, 'the quiet clock runs as before');
  assert.equal(t.call.focus, t.call.links.get('a'));

  // C dropped before its cue: the one-on-one stays with A
  t = await three();
  hostSays(t.ws('a'), 'Bot A, tell C.');
  speak(t.ws('a'), 'Bot C, check the reach.', 2);
  t.call.links.get('c').ready = false;
  fire(t.timers, t.call.nextTimer);
  assert.equal(t.call.focus, t.call.links.get('a'));
  assert.equal(creates(t.ws('c')), 0);
  assert.notEqual(t.call.focusTimer, null, 'A keeps its quiet clock');
});

test('wantsAnswer: a question, a greeting, or calling Grok wants a reply; an acknowledgement does not', () => {
  for (const t of ['Hey Grok.', 'Hey Grok. Hey hey.', 'hi', 'Hello there', 'Are you there?', 'what about teams?']) assert.equal(wantsAnswer(t), true, t);
  for (const t of ['Okay, I get it.', 'Uh-huh.', "I'll let you know, I'll let you know.", 'You can say about it when it is ready.', 'Bot A, thanks', '', 'this is high']) {
    assert.equal(wantsAnswer(t), false, t);
  }
});

test('a bot that passes without a word on a line that wants a reply is asked once to answer', async () => {
  // Call of 2026-11-11 11:39: "Hey Grok." and "Hey Grok. Hey hey." were both met with a silent pass; the host had
  // to ask "Are you there?".
  const t = setup();
  t.call.join([bot('a')]);
  await t.ready('a');
  const ws = t.ws('a');
  hostSays(ws, 'Hey Grok.');
  useTool(ws, 'pass', {});
  assert.equal(ws.said().at(-1), '[Call]: Shashank spoke to you and is waiting. Answer him in one short spoken line; do not pass.');
  assert.equal(ws.types().at(-1), 'response.create');
  assert.equal(t.call.timeline.at(-1).text, 'Bot A passed on your line: asked it to answer');
  assert.equal(t.call.waitingForHost, false);
  const asked = creates(ws);
  useTool(ws, 'pass', {}); // passes again: once only
  assert.equal(creates(ws), asked);
  assert.equal(t.call.waitingForHost, true);
  // an acknowledgement: a silent pass is fine
  hostSays(ws, 'Okay, I get it.');
  useTool(ws, 'pass', {});
  assert.equal(creates(ws), asked);
  // a pass with words is an answer
  hostSays(ws, 'Hey there');
  useTool(ws, 'pass', {}, 'Hey Shashank.');
  assert.equal(creates(ws), asked);
  // he is already talking again: no ask
  hostSays(ws, 'hello?');
  t.call.userSpeaking = true;
  useTool(ws, 'pass', {});
  assert.equal(creates(ws), asked);
  t.call.userSpeaking = false;
  // typed lines count too
  t.call.sendText('Hey Grok, you there?');
  const typed = creates(ws);
  useTool(ws, 'pass', {});
  assert.equal(creates(ws), typed + 1);
});

test('naming a bot that is still joining: nobody else answers for it, and it answers once it is in', async () => {
  // Call of 2026-11-11 12:57: "Hey Xbot. Hey Xbot." while the X bot was connecting went to My Bot, which passed.
  const { call, ws, ready } = setup();
  call.join([bot('a')], [bot('a'), bot('b'), bot('c')]);
  await ready('a');
  useTool(ws('a'), 'invite_bot', { name: 'Bot B' }, 'Bringing in Bot B.');
  ws('a').emit('response.created');
  ws('a').emit('response.done', { response: { status: 'completed' } });
  const before = creates(ws('a'));
  hostSays(ws('a'), 'Hey Bot B, what was the reach yesterday?');
  assert.equal(call.links.get('a').suppressNext, true, "A's own automatic reply never plays");
  assert.equal(creates(ws('a')), before);
  assert.equal(call.timeline.at(-1).text, 'Bot B is still joining: it answers you once it is in');
  await ready('b');
  assert.deepEqual(ws('b').said().slice(-2), [
    '[Shashank (host)]: Hey Bot B, what was the reach yesterday?',
    '[Call]: You are in the call now. Shashank spoke to you while you were connecting: answer him in one short spoken line.',
  ]);
  assert.ok(!ws('b').said().some((x: string) => x.includes('Say a short hello')), 'its answer is its hello');
  assert.equal(creates(ws('b')), 1);
  assert.equal(call.invited.size, 0);
  assert.equal(call.links.get('b').owesHost, false);

  // typed, and in a one-on-one: the one-on-one ends, since he turned to another bot
  speak(ws('b'), 'About 1,492.');
  assert.equal(call.ear, call.links.get('b'), 'B spoke: the mic is on B');
  hostSays(ws('b'), 'Bot A, one thing');
  assert.equal(call.focus, call.links.get('a'));
  call.addBot(bot('c'));
  assert.equal(call.sendText('Bot C, hi'), true);
  assert.ok(call.focus === null);
  assert.equal(call.links.get('c').owesHost, true);
  // it fails to connect: a bot in the call tells him
  const aCreates = creates(ws('a'));
  call.links.get('c').fail(new Error('Timed out connecting.'));
  assert.equal(creates(ws('a')), aCreates + 1);
  assert.equal(call.links.get('c').owesHost, false);

  // a ready bot named too: the normal route
  const t = setup();
  t.call.join([bot('a')], [bot('a'), bot('b')]);
  await t.ready('a');
  t.call.addBot(bot('b'));
  hostSays(t.ws('a'), 'Bot A and Bot B, compare');
  assert.equal(t.call.links.get('b').owesHost ?? false, false);
});

test('one-on-one ends quietly when its bot leaves or drops', async () => {
  const { call, ws } = await three();
  hostSays(ws('a'), 'Bot A, hi');
  call.removeBot('a');
  assert.ok(call.focus === null);
  assert.ok(call.timeline.some((e: any) => e.text === 'One-on-one with Bot A ended: talking with everyone again'));
  hostSays(ws('b'), 'Bot B, hi');
  ws('b').onclose!(); // dropped: reconnecting
  assert.equal(call.sendText('anyone there?'), true);
  assert.ok(call.focus === null);
  assert.ok(call.suggesting === null);
});

test('suggestion round: wait_for_host ends it; late replies, bots that left, the host and the stop key are handled', async () => {
  let t = await three();
  const toRound = (x: typeof t) => {
    hostSays(x.ws('a'), 'Bot A, hi');
    hostSays(x.ws('a'), 'thanks');
    speak(x.ws('a'), 'Bye.');
    fire(x.timers, x.call.nextTimer); // B is asked
  };
  toRound(t);
  speak(t.ws('c'), 'A late line.'); // not C's turn yet: the round doesn't move
  assert.equal(t.call.suggesting.current, t.call.links.get('b'));
  useTool(t.ws('b'), 'wait_for_host', {});
  assert.ok(t.call.suggesting === null);
  assert.equal(t.call.waitingForHost, true);

  t = await three();
  toRound(t);
  t.call.removeBot('c');
  useTool(t.ws('b'), 'pass', {});
  assert.ok(t.call.suggesting === null, 'C left: nobody else to ask');

  t = await three();
  toRound(t);
  hostSays(t.ws('a'), 'actually, new topic'); // the mic is still on A
  assert.ok(t.call.suggesting === null, 'he took over');

  t = await three();
  toRound(t);
  t.call.stopAll();
  assert.ok(t.call.suggesting === null);

  // nobody else left to ask when the one-on-one ends
  t = await three();
  hostSays(t.ws('a'), 'Bot A, hi');
  t.call.removeBot('b');
  t.call.removeBot('c');
  hostSays(t.ws('a'), 'thanks');
  speak(t.ws('a'), 'Bye.');
  assert.ok(t.call.suggesting === null);
  assert.equal(t.call.waitingForHost, true);
});

test('echo cutting the one-on-one bot restarts the quiet clock; echo cutting a suggester moves the round on', async () => {
  const { call, ws, timers, audio } = await three();
  hostSays(ws('a'), 'Bot A, explain pricing');
  startReply(ws('a'), 'Pricing starts at five dollars for everyone', 4, 'ia');
  audio.t = 2;
  hostSays(ws('a'), 'five dollars for everyone');
  assert.notEqual(call.focusTimer, null);
  ws('a').emit('response.done', { response: { status: 'cancelled' } });
  hostSays(ws('a'), 'thanks');
  speak(ws('a'), 'Welcome.');
  fire(timers, call.nextTimer);
  startReply(ws('b'), 'You could add yearly plans with a discount', 4, 'ib');
  audio.t += 1;
  hostSays(ws('a'), 'yearly plans with a discount');
  assert.equal(call.suggesting.current, call.links.get('c'));
});

test('typing to one bot starts a one-on-one; typing "thanks" wraps it up; the stop key keeps it but stops the clock', async () => {
  const { call, ws } = await three();
  call.sendText('Bot B, quick question about launch');
  assert.equal(call.focus, call.links.get('b'));
  speak(ws('b'), 'Sure.');
  assert.notEqual(call.focusTimer, null);
  call.stopAll();
  assert.equal(call.focusTimer, null);
  assert.equal(call.focus, call.links.get('b'));
  call.sendText('thank you');
  assert.equal(call.focusClosing, true);
  call.leave();
  assert.ok(call.focus === null);
});

test('leaving mid one-on-one clears its quiet clock', async () => {
  const { call, ws, timers } = await three();
  hostSays(ws('a'), 'Bot A, hi');
  speak(ws('a'), 'Hi.');
  const id = call.focusTimer;
  call.leave();
  assert.equal(timers.find((x) => x.id === id)!.done, true);
});

// ---------- spoken passes, Grok Bot tools, and nothing ever stuck ----------

const SEND_TASK = { type: 'function', name: 'send_task', description: 'Send a job.', parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] } };
const SEARCH_TOOL = { type: 'function', name: 'search_conversations', description: 'Search.', parameters: { type: 'object', properties: { query: { type: 'string' } } } };
/** The newest pending timer of `ms`. */
const lastTimer = (timers: { ms: number; done: boolean; id: number }[], ms: number) => timers.filter((t) => t.ms === ms && !t.done).at(-1)!.id;
const two = async (opts: Parameters<typeof setup>[0] = {}) => {
  const t = setup(opts);
  t.call.join([bot('a'), bot('b')]);
  await t.ready('a');
  await t.ready('b');
  return t;
};
/** Bot socket `s` starts a reply: one second of audio, then `deltas` of transcript, without finishing. */
function startHeld(s: FakeSocket, deltas: string[], item = 'ib') {
  s.emit('response.created');
  s.emit('response.output_item.added', { item: { id: item } });
  s.emit('response.output_audio.delta', { delta: b64audio(1) });
  for (const d of deltas) s.emit('response.output_audio_transcript.delta', { delta: d });
}

test('spokenWords, isFiller and hasRealWords tell a spoken pass from real words', () => {
  assert.deepEqual(spokenWords('*stays silent* (pause) [beat] Okay. <x>y</x>'), ['okay']);
  for (const t of ['Pass.', 'Silence.', 'Push, pass.', 'Nothing to add from me.', 'No suggestion.', '*stays silent*', '(silence)', '[pass]', "I'll pass, Bot B.", '']) {
    assert.equal(isFiller(t, ['Bot B']), true, t);
  }
  // real answers, and a bot name that isn't in the call
  for (const t of ['No.', 'Okay.', 'I think we should pass the bill', 'Silence is golden', "I'll pass, Bot B."]) assert.equal(isFiller(t), false, t);
  assert.equal(hasRealWords('Pass, nothing from me'), false);
  assert.equal(hasRealWords('Pass on that, but pricing'), true);
  assert.equal(hasRealWords('Okay Bot B', ['Bot B']), false);
});

test('the rules that adapt Grok Bot\'s phone-call instructions to a group call', () => {
  const plain = groupRulesText(false);
  assert.match(plain, /There is no end_the_call here/);
  assert.match(plain, /Do not end a turn with a question just to keep the call going/);
  assert.match(plain, /Never say a tool's name, never say "pass" or "silence"/);
  assert.doesNotMatch(plain, /send_task/);
  assert.match(groupRulesText(true), /Its updates and its result come back on this call as work_landed entries/);
  assert.match(groupRulesText(true), /work_landed/);
  assert.match(groupRulesText(true), /Never tell Shashank to check the chat for a result/);
  assert.doesNotMatch(groupRulesText(true), /lands in your chat/);
  assert.match(plain, /No work_landed, work_overheard or user_message entries arrive on this call/, 'without send_task, nothing lands');
  assert.match(groupRulesText(true), /sent its agent a background job" message means that bot already has that work/);
  assert.doesNotMatch(plain, /background job/);
  const text = groupInstructions('BASE', 'A', ['A'], [], [], null, null, true);
  assert.ok(text.indexOf('# Group call rules') > text.indexOf('BASE'), 'after the bot\'s own instructions, so they win');
  assert.match(PASS_TOOL.description, /silent action: produce no speech/);
});

test('a turn the call starts holds the bot\'s voice: a spoken "Pass." is never heard and never passed on', async () => {
  const { call, ws, timers, audio } = await two();
  speak(ws('a'), 'Bot B, anything to add?', 1);
  fire(timers, call.nextTimer);
  const played = audio.played.length;
  startHeld(ws('b'), ['Pass.']);
  assert.equal(audio.played.length, played, 'held while it might be a pass');
  assert.equal(call.view().bots[1].status, 'thinking');
  ws('b').emit('response.done', { response: { status: 'completed' } });
  assert.equal(audio.played.length, played, 'never played');
  assert.ok(!ws('a').said().some((t: string) => t.includes('Pass')), 'never passed on');
  assert.equal(call.lines.at(-1).who, 'Bot A');
  assert.equal(call.timeline.find((e: any) => e.text.startsWith('Bot B passed')).text, 'Bot B passed (it said "Pass." out loud; not passed on)');
  assert.equal(call.passes, 1);
  // A spoke and the only other bot passed: the turn does not go back to A to say it again.
  assert.equal(call.nextTimer, null);
  assert.equal(call.waitingForHost, true);
  assert.equal(call.timeline.at(-1).text, 'The other bots had nothing to add: waiting for you');
});

test('held voice plays as soon as real words come, or at the end if the reply is short but real', async () => {
  const { call, ws, timers, audio } = await two();
  speak(ws('a'), 'Bot B, thoughts?', 1);
  fire(timers, call.nextTimer);
  const played = audio.played.length;
  startHeld(ws('b'), ['Pass on that, ']);
  assert.equal(audio.played.length, played);
  ws('b').emit('response.output_audio_transcript.delta', { delta: 'but pricing matters.' });
  assert.equal(audio.played.length, played + 1, 'released');
  ws('b').emit('response.output_audio.delta', { delta: b64audio(1) });
  assert.equal(audio.played.length, played + 2, 'the rest streams straight through');
  ws('b').emit('response.done', { response: { status: 'completed' } });
  assert.equal(ws('a').said().at(-1), '[Bot B]: Pass on that, but pricing matters.');
  // a short real reply whose words only come at the end
  fire(timers, call.nextTimer); // A's turn
  const before = audio.played.length;
  startHeld(ws('a'), [], 'ia');
  ws('a').emit('response.output_audio_transcript.done', { transcript: 'Okay.' });
  assert.equal(audio.played.length, before, 'still held: "Okay" alone could be a pass');
  ws('a').emit('response.done', { response: { status: 'completed' } });
  assert.equal(audio.played.length, before + 1, 'played once it was clearly not a pass');
  // a real-word transcript.done releases straight away
  fire(timers, call.nextTimer);
  startHeld(ws('b'), [], 'ib2');
  ws('b').emit('response.output_audio_transcript.done', { transcript: 'Shipping Friday works.' });
  assert.equal(call.links.get('b').holding, false);
});

test('held voice is dropped when the reply fails, says nothing, or the host cuts in', async () => {
  const { call, ws, timers, audio } = await two();
  speak(ws('a'), 'Bot B?', 1);
  fire(timers, call.nextTimer);
  const played = audio.played.length;
  startHeld(ws('b'), []);
  ws('b').emit('response.done', { response: { status: 'failed' } });
  assert.equal(audio.played.length, played);
  speak(ws('a'), 'Bot B, again?', 1);
  fire(timers, call.nextTimer);
  startHeld(ws('b'), []);
  ws('b').emit('response.done', { response: { status: 'completed' } }); // no words at all
  assert.equal(audio.played.length, played + 1, 'only A\'s second line played');
  speak(ws('a'), 'Bot B, last try?', 1);
  fire(timers, call.nextTimer);
  startHeld(ws('b'), []);
  ws('a').emit('input_audio_buffer.speech_started');
  assert.ok(!call.lines.some((l: any) => l.cut), 'nothing of B was heard, so nothing is passed on as cut off');
  ws('b').emit('response.output_audio.delta', { delta: b64audio(1) });
  ws('b').emit('response.done', { response: { status: 'cancelled' } });
  assert.equal(audio.played.length, played + 2);
});

test('a spoken "Pass." in an ordinary reply plays but is not passed on; with the pass tool it counts once', async () => {
  const { call, ws } = await two();
  hostSays(ws('a'), 'what do you think about the plan');
  speak(ws('a'), 'Pass.');
  assert.ok(!ws('b').said().some((t: string) => t.includes('Pass.')));
  assert.equal(call.passes, 1);
  useTool(ws('b'), 'pass', {}, 'Nothing to add.');
  assert.ok(!ws('a').said().some((t: string) => t.includes('Nothing to add')));
  assert.equal(call.waitingForHost, true, 'both bots passed in a row');
  useTool(ws('b'), 'pass', {}, 'Pass.', 'cancelled'); // cut off: no pass is counted
  assert.equal(call.passes, 2);
});

test('a reply that never starts is given up on and the talk moves on; a late start is cancelled', async () => {
  const { call, ws, timers } = await two();
  speak(ws('a'), 'Over to B.');
  fire(timers, call.nextTimer);
  fire(timers, lastTimer(timers, RESPONSE_START_MS));
  assert.equal(call.timeline.at(-1).text, 'Bot B never started its reply: moving on');
  assert.equal(call.links.get('b').pending, false);
  assert.notEqual(call.nextTimer, null, 'A is cued instead');
  ws('b').emit('response.created');
  assert.equal(ws('b').types().at(-1), 'response.cancel');
});

test('a reply that goes silent is stopped and the talk moves on; its late end changes nothing', async () => {
  const { call, ws, timers } = await two();
  speak(ws('a'), 'Over to B.');
  fire(timers, call.nextTimer);
  startHeld(ws('b'), ['Real words here.']);
  ws('b').emit('response.function_call_arguments.done', { call_id: 'x', name: 'pass', arguments: '{}' });
  assert.equal(timers.filter((t) => t.ms === RESPONSE_STALL_MS && !t.done).length, 1, 'each event restarts one watchdog');
  const lines = call.lines.length;
  fire(timers, lastTimer(timers, RESPONSE_STALL_MS));
  assert.equal(ws('b').types().at(-1), 'response.cancel');
  assert.equal(call.timeline.at(-1).text, 'Bot B went silent mid-reply: moving on');
  assert.notEqual(call.nextTimer, null);
  ws('b').emit('response.done', { response: { status: 'completed' } });
  assert.deepEqual(call.lines.slice(lines), [], 'the stalled reply is not passed on');
  // a reply that was already cut off only has its end confirmed: no "moving on"
  hostSays(ws('a'), 'Bot B, quick one'); // the mic moves to B
  ws('b').emit('response.created');
  ws('b').emit('input_audio_buffer.speech_started'); // he cuts B off
  const events = call.timeline.length;
  fire(timers, lastTimer(timers, RESPONSE_STALL_MS));
  assert.deepEqual(call.timeline.slice(events).map((e: any) => e.text), []);
  assert.equal(call.links.get('b').active, false, 'no longer stuck "active"');
});

test('a lost reply does not cue anyone while the host is talking', async () => {
  const { call, ws, timers } = await two();
  speak(ws('a'), 'Over to B.');
  fire(timers, call.nextTimer);
  call.userSpeaking = true;
  fire(timers, lastTimer(timers, RESPONSE_START_MS));
  assert.equal(call.nextTimer, null);
});

test('an error about the reply we asked for moves on at once; other errors change nothing', async () => {
  const { call, ws } = await two();
  const b = call.links.get('b');
  b.respond();
  ws('b').emit('error', { error: { message: 'busy', event_id: 'something-else' } });
  assert.equal(b.pending, true);
  ws('b').emit('error', { error: { event_id: b.pendingEventId } });
  assert.equal(b.pending, false);
  assert.equal(call.timeline.at(-1).text, 'Bot B could not start a reply (unknown error): moving on');
  ws('b').emit('error', {}); // nothing pending: ignored
  assert.equal(ws('b').sent.filter((m) => m.type === 'response.create').at(-1).event_id, b.pendingEventId);
});

test('a voice session that never comes up fails with the reason, and its socket closing is not a drop', async () => {
  const { call, ws, timers, mints } = setup();
  call.join([bot('a'), bot('b')]);
  await flush();
  ws('a').onopen!();
  ws('a').emit('error', { error: { message: 'bad voice' } }); // search refused, retried without it
  fire(timers, timers.find((t) => t.ms === CONNECT_TIMEOUT_MS && !t.done)!.id); // A's (the first armed)
  assert.equal(call.view().bots[0].status, 'error');
  assert.equal(call.view().bots[0].error, 'Voice setup was refused: bad voice');
  assert.equal(ws('a').closed, true);
  ws('a').onclose!();
  assert.equal(mints.filter((m: string) => m === 'a').length, 1, 'no reconnect');
  ws('b').onopen!();
  fire(timers, lastTimer(timers, CONNECT_TIMEOUT_MS));
  assert.equal(call.view().bots[1].error, 'Timed out connecting.');
});

test('setup refused: search goes first, then the bot\'s Grok Bot tools, then the bot fails with the reason', async () => {
  const { call, ws } = setup({ tools: (id) => (id === 'a' ? [SEND_TASK, SEARCH_TOOL] : []) });
  call.join([bot('a'), bot('b')]);
  await flush();
  ws('a').onopen!();
  const names = () => ws('a').sent.filter((m) => m.type === 'session.update').at(-1).session.tools.map((t: any) => t.name ?? t.type);
  assert.deepEqual(names().slice(-4), ['send_task', 'search_conversations', 'web_search', 'x_search']);
  assert.match(ws('a').sent[0].session.instructions, /send_task hands a job to your own agent/);
  ws('a').emit('error', { error: { message: 'no search' } });
  assert.deepEqual(names().slice(-2), ['send_task', 'search_conversations']);
  ws('a').emit('error', { error: { message: 'no tools' } });
  assert.ok(!names().includes('send_task'));
  assert.equal(call.timeline.at(-1).text, 'Bot A: its Grok Bot tools were refused, joining without them');
  ws('a').emit('error', { error: { message: 'still no' } });
  assert.equal(call.view().bots[0].error, 'Voice setup was refused: still no');
  // a bot with no Grok Bot tools fails right after search
  ws('b').onopen!();
  ws('b').emit('error', { error: { message: 'x' } });
  ws('b').emit('error', { error: { message: 'y' } });
  assert.equal(call.view().bots[1].error, 'Voice setup was refused: y');
});

test('a bot that drops mid-reply hands on its turn and the mic; an idle drop just reconnects', async () => {
  const { call, ws, timers, mints } = await two();
  speak(ws('a'), 'Over to B.');
  fire(timers, call.nextTimer);
  ws('b').emit('response.created');
  call.setEar(call.links.get('b'));
  ws('b').onclose!();
  assert.equal(call.timeline.at(-1).text, 'Bot B lost its connection: reconnecting');
  assert.equal(call.ear, call.links.get('a'), 'the mic moves to a bot that is up');
  assert.notEqual(call.nextTimer, null, 'A takes the turn');
  assert.equal(mints.filter((m: string) => m === 'b').length, 2);
  call.stopNext();
  ws('a').onclose!(); // idle, and no other bot is up: the mic stays, nobody is cued
  assert.equal(call.nextTimer, null);
  assert.equal(call.ear, call.links.get('a'));
});

test('a bot that fails mid-reply hands on its turn and ends a one-on-one with it', async () => {
  const { call, ws, timers } = await three();
  hostSays(ws('a'), 'Bot B, a question');
  assert.equal(call.focus, call.links.get('b'));
  call.links.get('b').respond();
  call.links.get('b').fail(new Error('No usage left'));
  assert.ok(call.focus === null);
  assert.equal(call.view().bots[1].error, 'No usage left');
  assert.notEqual(call.nextTimer, null);
  fire(timers, call.nextTimer);
});

test('a bot picked for the next turn that dropped meanwhile is skipped', async () => {
  const { call, ws, timers } = await three();
  speak(ws('a'), 'Over to B.');
  ws('b').onclose!(); // idle drop: reconnecting
  const before = creates(ws('c'));
  fire(timers, call.nextTimer); // B is not up: the turn goes past it
  fire(timers, call.nextTimer);
  assert.equal(creates(ws('c')), before + 1);
});

test('send_task: the bot\'s words count at once, its job goes to Grok Bot, and its turn ends when the receipt comes', async () => {
  const { call, ws, toolCalls } = await two({ tools: () => [SEND_TASK, SEARCH_TOOL] });
  hostSays(ws('a'), 'check my mail please');
  ws('a').emit('response.created');
  ws('a').emit('response.output_audio_transcript.done', { transcript: 'Checking your inbox now.' });
  ws('a').emit('response.function_call_arguments.done', { call_id: 't1', name: 'send_task', arguments: JSON.stringify({ request: 'Check the inbox' }) });
  ws('a').emit('response.done', { response: { status: 'completed' } });
  assert.equal(ws('b').said().at(-1), '[Bot A]: Checking your inbox now.');
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].id, 'a');
  assert.match(toolCalls[0].req.callId, /^[0-9a-f-]{36}-a$/);
  assert.deepEqual(
    { ...toolCalls[0].req, callId: 'x' },
    { callId: 'x', name: 'send_task', input: { request: 'Check the inbox' }, line: { theyJustTalked: true, newsOwed: false, receiptOwed: false, alreadySpokeThisTurn: true } },
  );
  assert.equal(call.timeline.at(-1).text, 'Bot A sent a job to its agent: "Check the inbox"');
  assert.equal(call.view().bots[0].status, 'thinking');
  assert.equal(outputs(ws('a')).length, 0, 'no output until Grok Bot answers');
  assert.equal(call.nextTimer, null, 'nobody else is cued meanwhile');
  const before = creates(ws('a'));
  toolCalls[0].resolve({ kind: 'served', output: { receipt: 'under way' } });
  await flush();
  assert.deepEqual(outputs(ws('a')).at(-1), { type: 'function_call_output', call_id: 't1', output: '{"receipt":"under way"}' });
  assert.equal(creates(ws('a')), before, 'it already said its line: no follow-up');
  assert.notEqual(call.nextTimer, null, 'the turn goes on');
  // the same job again is not sent twice
  useTool(ws('a'), 'send_task', { request: 'check the INBOX!' });
  await flush();
  assert.equal(toolCalls.length, 1);
  assert.match(outputs(ws('a')).at(-1).output, /^Not sent again: that same job is already under way/);
  assert.equal(creates(ws('a')), before + 1, 'said nothing, so it gets to speak');
});

test('search_conversations: the bot speaks once the result is in; refusals and failures are told to the bot', async () => {
  const { call, ws, toolCalls } = await two({ tools: () => [SEND_TASK, SEARCH_TOOL] });
  let before = creates(ws('a'));
  useTool(ws('a'), 'search_conversations', { query: 'launch date' });
  assert.equal(call.timeline.at(-1).text, 'Bot A searched its past chats for "launch date"');
  toolCalls[0].resolve({ kind: 'served', output: { hits: [{ text: 'Tuesday' }], more: false } });
  await flush();
  assert.equal(outputs(ws('a')).at(-1).output, '{"hits":[{"text":"Tuesday"}],"more":false}');
  assert.equal(creates(ws('a')), before + 1, 'speaks the answer');
  ws('a').emit('response.created');
  ws('a').emit('response.done', { response: { status: 'completed' } });
  const cases: [(t: ToolReq) => void, RegExp, RegExp][] = [
    [(t) => t.resolve({ kind: 'invalid_input', output: { error: 'missing request' } }), /^Not done: missing request\.$/, /send_task was refused \(missing request\)/],
    [(t) => t.resolve({ kind: 'unknown_tool', output: null }), /^Not done: unknown tool\.$/, /send_task was refused \(unknown tool\)/],
    [(t) => t.resolve({ kind: 'served' }), /^\{\}$/, /sent a job/],
    [(t) => t.reject(new Error('did not answer within 20 s')), /^Not done: did not answer within 20 s\. Tell Shashank in a few words/, /send_task failed \(did not answer within 20 s\)/],
    [(t) => t.reject(new Error('')), /^Not done: no answer\./, /send_task failed \(no answer\)/],
  ];
  cases.forEach(([answer, output, event], i) => {
    useTool(ws('a'), 'send_task', `{"request":"job ${i}"}`);
    answer(toolCalls.at(-1)!);
  });
  await flush();
  // answered in order: check each output and event
  const outs = outputs(ws('a')).slice(-cases.length).map((o: any) => o.output);
  cases.forEach(([, output], i) => assert.match(outs[i], output, String(output)));
  for (const [, , event] of cases) assert.ok(call.timeline.some((e: any) => event.test(e.text)), String(event));
  before = toolCalls.length;
  useTool(ws('a'), 'send_task', '{oops');
  assert.deepEqual(toolCalls.at(-1)!.req.input, {}, 'bad arguments are sent as none');
  useTool(ws('a'), 'something_else', {});
  assert.equal(toolCalls.length, before + 1, 'only the bot\'s own tools go to Grok Bot');
});

test('search_conversations every round: the bot gets a few follow-ups, then the other bot speaks', async () => {
  const { ws, toolCalls, runTimers } = await two({ tools: () => [SEARCH_TOOL] });
  const lines = ['Hey Shashank. Just catching up on the day.', 'Hey Shashank. Catching up on where things left off.', 'Not much going on.', 'Quiet afternoon.'];
  let asked = 0;
  for (const line of lines) {
    const before = creates(ws('a'));
    useTool(ws('a'), 'search_conversations', { query: 'today' }, line);
    toolCalls.at(-1)!.resolve({ kind: 'served', output: { hits: [] } });
    await flush();
    asked += creates(ws('a')) - before;
  }
  assert.equal(asked, MAX_TOOL_ROUNDS, 'only a few follow-ups in a row');
  runTimers();
  assert.equal(creates(ws('b')), 1, 'then the other bot gets its turn');
});

test('while a tool runs: the host can cut in and is answered once the result is in; nothing else is asked for', async () => {
  const { call, ws, toolCalls, timers } = await two({ tools: () => [SEARCH_TOOL] });
  useTool(ws('a'), 'search_conversations', { query: 'x' });
  const a = call.links.get('a');
  assert.equal(a.toolsBusy, true);
  const before = creates(ws('a'));
  hostSays(ws('a'), 'and the calendar too');
  assert.equal(a.queued, '', 'its reply waits for the tool');
  assert.equal(creates(ws('a')), before);
  a.expectReply();
  fire(timers, a.replyTimer);
  assert.equal(creates(ws('a')), before, 'no nudge while the tool runs');
  toolCalls[0].resolve({ kind: 'served', output: { hits: [] } });
  await flush();
  assert.equal(creates(ws('a')), before + 1, 'answered once, with the result in hand');
  assert.equal(call.nextTimer, null);
});

test('a tool result for a connection that dropped is thrown away; cut-off and refused tools never reach Grok Bot', async () => {
  const t = await two({ tools: () => [SEND_TASK] });
  useTool(t.ws('a'), 'send_task', { request: 'a job' });
  const old = t.ws('a');
  old.onclose!();
  assert.equal(t.call.links.get('a').toolsBusy, false);
  await t.ready('a');
  t.toolCalls[0].resolve({ kind: 'served', output: {} });
  await flush();
  assert.equal(outputs(old).length, 0);
  assert.equal(outputs(t.ws('a')).length, 0);
  useTool(t.ws('a'), 'send_task', { request: 'cut job' }, 'On it.', 'cancelled');
  assert.match(outputs(t.ws('a')).at(-1).output, /cut off before anyone heard it/);
  t.call.links.get('a').harness = false;
  useTool(t.ws('a'), 'send_task', { request: 'another' });
  assert.match(outputs(t.ws('a')).at(-1).output, /^Unknown tool "send_task"/);
  assert.equal(t.toolCalls.length, 1);
  const a = t.call.links.get('a');
  a.queued = 'x';
  a.ready = false;
  a.flushQueued();
  assert.equal(a.queued, 'x', 'not sent while the bot is down');
});

test('a Grok Bot tool the call has no special words for is still forwarded and logged', async () => {
  const PEEK = { ...SEARCH_TOOL, name: 'peek_runs' };
  const { call, ws, toolCalls } = await two({ tools: () => [PEEK] });
  useTool(ws('a'), 'peek_runs', {});
  assert.equal(call.timeline.at(-1).text, 'Bot A used peek_runs');
  assert.equal(toolCalls[0].req.name, 'peek_runs');
  toolCalls[0].resolve({ kind: 'served', output: { runs: [] } });
  await flush();
  assert.equal(outputs(ws('a')).at(-1).output, '{"runs":[]}');
});

test('naming a bot that already has a reply coming queues the request instead of asking twice', async () => {
  const { call, ws, timers } = await two();
  const b = call.links.get('b');
  b.respond(); // e.g. its turn was just asked for
  const before = creates(ws('b'));
  call.sendText('Bot B, and one more thing'); // the cut-in cancels B's pending reply first, so B is asked now
  assert.equal(creates(ws('b')), before + 1);
  b.respondWhenFree('again');
  assert.equal(b.queued, 'again', 'already pending: queued, not asked twice');
  assert.equal(creates(ws('b')), before + 1);
  // that pending reply never starts: the host's queued request is asked for instead of moving the turn on
  fire(timers, lastTimer(timers, RESPONSE_START_MS));
  assert.equal(call.timeline.at(-1).text, 'Bot B never started its reply: asking it again');
  assert.equal(creates(ws('b')), before + 2);
  assert.equal(b.queued, null);
  assert.equal(call.nextTimer, null, 'the turn did not move on');
  // Leave while B is mid-reply and its cancel is never confirmed: the summary request waits, then goes out
  ws('b').emit('response.created');
  const wrap = call.wrapUp(); // cuts B off, and queues the summary request behind B's reply
  assert.match(b.queued, /is ending this group voice call now/);
  fire(timers, lastTimer(timers, RESPONSE_STALL_MS));
  assert.equal(creates(ws('b')), before + 3);
  assert.match(ws('b').sent.filter((m) => m.type === 'response.create').at(-1).response.instructions, /Call the save_summary tool once/);
  call.leave();
  assert.ok(await wrap);
});

test('a refused reply that the host was waiting on is asked for again', async () => {
  const { call, ws } = await two();
  const b = call.links.get('b');
  b.respond();
  b.queued = '';
  ws('b').emit('error', { error: { message: 'busy', event_id: b.pendingEventId } });
  assert.equal(call.timeline.at(-1).text, 'Bot B could not start a reply (busy): asking it again');
  assert.equal(b.pending, true, 'asked again');
});

test('a turn decision made in a reply whose tool result came after the host cut in is dropped', async () => {
  const { call, ws, toolCalls } = await two({ tools: () => [SEARCH_TOOL] });
  ws('a').emit('response.created');
  ws('a').emit('response.function_call_arguments.done', { call_id: 's', name: 'search_conversations', arguments: '{"query":"x"}' });
  ws('a').emit('response.function_call_arguments.done', { call_id: 'h', name: 'hand_to', arguments: '{"name":"Bot B"}' });
  ws('a').emit('response.done', { response: { status: 'completed' } });
  assert.deepEqual(call.links.get('a').turn, { kind: 'hand', target: 'b' });
  call.stopAll();
  toolCalls[0].resolve({ kind: 'served', output: {} });
  await flush();
  assert.equal(call.links.get('a').turn, null);
  assert.equal(call.nextTimer, null);
});

test('Leave: a summary reply that uses a Grok Bot tool gets its result but no turn afterwards', async () => {
  const { call, ws, toolCalls } = await two({ tools: () => [SEARCH_TOOL] });
  speak(ws('a'), 'Hi.');
  void call.wrapUp();
  const creates = () => ws('b').types().filter((t: string) => t === 'response.create').length;
  const before = creates();
  ws('b').emit('response.created');
  ws('b').emit('response.function_call_arguments.done', { call_id: 's', name: 'search_conversations', arguments: '{"query":"x"}' });
  ws('b').emit('response.done', { response: { status: 'completed' } });
  toolCalls[0].resolve({ kind: 'served', output: {} });
  await flush();
  assert.equal(outputs(ws('b')).at(-1).call_id, 's', 'the tool result is sent');
  assert.equal(creates(), before, 'no follow-up reply while leaving');
  assert.equal(call.links.get('b').turn, null);
  call.leave();
});

test('a Grok Bot session request that hangs times out; its late answer or failure is ignored', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { call, ws, timers, sockets } = setup({ mintWait: (id) => (id === 'a' ? gate : undefined), mintFail: (id) => (id === 'c' ? new Error('late no') : null) });
  call.join([bot('a')]);
  await flush();
  fire(timers, lastTimer(timers, CONNECT_TIMEOUT_MS));
  assert.equal(call.view().bots[0].error, 'Timed out connecting.');
  release();
  await flush();
  assert.equal(sockets.get('a'), undefined, 'no socket is opened for the timed-out session');
  // a failure that comes after the timeout is not reported twice
  let releaseC!: () => void;
  const gateC = new Promise<void>((r) => (releaseC = r));
  const t2 = setup({ mintWait: () => gateC, mintFail: () => new Error('late no') });
  t2.call.join([bot('c')]);
  await flush();
  fire(t2.timers, lastTimer(t2.timers, CONNECT_TIMEOUT_MS));
  const errors = t2.call.timeline.filter((e: any) => e.kind === 'error').length;
  releaseC();
  await flush();
  assert.equal(t2.call.timeline.filter((e: any) => e.kind === 'error').length, errors);
  assert.equal(t2.call.view().bots[0].error, 'Timed out connecting.');
  void ws;
});


test('duplicate jobs in one reply are submitted only once while the first receipt is pending', async () => {
  const { call, ws, toolCalls } = await two({ tools: () => [SEND_TASK] });
  const s = ws('a');
  s.emit('response.created');
  for (const [id, request] of [['one', 'Check the inbox'], ['two', 'check the INBOX!']]) {
    s.emit('response.function_call_arguments.done', { call_id: id, name: 'send_task', arguments: JSON.stringify({ request }) });
  }
  s.emit('response.done', { response: { status: 'completed' } });
  assert.equal(toolCalls.length, 1, 'one external job, even before its receipt arrives');
  toolCalls[0].resolve({ kind: 'served', output: { receipt: 'started' } });
  await flush();
  assert.equal(outputs(s).length, 2, 'both tool calls get an answer');
  assert.match(outputs(s)[1].output, /Not sent again/);
  assert.equal(call.links.get('a').toolsBusy, false);
});

test('a refused job can be corrected and submitted again', async () => {
  const { ws, toolCalls } = await two({ tools: () => [SEND_TASK] });
  useTool(ws('a'), 'send_task', { request: 'Check the inbox' });
  toolCalls[0].resolve({ kind: 'invalid_input', output: { error: 'try again' } });
  await flush();
  useTool(ws('a'), 'send_task', { request: 'Check the inbox' });
  assert.equal(toolCalls.length, 2);
  toolCalls[1].resolve({ kind: 'served', output: {} });
  await flush();
});

test('events from a replaced voice socket cannot speak or invoke plugins in the new session', async () => {
  const { call, ws, ready, toolCalls } = await two({ tools: () => [SEND_TASK] });
  const old = ws('a');
  old.onclose!();
  await ready('a');
  const before = call.lines.length;
  const oldSent = old.sent.length;
  old.onopen!(); // a delayed open notification must not configure the dead socket
  assert.equal(old.sent.length, oldSent);
  useTool(old, 'send_task', { request: 'Stale job' }, 'Old connection speaking.');
  assert.equal(call.lines.length, before);
  assert.equal(toolCalls.length, 0);
  assert.equal(call.links.get('a').active, false);
  assert.equal(outputs(ws('a')).length, 0);
});


test('plugin failure after a spoken acknowledgement gets a follow-up to report the failure', async () => {
  for (const refused of [true, false]) {
    const { ws, toolCalls } = await two({ tools: () => [SEND_TASK] });
    useTool(ws('a'), 'send_task', { request: 'Check mail' }, 'I will check your mail.');
    const before = creates(ws('a'));
    if (refused) toolCalls[0].resolve({ kind: 'invalid_input', output: { error: 'Unavailable' } });
    else toolCalls[0].reject(new Error('Unavailable'));
    await flush();
    assert.equal(creates(ws('a')), before + 1, 'the bot must report that the acknowledged job failed');
  }
});

test('note tools are unavailable and cannot change call state; task tools remain', async () => {
  const { call, ws } = await two();
  const names = ws('a').sent[0].session.tools.map((t: any) => t.name);
  assert.ok(!names.includes('write_note') && !names.includes('read_notes'));
  for (const name of ['add_task', 'done_task', 'list_tasks']) assert.ok(names.includes(name));
  for (const name of ['write_note', 'read_notes']) {
    useTool(ws('a'), name, { text: 'irrelevant' });
    assert.match(outputs(ws('a')).at(-1).output, /Unknown tool/);
  }
  assert.deepEqual(call.notes, []);
  assert.equal(call.notepadVersion, 0);
});

test('bots with direct app tools are told to discover apps and return results on the call', async () => {
  const apps = ['list_connected_apps', 'find_app_tools', 'use_app_tool'].map((name) => ({ ...SEARCH_TOOL, name }));
  const { ws } = await two({ tools: () => [SEND_TASK, ...apps] });
  const instructions = ws('a').sent[0].session.instructions;
  assert.match(instructions, /list_connected_apps/);
  assert.match(instructions, /find_app_tools/);
  assert.match(instructions, /use_app_tool/);
  assert.match(instructions, /results return directly to this call/);
  assert.match(instructions, /Do not claim you lack app access/);
  assert.match(instructions, /Do not retry.*automatically/);
});

test('an app execution failure warns that the outcome may be unknown instead of claiming nothing happened', async () => {
  const { ws, toolCalls } = await two({ tools: () => [{ ...SEARCH_TOOL, name: 'use_app_tool' }] });
  useTool(ws('a'), 'use_app_tool', { app: 'Mail', tool: 'send', arguments: {} });
  toolCalls[0].reject(new Error('Timed out'));
  await flush();
  assert.match(outputs(ws('a')).at(-1).output, /may have completed/);
  assert.match(outputs(ws('a')).at(-1).output, /Do not repeat it automatically/);
  assert.doesNotMatch(outputs(ws('a')).at(-1).output, /did not go through/);
});

test('a bot working through a connected app gets enough follow-ups to finish, then the turn moves on with a timeline note', async () => {
  // Call of 2026-11-11 09:13: My Bot searched T3 Code's tools 4 times in a row, was not asked to speak after the
  // 4th result, and went silent. Creating a chat and sending it a prompt takes more steps than that.
  const apps = ['list_connected_apps', 'find_app_tools', 'use_app_tool'].map((name) => ({ ...SEARCH_TOOL, name }));
  const { call, ws, toolCalls, runTimers } = await two({ tools: () => apps });
  const steps: [string, object][] = [
    ['list_connected_apps', {}],
    ['find_app_tools', { app: 'T3 Code', query: 'threads' }],
    ['find_app_tools', { app: 'T3 Code', query: 'create chat' }],
    ['find_app_tools', { app: 'T3 Code', query: 'send prompt' }],
    ['use_app_tool', { app: 'T3 Code', tool: 'create_threads', arguments: {} }],
    ['use_app_tool', { app: 'T3 Code', tool: 't3_thread_send', arguments: {} }],
    ['find_app_tools', { app: 'T3 Code', query: 'status' }],
    ['use_app_tool', { app: 'T3 Code', tool: 'task_status', arguments: {} }],
  ];
  assert.equal(steps.length, MAX_APP_TOOL_ROUNDS);
  for (const [name, args] of steps) {
    const before = creates(ws('a'));
    useTool(ws('a'), name, args);
    toolCalls.at(-1)!.resolve({ kind: 'served', output: { ok: true } });
    await flush();
    assert.equal(creates(ws('a')), before + 1, `asked to speak after ${name}`);
  }
  const before = creates(ws('a'));
  useTool(ws('a'), 'find_app_tools', { app: 'T3 Code', query: 'again' });
  toolCalls.at(-1)!.resolve({ kind: 'served', output: { ok: true } });
  await flush();
  assert.equal(creates(ws('a')), before, 'no more follow-ups');
  assert.equal(call.timeline.at(-1).text, `Bot A used tools ${MAX_APP_TOOL_ROUNDS + 1} times in a row: its turn moved on`);
  runTimers();
  assert.equal(creates(ws('b')), 1, 'the turn goes to B');
});

test('a bot mixing app work with other tools keeps the smaller follow-up limit for the other tools', async () => {
  const tools = ['find_app_tools', 'search_conversations'].map((name) => ({ ...SEARCH_TOOL, name }));
  const { call, ws, toolCalls } = await two({ tools: () => tools });
  for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
    useTool(ws('a'), 'find_app_tools', { app: 'Mail' });
    toolCalls.at(-1)!.resolve({ kind: 'served', output: {} });
    await flush();
  }
  const before = creates(ws('a'));
  useTool(ws('a'), 'search_conversations', { query: 'x' });
  toolCalls.at(-1)!.resolve({ kind: 'served', output: { hits: [] } });
  await flush();
  assert.equal(creates(ws('a')), before, 'a non-app round past the small limit gets no follow-up');
  assert.equal(call.timeline.at(-1).text, `Bot A used tools ${MAX_TOOL_ROUNDS + 1} times in a row: its turn moved on`);
});

const JOB_NOTE = (who: string, job: string) => `[Call]: ${who} sent its agent a background job: "${job}"`;

test('a background job one bot sent is announced to every other bot once, so they do not send the same job again', async () => {
  // Call of 2026-11-10 18:16: X bot sent a reach job, the others heard only "[X bot]: On reach," and sent the same job twice more.
  const t = setup({ tools: () => [SEND_TASK] });
  t.call.join([bot('a'), bot('b'), bot('c')]);
  for (const id of ['a', 'b', 'c']) await t.ready(id);
  const { ws, toolCalls } = t;
  const note = JOB_NOTE('Bot A', 'Look into the X post reach. Report back.');
  useTool(ws('a'), 'send_task', { request: '  Look into   the X post reach.\n Report back. ' }, 'On reach,');
  assert.ok(ws('b').said().includes('[Bot A]: On reach,'));
  assert.ok(!ws('b').said().includes(note), 'not before Grok Bot accepted the job');
  toolCalls.at(-1)!.resolve({ kind: 'served', output: { relay: 'accepted' } });
  await flush();
  for (const id of ['b', 'c']) assert.deepEqual(ws(id).said().filter((s: string) => s === note), [note], `Bot ${id} is told once`);
  assert.ok(!ws('a').said().some((s: string) => s.includes('background job')), 'the sender is not told about its own job');
  const calls = toolCalls.length;
  useTool(ws('a'), 'send_task', { request: 'look into the x post reach report back' });
  await flush();
  assert.equal(toolCalls.length, calls, 'the same job again is blocked');
  for (const id of ['b', 'c']) assert.equal(ws(id).said().filter((s: string) => s.includes('background job')).length, 1, 'and not announced again');
  const long = 'word '.repeat(100);
  useTool(ws('b'), 'send_task', { request: long });
  toolCalls.at(-1)!.resolve({ kind: 'served', output: { relay: 'accepted' } });
  await flush();
  assert.equal(ws('a').said().at(-1), JOB_NOTE('Bot B', long.trim().slice(0, 200)), 'a long job is cut like the timeline');
  assert.ok(ws('c').said().includes(JOB_NOTE('Bot B', long.trim().slice(0, 200))));
});

test('refused, failed and blocked jobs, and other Grok Bot tools, are not announced as jobs', async () => {
  const { ws, toolCalls } = await two({ tools: () => [SEND_TASK, SEARCH_TOOL] });
  useTool(ws('a'), 'send_task', { request: 'job one' });
  toolCalls.at(-1)!.resolve({ kind: 'invalid_input', output: { error: 'missing request' } });
  await flush();
  useTool(ws('a'), 'send_task', { request: 'job two' });
  toolCalls.at(-1)!.resolve({ kind: 'unknown_tool', output: null });
  await flush();
  useTool(ws('a'), 'send_task', { request: 'job three' });
  toolCalls.at(-1)!.reject(new Error('did not answer within 20 s'));
  await flush();
  useTool(ws('a'), 'search_conversations', { query: 'reach' });
  toolCalls.at(-1)!.resolve({ kind: 'served', output: { hits: [] } });
  await flush();
  useTool(ws('a'), 'send_task', '{oops');
  toolCalls.at(-1)!.resolve({ kind: 'invalid_input', output: { error: 'missing request' } });
  await flush();
  assert.ok(!ws('b').said().some((s: string) => s.includes('background job')));
});

test('a bot that left before the job was accepted is not told about it', async () => {
  const t = setup({ tools: () => [SEND_TASK] });
  t.call.join([bot('a'), bot('b'), bot('c')]);
  for (const id of ['a', 'b', 'c']) await t.ready(id);
  const { call, ws, toolCalls } = t;
  useTool(ws('a'), 'send_task', { request: 'check the reach' });
  call.removeBot('c');
  const before = ws('c').said().length;
  toolCalls.at(-1)!.resolve({ kind: 'served', output: { relay: 'accepted' } });
  await flush();
  assert.equal(ws('c').said().length, before);
  assert.ok(ws('b').said().includes(JOB_NOTE('Bot A', 'check the reach')));
});

test('with connected apps, app work goes to the app tools and never to send_task, in the rules and in the tool itself', async () => {
  // Call of 2026-11-11 11:42: X bot had the X app tools but sent 3 background jobs for its own post stats; job results
  // never come back on the call. Our own rule even said send_task covers "connected apps".
  const both = groupRulesText(true, true);
  assert.doesNotMatch(both, /connected apps\. Its result/, 'send_task no longer claims connected apps');
  assert.match(both, /Never send_task anything a connected app can do/);
  assert.match(both, /even when a search came up empty/);
  assert.ok(both.indexOf('list_connected_apps') < both.indexOf('send_task hands'), 'the app rule comes first');
  assert.match(both, /results return directly to this call/);
  const tasksOnly = groupRulesText(true, false);
  assert.match(tasksOnly, /browser, mail and connected apps\. Its updates and its result come back on this call/, 'without app tools, the agent is the only way to apps');
  assert.match(both, /It is slower than the app tools/);
  assert.match(both, /whenever Shashank asks for it to be done on his computer \(a terminal command such as gh or git/);
  assert.match(both, /pass without a word/);
  assert.doesNotMatch(tasksOnly, /list_connected_apps|Never send_task/);
  const appsOnly = groupRulesText(false, true);
  assert.match(appsOnly, /list_connected_apps/);
  assert.doesNotMatch(appsOnly, /send_task/);

  const raw = [SEND_TASK, SEARCH_TOOL, ...['list_connected_apps', 'find_app_tools', 'use_app_tool'].map((name) => ({ ...SEARCH_TOOL, name }))];
  const copy = structuredClone(raw);
  const tools = callHarnessTools(raw);
  assert.deepEqual(raw, copy, 'the bot\'s own tool list is not changed');
  assert.equal(tools[0].description.indexOf(SEND_TASK.description), 0, 'Grok\'s words stay first');
  assert.match(tools[0].description, /never for anything a connected app can do/);
  assert.match(tools[1].description, /comes from use_app_tool, not send_task/);
  assert.deepEqual(tools.slice(2), raw.slice(2), 'other tools are untouched');
  assert.deepEqual({ ...tools[0], description: '' }, { ...raw[0], description: '' }, 'only the description changes');
  assert.deepEqual(callHarnessTools([SEND_TASK, SEARCH_TOOL]), [SEND_TASK, SEARCH_TOOL], 'without app tools nothing changes');
  assert.deepEqual(callHarnessTools([]), []);

  // What the voice session actually gets.
  const { ws } = await two({ tools: () => raw });
  const sent = ws('a').sent[0].session.tools;
  assert.match(sent.find((t: any) => t.name === 'send_task').description, /never for anything a connected app can do/);
  assert.match(ws('a').sent[0].session.instructions, /Never send_task anything a connected app can do/);
});

test('a bot without app tools keeps Grok\'s own send_task description', async () => {
  const { ws } = await two({ tools: () => [SEND_TASK] });
  assert.deepEqual(ws('a').sent[0].session.tools.find((t: any) => t.name === 'send_task'), SEND_TASK);
});

test('the apps connected when a bot joins are in its rules, so it goes straight to find_app_tools', () => {
  const rules = (apps: unknown[]) => groupRulesText(true, true, apps);
  const listed = rules([
    { id: 'user-X', name: 'X', status: 'connected', account: 'default' },
    { id: 'user-Gmail-work', name: 'Gmail', status: 'connected', account: 'work' },
    { id: 'user-Docs', name: 'Docs', status: 'available' },
    { id: 'user-Render', name: 'Render', status: 'needsAuth' },
    { id: 'user-Old', name: 'Old', status: 'disabled' },
  ]);
  assert.match(listed, /Apps connected when you joined: X = user-X, Gmail \(work\) = user-Gmail-work, Docs = user-Docs\. /);
  assert.match(listed, /Not usable when you joined: Render \(needsAuth\), Old \(disabled\)\. /);
  assert.match(listed, /Go straight to find_app_tools with the app id; use list_connected_apps only to check again\./);
  assert.doesNotMatch(listed, /Use list_connected_apps first/);
  const none = rules([{ id: 'user-Render', name: 'Render', status: 'needsAuth' }]);
  assert.match(none, /No app was connected when you joined\. Not usable when you joined: Render \(needsAuth\)\./);
  assert.doesNotMatch(rules([{ id: 'user-X', name: 'X', status: 'connected' }]), /Not usable/);
  for (const unknown of [rules([]), groupRulesText(true, true)]) {
    assert.match(unknown, /Use list_connected_apps first to see the real apps and connection states\. find_app_tools reads/);
    assert.doesNotMatch(unknown, /when you joined/);
  }
  assert.doesNotMatch(groupRulesText(true, false, [{ id: 'user-X', name: 'X', status: 'connected' }]), /user-X/, 'no app tools: no app list');
  // Names come from the account: whitespace is flattened, long ones cut, and the list capped.
  const odd = rules([{ id: ' user-\nY ', name: `Y\n\n${'z'.repeat(100)}`, status: 'connected', account: ' a\tb ' }]);
  assert.match(odd, new RegExp(`Y ${'z'.repeat(58)} \\(a b\\) = user- Y\\.`));
  const many = rules(Array.from({ length: MAX_APPS_LISTED + 5 }, (_, i) => ({ id: `user-A${i}`, name: `A${i}`, status: i % 2 ? 'needsAuth' : 'connected' })));
  assert.equal(many.match(/= user-A/g)!.length, Math.ceil((MAX_APPS_LISTED + 5) / 2), 'under the cap: all listed');
  const lots = rules(Array.from({ length: MAX_APPS_LISTED + 5 }, (_, i) => ({ id: `user-A${i}`, name: `A${i}`, status: 'connected' })));
  assert.equal(lots.match(/= user-A/g)!.length, MAX_APPS_LISTED);
});

test('a bot\'s session instructions name the apps its voice session came with; an older session without them still works', async () => {
  const apps = ['list_connected_apps', 'find_app_tools', 'use_app_tool'].map((name) => ({ ...SEARCH_TOOL, name }));
  const t = setup({ tools: () => apps, apps: (id) => (id === 'a' ? [{ id: 'user-X', name: 'X', status: 'connected' }] : 'not a list') });
  t.call.join([bot('a'), bot('b')]);
  await t.ready('a');
  await t.ready('b');
  assert.match(t.ws('a').sent[0].session.instructions, /Apps connected when you joined: X = user-X\./);
  assert.match(t.ws('b').sent[0].session.instructions, /Use list_connected_apps first/);
  assert.equal(t.call.links.get('b').apps.length, 0);
});

test('a voice setup Grok Bot\'s server did not answer is tried again, and the bot joins with the conversation as it is by then', async () => {
  // Call of 2026-11-11 12:57: Grok Bot's server did not answer for a few minutes; every bot pulled in failed after one try.
  let fails = 2;
  const { call, ws, ready, mints, timers } = setup({ mintFail: (id) => (id === 'c' && fails-- > 0 ? new Error("Could not reach Grok Bot's server (MintSandVoiceCallSecret: ETIMEDOUT)") : null) });
  call.join([bot('a'), bot('b')], [bot('a'), bot('b'), bot('c')]);
  await ready('a');
  await ready('b');
  useTool(ws('a'), 'invite_bot', { name: 'Bot C' }, 'Let me bring in Bot C.');
  await flush();
  const c = () => call.view().bots.find((x: any) => x.id === 'c');
  assert.deepEqual([c().status, c().error], ['connecting', "Could not reach Grok Bot's server (MintSandVoiceCallSecret: ETIMEDOUT)"]);
  assert.equal(call.timeline.at(-1).text, `Bot C: Could not reach Grok Bot's server (MintSandVoiceCallSecret: ETIMEDOUT) Trying again in ${SETUP_RETRY_MS[0] / 1000} s (try 2 of 3).`);
  speak(ws('b'), 'While we wait, the budget is fine.');
  const retry1 = timers.find((x) => !x.done && x.ms === SETUP_RETRY_MS[0])!;
  retry1.done = true;
  retry1.fn();
  await flush();
  assert.match(call.timeline.at(-1).text, new RegExp(`Trying again in ${SETUP_RETRY_MS[1] / 1000} s \\(try 3 of 3\\)\\.$`));
  const retry2 = timers.find((x) => !x.done && x.ms === SETUP_RETRY_MS[1])!;
  retry2.done = true;
  retry2.fn();
  await ready('c');
  assert.deepEqual(mints.filter((m) => m === 'c').length, 3);
  assert.deepEqual([c().status, c().error], ['thinking', null], 'joined on the third try, and greets the call');
  const said = ws('c').said();
  assert.match(said[0], /^Conversation so far in this call:\n[\s\S]*\[Bot A\]: Let me bring in Bot C\.\n\[Bot B\]: While we wait, the budget is fine\.$/, 'context as of the try that worked');
  assert.equal(said.filter((t: string) => t.startsWith('Conversation so far')).length, 1, 'told once');
  assert.equal(said.at(-1), '[Call]: Bot A just pulled you into this call. Say a short hello.');
});

test('a setup that hangs is tried again; the late answer of a try that gave up is ignored', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let first = true;
  const { call, timers, sockets, mints } = setup({ mintWait: (id) => (id === 'a' && first ? ((first = false), gate) : undefined) });
  call.join([bot('a')]);
  await flush();
  const connect = timers.find((x) => !x.done && x.ms === CONNECT_TIMEOUT_MS)!;
  connect.done = true;
  connect.fn();
  assert.deepEqual([call.view().bots[0].status, call.view().bots[0].error], ['connecting', 'Timed out connecting.']);
  release();
  await flush();
  assert.equal(sockets.get('a'), undefined, 'the given-up try opens no socket');
  const retry = timers.find((x) => !x.done && x.ms === SETUP_RETRY_MS[0])!;
  retry.done = true;
  retry.fn();
  await flush();
  assert.equal(mints.length, 2);
  assert.equal(sockets.get('a')!.length, 1);
});

test('a socket that opened but never got its session is closed before the next try, and its close is not a drop', async () => {
  const { call, ws, timers, sockets } = setup();
  call.join([bot('a')]);
  await flush();
  const first = ws('a');
  first.onopen!();
  const connect = timers.find((x) => !x.done && x.ms === CONNECT_TIMEOUT_MS)!;
  connect.done = true;
  connect.fn();
  assert.equal(first.closed, true);
  first.onclose?.();
  assert.ok(!call.timeline.some((e: any) => /lost its connection/.test(e.text)));
  const retry = timers.find((x) => !x.done && x.ms === SETUP_RETRY_MS[0])!;
  retry.done = true;
  retry.fn();
  await flush();
  assert.equal(sockets.get('a')!.length, 2);
});

test('setup errors that trying again cannot fix fail at once, and a refused setup is not retried', async () => {
  for (const why of ['Signed out. Sign in with your Grok Bot account.', 'No Grok Bot with id c on this account.', 'Grok Bot MintSandVoiceCallSecret failed (HTTP 403: Included usage used up)', 'Included usage used up']) {
    const { call, timers } = setup({ mintFail: () => new Error(why) });
    call.join([bot('a')]);
    await flush();
    assert.deepEqual([call.view().bots[0].status, call.view().bots[0].error], ['error', why], why);
    assert.ok(!timers.some((x) => !x.done && SETUP_RETRY_MS.includes(x.ms)), `no new try: ${why}`);
  }
  const { call, ws, timers } = setup();
  call.join([bot('a')]);
  await flush();
  ws('a').onopen!();
  ws('a').emit('error', { error: { message: 'bad session' } }); // search refused: tries without it
  ws('a').emit('error', { error: { message: 'bad session' } }); // nothing left to drop: refused
  assert.deepEqual([call.view().bots[0].status, call.view().bots[0].error], ['error', 'Voice setup was refused: bad session']);
  const connect = timers.find((x) => !x.done && x.ms === CONNECT_TIMEOUT_MS);
  assert.equal(connect, undefined);
});

test('a bot removed while it waits for a new try is not set up again; a bot that joined gets fresh tries if it drops later', async () => {
  let down = true;
  const { call, ready, mints, timers, ws } = setup({ mintFail: (id) => (down && id === 'b' ? new Error('fetch failed') : null) });
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await flush();
  call.removeBot('b');
  for (const t of timers.filter((x) => !x.done && SETUP_RETRY_MS.includes(x.ms))) assert.fail('the wait was cancelled');
  assert.equal(mints.filter((m) => m === 'b').length, 1);
  // Bot A joined; later it drops and Grok Bot's server is down: it gets every try again.
  down = false;
  const failing = call.d.mintVoice;
  call.d.mintVoice = async () => { throw new Error('fetch failed'); };
  ws('a').onclose!();
  await flush();
  await useUpRetries(timers);
  assert.equal(call.view().bots[0].status, 'error');
  call.d.mintVoice = failing;
});

test('a timed-out setup that was refused first fails with the refusal, not a new try', async () => {
  const { call, ws, timers } = setup();
  call.join([bot('a')]);
  await flush();
  ws('a').onopen!();
  ws('a').emit('error', { error: { message: 'no search here' } });
  const connect = timers.find((x) => !x.done && x.ms === CONNECT_TIMEOUT_MS)!;
  connect.done = true;
  connect.fn();
  assert.deepEqual([call.view().bots[0].status, call.view().bots[0].error], ['error', 'Voice setup was refused: no search here']);
  assert.ok(!timers.some((x) => !x.done && SETUP_RETRY_MS.includes(x.ms)));
});

/** A call with two bots that have send_task, and a fake agent whose replies to this call the test controls. */
async function withAgent() {
  const t = await two({ tools: () => [SEND_TASK] });
  const asks: { id: string; callId: string; after: number }[] = [];
  let replies: unknown = [];
  let fail = false;
  t.call.d.landedWork = async (id: string, callId: string, after: number) => {
    asks.push({ id, callId, after });
    if (fail) throw new Error('Grok Bot ListGrokBotTranscriptEntries failed (HTTP 503)');
    const r = replies;
    replies = [];
    return r;
  };
  const pending = () => t.timers.filter((x) => !x.done && (x.ms === LANDED_POLL_MS));
  const tick = async () => {
    const [timer] = pending();
    assert.ok(timer, 'a check is due');
    timer.done = true;
    timer.fn();
    await flush();
    return timer.ms;
  };
  const sendJob = async (request = 'post the comment', reply: object = { kind: 'served', output: { relay: 'accepted' } }) => {
    useTool(t.ws('a'), 'send_task', { request }, 'Posting that now.');
    t.toolCalls.at(-1)!.resolve(reply);
    await flush();
  };
  return { ...t, asks, pending, tick, sendJob, reply: (r: unknown) => (replies = r), failNext: (f: boolean) => (fail = f) };
}

test('a background job\'s reply from the agent comes back on the call, and the bot that sent it tells Shashank', async () => {
  // Call of 2026-11-11 13:33: the agent asked "should I go ahead?" 10 s after the job; the call never heard it, so
  // nothing was posted. In every logged call, all 14 jobs were answered on the call's channel and none reached it.
  const t = await withAgent();
  assert.equal(t.pending().length, 0, 'dependency installed after join; first job starts checks');
  await t.sendJob();
  assert.equal(t.pending().length, 1, 'checks start once a job is accepted');
  assert.equal(await t.tick(), LANDED_POLL_MS);
  assert.deepEqual(t.asks.at(-1), { id: 'a', callId: `${t.call.callId}-a`, after: 0 });
  const creates = t.ws('a').types().filter((x: string) => x === 'response.create').length;
  t.reply([{ seq: 167, at: 1, text: "I'm ready to post that comment. It's public and posts under your name, so should I go ahead?" }]);
  await t.tick();
  assert.equal(t.ws('a').updates().at(-1), "I'm ready to post that comment. It's public and posts under your name, so should I go ahead?");
  assert.ok(!t.ws('b').said().some((x: string) => x.startsWith('[Work landed]')), 'only the bot whose job it is');
  assert.equal(t.call.timeline.at(-1).text, "Bot A's agent: I'm ready to post that comment. It's public and posts under your name, so should I go ahead?");
  assert.equal(t.ws('a').types().filter((x: string) => x === 'response.create').length, creates + 1, 'asked to tell Shashank');
  assert.equal(t.call.links.get('a').holding, false);
  t.ws('a').emit('response.created');
  assert.equal(t.call.links.get('a').holding, true, 'held, so an update with nothing new is a silent pass');
  t.ws('a').emit('response.done', { response: { status: 'completed' } });
  await t.tick();
  assert.equal(t.asks.at(-1)!.after, 167, 'the next check asks only for newer updates');
  // Several at once: each is heard, in order, and one reply is asked for.
  t.reply([{ seq: 170, at: 3, text: 'Posted.' }, { seq: 169, at: 2, text: 'Posting now.' }, { seq: 160, at: 0, text: 'old' }, { seq: 171, text: '  ' }, null, { seq: 'x', text: 'bad' }]);
  await t.tick();
  assert.deepEqual(t.ws('a').updates().slice(-2), ['Posting now.', 'Posted.'], 'oldest first; old, empty and broken ones dropped');
  await t.tick();
  assert.equal(t.asks.at(-1)!.after, 170);
});

test('local history checks keep going through errors and stop when the bot leaves or the call ends', async () => {
  const t = await withAgent();
  await t.sendJob();
  t.failNext(true);
  await t.tick();
  assert.equal(t.pending().length, 1, 'a failed check is tried again');
  t.failNext(false);
  t.reply('not a list');
  await t.tick();
  assert.equal(t.pending()[0].ms, LANDED_POLL_MS);
  t.setClock(120_000);
  await t.tick();
  assert.equal(t.pending()[0].ms, LANDED_POLL_MS, 'local history stays responsive throughout a call');
  await t.sendJob('another job');
  assert.equal(t.pending().length, 1, 'a new job does not add a second check');
  await t.tick();
  assert.equal(t.pending()[0].ms, LANDED_POLL_MS, 'and makes checks frequent again');
  t.call.removeBot('a');
  assert.equal(t.pending().length, 0, 'leaving stops the checks');
  // A check that was under way when the bot left does nothing.
  const u = await withAgent();
  await u.sendJob();
  let release!: (v: unknown) => void;
  u.call.d.landedWork = () => new Promise((r) => (release = r));
  const [timer] = u.pending();
  timer.done = true;
  timer.fn();
  await u.sendJob('while checking');
  assert.equal(u.pending().length, 0, 'no second check while one is under way');
  u.call.links.get('a').close();
  release([{ seq: 5, text: 'late' }]);
  await flush();
  assert.ok(!u.ws('a').said().includes('[Work landed]: late'));
  assert.equal(u.pending().length, 0);
});

test('when the call ends, agent checks stop; an update that arrives as it ends is not passed on', async () => {
  const t = await withAgent();
  await t.sendJob();
  let release!: (v: unknown) => void;
  t.call.d.landedWork = () => new Promise((r) => (release = r));
  const [timer] = t.pending();
  timer.done = true;
  timer.fn();
  t.call.phase = 'wrapping';
  release([{ seq: 9, text: 'done' }]);
  await flush();
  assert.ok(!t.ws('a').said().includes('[Work landed]: done'));
  assert.equal(t.pending().length, 0);
  const u = await withAgent();
  await u.sendJob();
  u.call.phase = 'wrapping';
  await u.tick();
  assert.equal(u.asks.length, 0, 'a check due after the call ended does not ask');
});

test('an update while Shashank talks, or during another bot\'s one-on-one, is heard by the bot but not spoken yet', async () => {
  const t = await withAgent();
  await t.sendJob();
  const creates = () => t.ws('a').types().filter((x: string) => x === 'response.create').length;
  t.call.userSpeaking = true;
  let before = creates();
  t.reply([{ seq: 1, text: 'Done.' }]);
  await t.tick();
  assert.equal(t.ws('a').updates().at(-1), 'Done.');
  assert.equal(creates(), before, 'Shashank is talking');
  t.call.userSpeaking = false;
  t.call.setFocus(t.call.links.get('b'));
  before = creates();
  t.reply([{ seq: 2, text: 'Also done.' }]);
  await t.tick();
  assert.equal(creates(), before, 'one-on-one with another bot');
  t.call.setFocus(t.call.links.get('a'));
  t.reply([{ seq: 3, text: 'All done.' }]);
  await t.tick();
  assert.equal(creates(), before + 1, 'its own one-on-one: it tells him');
  // Even while the call waits for Shashank, an update is told.
  t.call.setFocus(null);
  t.call.waitingForHost = true;
  t.ws('a').emit('response.created');
  t.ws('a').emit('response.done', { response: { status: 'completed' } });
  const now = creates();
  t.reply([{ seq: 4, text: 'One more thing.' }]);
  await t.tick();
  assert.equal(creates(), now + 1);
});

test('no agent checks without send_task accepted, or when the page cannot read updates', async () => {
  const t = await withAgent();
  await t.sendJob('refused job', { kind: 'invalid_input', output: { error: 'missing request' } });
  assert.equal(t.pending().length, 0, 'a refused job has nothing to come back');
  const { call, ws, toolCalls, timers } = await two({ tools: () => [SEND_TASK] });
  assert.equal(call.d.landedWork, undefined);
  useTool(ws('a'), 'send_task', { request: 'job' });
  toolCalls.at(-1)!.resolve({ kind: 'served', output: { relay: 'accepted' } });
  await flush();
  assert.ok(!timers.some((x) => !x.done && x.ms === LANDED_POLL_MS), 'an older page without landedWork just works as before');
});

test('after a bot speaks, the turn goes round the others and stops when all of them pass; after Shashank, every bot gets its turn', async () => {
  const t = setup();
  t.call.join([bot('a'), bot('b'), bot('c')]);
  for (const id of ['a', 'b', 'c']) await t.ready(id);
  speak(t.ws('a'), 'The budget is fine.', 1);
  fire(t.timers, t.call.nextTimer);
  useTool(t.ws('b'), 'pass', {});
  assert.notEqual(t.call.nextTimer, null, 'C still gets its turn');
  assert.equal(t.call.waitingForHost, false);
  fire(t.timers, t.call.nextTimer);
  useTool(t.ws('c'), 'pass', {});
  assert.equal(t.call.waitingForHost, true, 'B and C passed: A does not get the turn back to say it again');
  assert.equal(t.call.timeline.at(-1).text, 'The other bots had nothing to add: waiting for you');
  // After Shashank speaks, a pass by the first bot still lets the others answer.
  t.call.hostSpoke('Anyone have thoughts?');
  t.call.afterTurn(t.call.links.get('a'), '', { kind: 'pass' });
  assert.equal(t.call.waitingForHost, false);
  assert.notEqual(t.call.nextTimer, null);
  t.call.afterTurn(t.call.links.get('b'), '', { kind: 'pass' });
  assert.equal(t.call.waitingForHost, false);
  t.call.afterTurn(t.call.links.get('c'), '', { kind: 'pass' });
  assert.equal(t.call.waitingForHost, true, 'all three passed');
  assert.equal(t.call.timeline.at(-1).text, 'Every bot passed: waiting for you');
  // The bot that spoke left: back to the rule for everyone.
  t.call.hostSpoke('Next.');
  speak(t.ws('a'), 'Leaving soon.', 1);
  t.call.removeBot('a');
  t.call.afterTurn(t.call.links.get('b'), '', { kind: 'pass' });
  assert.equal(t.call.waitingForHost, false, 'only one of the two left passed');
  t.call.afterTurn(t.call.links.get('c'), '', { kind: 'pass' });
  assert.equal(t.call.waitingForHost, true);
});


test('Grok greeting gives the caller a grace period; speech, leaving and a dropped link cancel it', async () => {
  for (const mode of ['greet', 'news', 'host', 'leave', 'drop']) {
    const t = setup({ voice: { greeting: { direction: 'Say hello', withLandedWork: 'Report news' } } });
    t.call.join([bot('a')]);
    await t.ready('a');
    assert.equal(t.ws('a').types().includes('response.create'), false);
    const timer = t.timers.find((x) => !x.done && x.ms === USER_FIRST_GRACE_MS)!;
    const link = t.call.links.get('a');
    if (mode === 'host') t.call.sendText('Hello there');
    if (mode === 'leave') t.call.leave();
    if (mode === 'drop') link.ready = false;
    if (mode === 'news') link.newsOwed = true;
    if (!timer.done) { timer.done = true; timer.fn(); }
    if (mode === 'greet' || mode === 'news') assert.equal(t.ws('a').sent.find((m) => m.type === 'response.create').response.instructions, mode === 'greet' ? 'Say hello' : 'Report news');
    if (mode === 'leave' || mode === 'drop') assert.ok(!t.ws('a').types().includes('response.create'));
  }
});

test('a dropped voice socket resumes its conversation, or receives context if the server starts fresh', async () => {
  for (const resumed of [true, false]) {
    const t = await two();
    t.ws('a').emit('conversation.created', { conversation: { id: 'conv-original' } });
    t.call.sendText('Remember the nonce blue');
    t.ws('a').onclose!();
    await flush();
    assert.match(t.ws('a').url, /conversation_id=conv-original/);
    await t.ready('a');
    t.ws('a').emit('conversation.created', { conversation: { id: resumed ? 'conv-original' : 'conv-new' } });
    assert.equal(t.ws('a').said().some((s: string) => s.includes('Conversation so far')), !resumed);
    t.ws('a').emit('conversation.created', {});
  }
  assert.equal(withParam('wss://voice.test/?a=1', 'conversation_id', 'a b'), 'wss://voice.test/?a=1&conversation_id=a+b');
});

test('async job and typed-chat updates are held; refused async updates use seeded tool items', async () => {
  const t = await two();
  const link = t.call.links.get('a');
  link.deliverUpdate({ seq: 1, text: 'Job finished', at: 100 });
  const sent = t.ws('a').sent.at(-1);
  assert.equal(sent.async_update.trigger_response, false);
  assert.equal(link.newsOwed, true);
  t.ws('a').emit('error', { error: { event_id: sent.event_id, message: 'unsupported async update' } });
  const result = t.ws('a').sent.at(-1).item;
  assert.equal(result.type, 'function_call_output');
  assert.match(result.output, /Job finished/);
  link.deliverUpdate({ seq: 2, kind: 'written', text: 'Typed by host' });
  assert.match(t.ws('a').said().at(-1), /Typed by host/);
  link.nudgeWire = 'async-update';
  link.deliverUpdate({ seq: 3, kind: 'written', text: 'Async host' });
  assert.equal(t.ws('a').sent.at(-1).async_update.topic, 'user_message');
});

test('a result the voice server took in only after the bot\'s reply had started is told after that reply', async () => {
  // Call of 2026-11-11 17:21:43: "The comment is live on 1240" landed as the host said "Thank you". The server had
  // already started the reply ("Anytime.") and took the update in 0.3 s later, so the host never heard the result.
  const { call, ws } = await three();
  const a = call.links.get('a');
  hostSays(ws('a'), 'Bot A, post the comment');
  speak(ws('a'), 'Posting now.');
  hostSays(ws('a'), 'Thank you.');
  assert.equal(call.focusClosing, true);
  ws('a').emit('response.created'); // the server's own reply to "Thank you."
  a.deliverUpdate({ seq: 180, at: 1, text: 'The comment is live on pull request 1240.' });
  ws('a').emit('async_update.added', { async_update: { topic: 'work_landed' } });
  const before = creates(ws('a'));
  ws('a').emit('response.output_audio_transcript.done', { transcript: 'Anytime.' });
  ws('a').emit('response.done', { response: { status: 'completed' } });
  assert.equal(creates(ws('a')), before + 1, 'asked again, now with the result in its conversation');
  ws('a').emit('response.created');
  assert.equal(a.holding, true, 'held, so a reply with nothing new is a silent pass');
  speak(ws('a'), 'The comment is live on 1240.');
  assert.equal(creates(ws('a')), before + 1, 'once only');
});

test('a result taken in before the reply started, or a reply cut off, the host talking, or a reply already coming: no extra ask', async () => {
  const t = await two({ tools: () => [SEND_TASK] });
  const a = t.call.links.get('a');
  const ws = t.ws('a');
  // taken in before the reply started: that reply had it
  a.deliverUpdate({ seq: 1, at: 1, text: 'Done.' });
  ws.emit('async_update.added', {});
  let before = creates(ws);
  speak(ws, 'It is done.');
  assert.equal(creates(ws), before);
  // cut off: the next reply has it anyway
  ws.emit('response.created');
  a.deliverUpdate({ seq: 2, at: 1, text: 'Second.' });
  ws.emit('async_update.added', {});
  ws.emit('response.done', { response: { status: 'cancelled' } });
  assert.equal(creates(ws), before);
  // the host is talking: it tells him at its next reply
  ws.emit('response.created');
  ws.emit('async_update.added', {});
  t.call.userSpeaking = true;
  ws.emit('response.output_audio_transcript.done', { transcript: 'Sure.' });
  ws.emit('response.done', { response: { status: 'completed' } });
  assert.equal(creates(ws), before);
  t.call.userSpeaking = false;
  // its tool asked for a follow-up: that reply starts after the update, so it has it
  ws.emit('response.created');
  ws.emit('async_update.added', {});
  ws.emit('response.function_call_arguments.done', { call_id: 'c1', name: 'list_tasks', arguments: '{}' });
  ws.emit('response.done', { response: { status: 'completed' } });
  assert.equal(creates(ws), before + 1, 'only the follow-up');
  ws.emit('response.created');
  ws.emit('response.done', { response: { status: 'completed' } });
  // a Grok Bot tool still running: its follow-up, if any, has it
  before = creates(ws);
  ws.emit('response.created');
  ws.emit('async_update.added', {});
  ws.emit('response.function_call_arguments.done', { call_id: 'c2', name: 'send_task', arguments: '{"request":"x"}' });
  ws.emit('response.done', { response: { status: 'completed' } });
  assert.equal(a.toolsBusy, true);
  assert.equal(creates(ws), before);
  // the call is ending: never
  t.toolCalls.at(-1)!.resolve({ kind: 'served', output: { relay: 'accepted' } });
  await flush();
  before = creates(ws);
  t.call.phase = 'wrapping';
  ws.emit('response.created');
  ws.emit('async_update.added', {});
  ws.emit('response.done', { response: { status: 'completed' } });
  assert.equal(creates(ws), before);
});

test('seeded updates: only the update\'s own item, taken in mid-reply, counts as missed', async () => {
  const t = await two();
  const a = t.call.links.get('a');
  const ws = t.ws('a');
  a.nudgeWire = 'seeded-tool-pair';
  ws.emit('response.created');
  a.deliverUpdate({ seq: 7, at: 1, text: 'Seeded result.' });
  ws.emit('conversation.item.added', { item: { type: 'message' } });
  ws.emit('conversation.item.added', { item: { type: 'function_call_output', call_id: 'some-tool-call' } });
  let before = creates(ws);
  ws.emit('response.output_audio_transcript.done', { transcript: 'Hm.' });
  ws.emit('response.done', { response: { status: 'completed' } });
  assert.equal(creates(ws), before, 'other items are not the update');
  ws.emit('response.created');
  ws.emit('conversation.item.added', { item: { type: 'function_call_output', call_id: `seeded-nudge-a-7` } });
  before = creates(ws);
  ws.emit('response.output_audio_transcript.done', { transcript: 'Hm.' });
  ws.emit('response.done', { response: { status: 'completed' } });
  assert.equal(creates(ws), before + 1);
});

test('a ping watchdog reconnects a silent voice socket; ordinary sessions without pings stay connected', async () => {
  const t = await two();
  assert.ok(!t.timers.some((x) => !x.done && x.ms === SILENCE_MS));
  t.ws('a').emit('ping');
  const timer = t.timers.find((x) => !x.done && x.ms === SILENCE_MS)!;
  t.ws('a').emit('ping');
  assert.equal(timer.done, true);
  const next = t.timers.find((x) => !x.done && x.ms === SILENCE_MS)!;
  next.done = true; next.fn(); await flush();
  assert.equal(t.sockets.get('a')!.length, 2);
});

test('Grok job receipts return before the agent finishes; failures come back as news', async () => {
  for (const accepted of [true, false]) {
    const t = setup({ tools: () => [SEND_TASK], voice: { receipt: { output: { status: 'under_way' }, instructions: 'Keep talking' } } });
    t.call.join([bot('a')]); await t.ready('a');
    useTool(t.ws('a'), 'send_task', { request: 'Read the test file' });
    assert.ok(t.ws('a').sent.some((m) => m.item?.output === JSON.stringify({ status: 'under_way' })));
    assert.equal(t.toolCalls.length, 1);
    assert.equal(t.call.links.get('a').receiptOwed, true);
    t.toolCalls[0].resolve(accepted ? { kind: 'served', output: { relay: 'accepted' } } : { kind: 'invalid_input', output: { error: 'No request' } });
    await flush();
    if (!accepted) assert.match(t.ws('a').updates().at(-1), /not|No request/i);
  }
});

test('agent capability instructions reflect skills, paused routines and computer availability', () => {
  assert.equal(agentText(null, false), '');
  const extras = { skills: [{ name: 'research', description: 'Read docs' }, { name: 'plain' }], routines: [{ name: 'daily', trigger: '9 am', enabled: true }, { name: 'paused' }], computers: [{ label: 'Mac', online: true }] };
  assert.match(agentText(extras, true), /research.*Read docs/);
  assert.match(agentText(extras, true), /paused/);
  assert.match(agentText(extras, true), /online now/);
  extras.computers[0].online = false;
  assert.match(agentText(extras, true), /offline now/);
  assert.ok(!agentText(extras, false).includes('Skills your agent'));
});

test('updates wait for a reconnect and are not consumed by a dead voice socket', async () => {
  const t = await withAgent();
  await t.sendJob();
  const link = t.call.links.get('a');
  link.ready = false;
  t.reply([{ seq: 42, text: 'Durable answer' }]);
  await t.tick();
  assert.equal(link.landedSeq, 0);
  link.ready = true;
  await t.tick();
  assert.equal(link.landedSeq, 42);
});


test('leaving notifies each joined agent before its link is removed; a failed notification cannot block Leave', async () => {
  const t = await two({ tools: () => [SEND_TASK] });
  const calls: any[] = [];
  t.call.d.callTool = (id: string, request: any) => {
    assert.ok(t.call.links.has(id), 'dispatch must occur while the bot can still be identified');
    calls.push({ id, request });
    return Promise.reject(new Error('offline'));
  };
  t.call.leave();
  await flush();
  assert.equal(calls.length, 2);
  assert.match(calls[0].request.input.request, /call.*ended/i);
  assert.equal(t.call.phase, 'idle');
});

test('receipt and update fallbacks retain their flags until a real spoken answer', async () => {
  const t = setup({ tools: () => [SEND_TASK], voice: { receipt: { instructions: 'Receipt' }, skills: null, routines: null, computers: null } });
  t.call.join([bot('a')]); await t.ready('a');
  const link = t.call.links.get('a');
  link.nudgeWire = 'seeded-tool-pair';
  link.deliverUpdate({ seq: 1, text: 'No timestamp' });
  useTool(t.ws('a'), 'send_task', { request: 'read test' }, 'I will check.');
  t.toolCalls[0].resolve({ kind: 'served', output: { relay: 'accepted' } }); await flush();
  link.resumeFrom = 'old'; link.pendingContext = null;
  t.ws('a').emit('conversation.created', {});
  link.conversationId = 'old';
  await link.connect(null);
  await t.ready('a');
  t.ws('a').emit('conversation.created', { conversation: { id: 'old' } });
  t.call.userSpeaking = true;
  await t.call.runJob(link, { name: 'send_task', callId: 'duplicate', args: '{"request":"read test"}' }, {});
  assert.equal(link.newsOwed, true);
  link.nudgeWire = 'async-update';
  t.call.onLanded(link, [{ seq: 2, kind: 'written', text: 'Host typed' }]);
  assert.match(t.call.timeline.at(-1).text, /typed/);
});

test('greeting guards stale timers and uses discovered agent capabilities', async () => {
  const t = setup({ voice: { greeting: { direction: 'Hello' }, skills: [{ name: 'research' }], routines: [{ name: 'daily' }], computers: [{ label: 'Mac', online: true }] } });
  t.call.join([bot('a')]); await t.ready('a');
  const timer = t.timers.find((x) => !x.done && x.ms === USER_FIRST_GRACE_MS)!;
  t.call.sendText('I spoke first');
  const before = t.ws('a').types().filter((x) => x === 'response.create').length;
  timer.fn();
  assert.equal(t.ws('a').types().filter((x) => x === 'response.create').length, before);
  const link = t.call.links.get('a');
  // A served-but-unaccepted answer is still delivered as failure news.
  t.call.runHarnessTool = async () => ({ output: '{}', followUp: true });
  await t.call.runJob(link, { name: 'send_task', callId: 'empty', args: '{}' }, {});
  assert.match(t.ws('a').updates().at(-1), /did not go through/);
});

test('native local tools override the old local-task instructions with an explicit execution target', async () => {
  const t = setup({ tools: () => [SEND_TASK, { type: 'function', name: 'mac_files', parameters: { type: 'object' } }] });
  t.call.join([bot('a')]); await t.ready('a');
  assert.match(t.call.links.get('a').instructions(), /These execute on This Mac independently/);
  assert.match(t.call.links.get('a').instructions(), /Do not silently send the same task to another computer/);
});

test('hostName keeps a name safe for prompts and name matching', () => {
  assert.equal(hostName('Shashank'), 'Shashank');
  assert.equal(hostName('  Anne-Marie   O\'Neil '), "Anne-Marie O'Neil");
  assert.equal(hostName('José'), 'José');
  assert.equal(hostName('a.*+?(b)[c]{d}|e\\'), 'abcde');
  assert.equal(hostName('x'.repeat(60)), 'x'.repeat(40));
  for (const empty of [undefined, null, '', '   ', '***']) assert.equal(hostName(empty), 'Host');
});

test('USER comes from GROK_CALL_USER, and falls back to Host', async () => {
  assert.equal(USER, 'Shashank'); // npm test sets it
  const { execFileSync } = await import('node:child_process');
  const read = (env: Record<string, string>) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', "console.log((await import('./public/core.js')).USER)"], { env: { PATH: process.env.PATH!, ...env } }).toString().trim();
  assert.equal(read({}), 'Host');
  assert.equal(read({ GROK_CALL_USER: 'Priya' }), 'Priya');
});

test('text-only calls: replies are asked for as text, any audio is dropped, and the words still count', async () => {
  const { call, audio, ws, ready } = setup();
  call.join([bot('a'), bot('b')]);
  await ready('a');
  await ready('b');
  call.textOnly = true;
  call.sendText('Bot A, what is the revenue figure?');
  const ask = ws('a').sent.filter((m: any) => m.type === 'response.create').at(-1);
  assert.deepEqual(ask.response.modalities, ['text']);
  const played = audio.played.length;
  // Words as output text (the server honoured text only).
  ws('a').emit('response.created', { response: { id: 'r' } });
  ws('a').emit('response.output_item.added', { item: { id: 'i1' } });
  ws('a').emit('response.output_text.delta', { delta: 'It was ' });
  assert.equal(call.links.get('a').text, 'It was ');
  ws('a').emit('response.output_text.delta', { delta: 7 });
  ws('a').emit('response.output_text.done', { text: 'It was 4.2 million.' });
  ws('a').emit('response.output_text.done', { text: null });
  ws('a').emit('response.done', { response: { status: 'completed' } });
  assert.equal(call.lines.at(-1).text, 'It was 4.2 million.');
  // Audio anyway (the server spoke): none of it plays, and its transcript still counts.
  call.sendText('Bot A, and margin?');
  speak(ws('a'), 'Margin was 12 percent.');
  assert.equal(audio.played.length, played, 'nothing was played');
  assert.equal(call.lines.at(-1).text, 'Margin was 12 percent.');
  assert.match(ws('b').said().at(-1)!, /\[Bot A\]: Margin was 12 percent\./);
  // Back to voice: audio plays, and replies are no longer text only.
  call.textOnly = false;
  call.sendText('Bot A, say it aloud.');
  assert.equal(ws('a').sent.filter((m: any) => m.type === 'response.create').at(-1).response, undefined);
  speak(ws('a'), 'Twelve percent.');
  assert.ok(audio.played.length > played);
});
