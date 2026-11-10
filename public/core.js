// Call engine: one realtime voice session per Grok Bot, turn-taking between
// Shashank and the bots, and a single playback queue so voices never overlap.
// No DOM or Web Audio here; the page passes those in, so this runs under tests.

export const USER = 'Shashank';
export const SAMPLE_RATE = 24000;
/** Cue the next bot this long before the current voice finishes, to hide its start-up delay. */
export const NEXT_TURN_LEAD_MS = 1200;
/** If the listening bot has not started its reply this long after Shashank stops, ask it to. */
export const REPLY_GRACE_MS = 2000;
/** While a bot is talking, mic audio below this level is held back so speaker echo isn't heard as Shashank. */
export const BARGE_IN_LEVEL = 0.05;
/** Audio kept from just before Shashank cuts in, so his first word isn't clipped. */
export const PREROLL_MS = 300;
/** Loud mic audio this recent means Shashank may be starting to talk: keep his mic on the same bot. */
export const USER_ACTIVE_MS = 1500;
/** Lines of conversation given to a bot that joins (or rejoins) mid-call. */
export const CONTEXT_LINES = 30;
/** A dropped bot reconnects by itself only if it had stayed up at least this long. */
export const MIN_UPTIME_FOR_RETRY_MS = 10000;
/** If Shashank seems to be talking but the mic has been quiet this long with no transcript, unstick the call. */
export const STUCK_SPEAKING_MS = 8000;
/** How Shashank's lines are tagged for the bots. */
export const HOST = `${USER} (host)`;
/** A line with any of these words is a correction: never dropped as echo. */
export const CORRECTION_WORDS = ['no', 'wait', 'stop', 'actually', 'wrong'];
/** Host corrections kept in the pinned "current direction" note (newest last). */
export const DIRECTION_MAX = 5;
/** Longest note or task text a bot can write; longer text is cut to this. */
export const NOTE_MAX_CHARS = 500;
/** Most notes plus tasks the notepad holds. */
export const NOTEPAD_MAX = 200;
/** A correction this short ("no", "wait, stop") is a nudge, not a new direction to pin. */
export const DIRECTION_MIN_WORDS = 3;

// ---------- text ----------

export function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The bot named first in the text (longest name wins on a tie), or null. */
export function findAddressee(text, bots) {
  const hay = ` ${normalize(text)} `;
  let best = null;
  for (const b of bots) {
    const name = normalize(b.name);
    if (!name) continue;
    const i = hay.indexOf(` ${name} `);
    if (i < 0) continue;
    if (!best || i < best.i || (i === best.i && name.length > best.len)) best = { id: b.id, i, len: name.length };
  }
  return best ? best.id : null;
}

/** True if the text has a correction word ("no", "wait", "stop", "actually", "wrong") as a whole word. */
export function hasCorrection(text) {
  const words = new Set(normalize(text).split(' '));
  return CORRECTION_WORDS.some((w) => words.has(w));
}

/** True if a host line is a correction worth pinning as the current direction. */
export function isDirection(text) {
  return hasCorrection(text) && normalize(text).split(' ').length >= DIRECTION_MIN_WORDS;
}

/** The pinned note added to every bot's instructions. Empty when the host hasn't corrected anyone yet. */
export function directionText(direction) {
  if (!direction.length) return '';
  return (
    `\n\n# Current direction (pinned by the host)\n` +
    `${USER} corrected the bots during this call. Follow this over anything said before it; the newest is last:\n` +
    direction.map((d) => `- "${d}"`).join('\n')
  );
}

/**
 * True for empty speech, or speech that is mostly words a bot just said (speaker echo).
 * Pass '' as `recentBotText` when no bot audio was playing: then only empty speech is dropped.
 * A correction is never dropped.
 */
export function isNoiseOrEcho(heard, recentBotText) {
  const words = normalize(heard).split(' ').filter(Boolean);
  if (!words.length) return true;
  if (words.length < 3 || hasCorrection(heard)) return false;
  const pool = new Set(normalize(recentBotText).split(' ').filter(Boolean));
  const hits = words.filter((w) => pool.has(w)).length;
  return hits / words.length >= 0.8;
}

/** The one tool bots get in the call: pull another of Shashank's Grok Bots in. */
export const INVITE_TOOL = {
  type: 'function',
  name: 'invite_bot',
  description:
    `Pull another of ${USER}'s Grok Bots into this call. Use it when ${USER} asks for a bot, or when that bot would really help the conversation. ` +
    'Say out loud who you are bringing in before you call it.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Exact name of the bot to invite, from the list in your instructions.' } },
    required: ['name'],
  },
};

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  name,
  description,
  parameters: { type: 'object', properties, required },
});

/** Turn tools: bots decide who speaks next, when to stop, and when to go. */
export const PASS_TOOL = fn('pass', 'Skip your turn when you have nothing useful to add. Say nothing out loud when you use it.');
export const HAND_TO_TOOL = fn(
  'hand_to',
  'Give the next turn to one bot in the call. Use it after you finish speaking, instead of letting the turn go round.',
  { name: { type: 'string', description: 'Exact name of a bot in the call.' } },
  ['name'],
);
export const WAIT_FOR_HOST_TOOL = fn(
  'wait_for_host',
  `Stop the bots talking among themselves and wait for ${USER} to speak. Use it when the topic is done, when you need ${USER}'s input, or when the bots are going in circles.`,
);
export const LEAVE_CALL_TOOL = fn(
  'leave_call',
  `Leave this call yourself, when ${USER} asks you to or when you are no longer needed. Say a short goodbye before you use it.`,
);

/** Shared notepad tools: everyone in the call, and Shashank on his screen, sees the same notepad. */
const textParam = (what) => ({ text: { type: 'string', description: what } });
export const WRITE_NOTE_TOOL = fn('write_note', 'Write a short note on the shared notepad: a fact, decision or idea worth keeping.', textParam('The note, one or two sentences.'), ['text']);
export const READ_NOTES_TOOL = fn('read_notes', 'Read the shared notepad: every note and task so far.');
export const ADD_TASK_TOOL = fn('add_task', 'Add an action item to the shared notepad.', textParam('The task, starting with a verb.'), ['text']);
export const DONE_TASK_TOOL = fn(
  'done_task',
  'Mark a task on the shared notepad as done.',
  { id: { type: 'integer', description: 'The task number, as shown by read_notes.' } },
  ['id'],
);

export const TOOLS = [
  INVITE_TOOL,
  PASS_TOOL,
  HAND_TO_TOOL,
  WAIT_FOR_HOST_TOOL,
  LEAVE_CALL_TOOL,
  WRITE_NOTE_TOOL,
  READ_NOTES_TOOL,
  ADD_TASK_TOOL,
  DONE_TASK_TOOL,
];

/** The notepad as plain text, for read_notes. */
export function notepadText(notes, tasks) {
  if (!notes.length && !tasks.length) return 'The notepad is empty.';
  const parts = [];
  if (notes.length) parts.push(`Notes:\n${notes.map((n) => `- ${n.text} (${n.by})`).join('\n')}`);
  if (tasks.length) {
    const line = (t) => `- [${t.done ? 'x' : ' '}] ${t.id}. ${t.text} (${t.done ? `done by ${t.doneBy}` : `added by ${t.by}`})`;
    parts.push(`Tasks:\n${tasks.map(line).join('\n')}`);
  }
  return parts.join('\n');
}

/** Note or task text from tool arguments: trimmed, one line, capped. */
export function cleanNote(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOTE_MAX_CHARS);
}

export function groupInstructions(base, me, roster, invitable = [], direction = []) {
  const others = roster.filter((n) => n !== me);
  const who = others.length
    ? `The other Grok bots in the call: ${others.join(', ')}.`
    : 'No other bots are in the call right now.';
  const invite = invitable.length
    ? `You can pull another of ${USER}'s Grok Bots into the call with the invite_bot tool. Bots you can invite: ${invitable.join(', ')}.`
    : `Every one of ${USER}'s Grok Bots is already in the call, so there is nobody to invite.`;
  return (
    `${base}\n\n# Group call\n` +
    `You are ${me}, in a live group voice call hosted by ${USER}. ${who} ` +
    `Audio you hear is ${USER} speaking. A text message that starts with "[Name]:" is what that participant just said out loud; treat it as speech you heard. ` +
    `${USER} is the host; his lines are tagged "[${HOST}]". What the host says comes before the current topic: ` +
    `when the host corrects you, changes the subject or asks for something, drop what you were doing and follow the host right away. ` +
    `A line tagged "(cut off by the host)" is only the part the host heard before cutting that speaker off. ` +
    `Speak only as yourself and never say a "[Name]:" prefix. Keep each turn to one to three short spoken sentences. ` +
    `To ask someone to answer, say their name. ${invite} ` +
    `Bots take turns on their own. After you speak, the turn goes to the bot you name, or round the call in order. ` +
    `Manage turns with your tools: hand_to gives the next turn to one bot, pass skips your turn when you have nothing to add, ` +
    `wait_for_host stops the bots and waits for ${USER} (use it when the topic is done or you are going in circles), ` +
    `and leave_call takes you out of the call. ` +
    `There is a shared notepad that every bot and ${USER} can see: write_note keeps a fact, decision or idea, add_task adds an action item, ` +
    `done_task ticks one off, and read_notes shows it all. A "[Notepad]:" message tells you someone changed it. ` +
    `Your other Grok Bot tools are not available during this call; only the tools given here are.` +
    directionText(direction)
  );
}

/** The bot in `pool` that `wanted` names: exact name first, then a name mentioned inside it. */
export function matchBot(wanted, pool) {
  const n = normalize(wanted);
  if (!n) return null;
  return pool.find((b) => normalize(b.name) === n)?.id ?? findAddressee(wanted, pool);
}

/** Removes markup the voice model sometimes leaks into its transcript, e.g. <response_segment_0_already_spoken>…</…>. */
export function cleanTranscript(text) {
  return String(text)
    .replace(/<(\w+)>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<\/?\w+\/?>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The "[...]" tag a line is shown to the bots with. */
export function tagOf(line) {
  if (line.who === USER) return HOST;
  return line.cut ? `${line.who} (cut off by the host)` : line.who;
}

export function contextText(lines) {
  return `Conversation so far in this call:\n${lines.map((l) => `[${tagOf(l)}]: ${l.text}`).join('\n')}`;
}

/** The start of `text` that was heard: `heardMs` of `totalMs` of audio, cut back to whole words. */
export function heardPart(text, heardMs, totalMs) {
  if (!text || heardMs <= 0 || totalMs <= 0) return '';
  if (heardMs >= totalMs) return text;
  const n = Math.round((text.length * heardMs) / totalMs);
  const out = [];
  let len = 0;
  for (const w of text.split(' ')) {
    len += w.length + (out.length ? 1 : 0);
    if (len > n) break;
    out.push(w);
  }
  return out.join(' ');
}

// ---------- audio ----------

/** Linear resampling of mono float audio. */
export function resample(input, from, to) {
  if (from === to) return input;
  const n = Math.round((input.length * to) / from);
  const out = new Float32Array(n);
  const ratio = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const a = input[j];
    const b = j + 1 < input.length ? input[j + 1] : a;
    out[i] = a + (b - a) * (x - j);
  }
  return out;
}

export function floatTo16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

export function pcm16ToFloat(input) {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] / 32768;
  return out;
}

export function rms(input) {
  if (!input.length) return 0;
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
  return Math.sqrt(sum / input.length);
}

export function toBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length - (s.length % 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = s.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

// ---------- playback ----------

/**
 * One timeline for every bot's voice. `audio` is { now(): seconds, play(samples, when): { stop() } }.
 * Tracks how much of each reply was actually heard, so a cut-off bot knows where it was stopped.
 */
export class Player {
  constructor(audio) {
    this.audio = audio;
    this.chunks = [];
    this.end = 0;
    this.heard = new Map(); // itemId -> seconds already played
  }

  enqueue(botId, itemId, samples) {
    if (!samples.length) return;
    const start = Math.max(this.audio.now(), this.end);
    const end = start + samples.length / SAMPLE_RATE;
    const handle = this.audio.play(samples, start);
    this.chunks.push({ botId, itemId, start, end, handle });
    this.end = end;
  }

  prune(now) {
    this.chunks = this.chunks.filter((c) => {
      if (c.end > now) return true;
      this.heard.set(c.itemId, (this.heard.get(c.itemId) ?? 0) + (c.end - c.start));
      return false;
    });
  }

  /** The bot whose voice is playing right now, or null. */
  speaking() {
    const now = this.audio.now();
    this.prune(now);
    const c = this.chunks.find((x) => x.start <= now);
    return c ? c.botId : null;
  }

  /** Ms of a reply already played out in full (chunks that finished). */
  heardMs(itemId) {
    this.prune(this.audio.now());
    return Math.round((this.heard.get(itemId) ?? 0) * 1000);
  }

  remainingMs() {
    return Math.max(0, (this.end - this.audio.now()) * 1000);
  }

  /** Stops queued audio (all, or one bot's). Returns itemId -> { botId, ms heard } for replies cut short. */
  flush(botId) {
    const now = this.audio.now();
    this.prune(now);
    const cut = new Map();
    this.chunks = this.chunks.filter((c) => {
      if (botId !== undefined && c.botId !== botId) return true;
      c.handle.stop();
      const entry = cut.get(c.itemId) ?? { botId: c.botId, ms: (this.heard.get(c.itemId) ?? 0) * 1000 };
      entry.ms += Math.max(0, now - c.start) * 1000;
      cut.set(c.itemId, entry);
      return false;
    });
    for (const [itemId, entry] of cut) {
      entry.ms = Math.round(entry.ms);
      this.heard.delete(itemId);
    }
    this.end = this.chunks.reduce((m, c) => Math.max(m, c.end), now);
    return cut;
  }
}

// ---------- one bot ----------

const AUDIO_FORMAT = { type: 'audio/pcm', rate: SAMPLE_RATE };

export class BotLink {
  constructor(call, bot) {
    this.call = call;
    this.bot = bot;
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.queue = [];
    this.status = 'connecting';
    this.error = null;
    this.base = '';
    this.readyAt = 0;
    this.retried = false;
    this.pending = false; // response.create sent, not started yet
    this.active = false; // a reply is being generated
    this.discard = false; // drop the current reply's audio
    this.suppressNext = false; // cancel the next reply as soon as it starts
    this.itemId = null;
    this.text = '';
    this.audioMs = 0; // audio generated for the current reply, played or not
    this.heardMs = 0; // set when Shashank cuts this reply off: how much of it he heard
    this.replyTimer = null;
    this.toolCalls = [];
    this.turn = null; // what this bot decided with a turn tool: { kind, target? }
    this.leaving = false; // used leave_call; removed once its goodbye has played
  }

  async connect(context) {
    this.ready = false;
    this.queue = [];
    this.status = this.retried ? 'reconnecting' : 'connecting';
    this.error = null;
    if (context) this.say(context);
    let voice;
    try {
      voice = await this.call.d.mintVoice(this.bot.id);
    } catch (err) {
      return this.fail(err);
    }
    if (this.closed) return;
    this.base = voice.instructions;
    const ws = this.call.d.openSocket(voice.url, [`xai-client-secret.${voice.clientSecret}`]);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify(this.sessionUpdate()));
    ws.onmessage = (m) => this.onEvent(m.data);
    ws.onclose = () => this.onClose(ws);
    ws.onerror = () => {}; // a close event always follows
  }

  sessionUpdate() {
    const { voice, speed, language } = this.bot;
    return {
      type: 'session.update',
      session: {
        ...(voice ? { voice } : {}),
        instructions: this.instructions(),
        tools: TOOLS,
        turn_detection: { type: 'server_vad' },
        audio: {
          input: {
            format: AUDIO_FORMAT,
            transcription: { model: 'grok-transcribe', ...(language ? { language_hint: language } : {}) },
          },
          output: { format: AUDIO_FORMAT, speed },
        },
      },
    };
  }

  instructions() {
    return groupInstructions(this.base, this.bot.name, this.call.roster(), this.call.invitable().map((b) => b.name), this.call.direction);
  }

  send(msg) {
    if (this.ready) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  say(text) {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  }

  respond() {
    this.suppressNext = false;
    this.clearReplyTimer();
    this.pending = true;
    this.send({ type: 'response.create' });
  }

  /** Stop the current reply, or the one about to start. */
  cancel() {
    if (this.active) {
      this.discard = true;
      this.send({ type: 'response.cancel' });
    } else if (this.pending) {
      this.suppressNext = true;
    }
    this.pending = false;
  }

  /** The bot will reply to audio on its own; make sure that reply never plays. */
  suppress() {
    this.clearReplyTimer();
    if (this.active) this.cancel();
    else this.suppressNext = true;
  }

  /** The bot should reply to what it just heard; nudge it if it doesn't start on its own. */
  expectReply() {
    this.clearReplyTimer();
    this.replyTimer = this.call.d.setTimer(() => {
      this.replyTimer = null;
      if (!this.active && !this.pending && this.ready) this.respond();
    }, REPLY_GRACE_MS);
  }

  clearReplyTimer() {
    if (this.replyTimer !== null) this.call.d.clearTimer(this.replyTimer);
    this.replyTimer = null;
  }

  /** The key this reply's audio is queued under in the Player. */
  itemKey() {
    return this.itemId ?? `${this.bot.id}:reply`;
  }

  truncate(itemId, ms) {
    this.send({ type: 'conversation.item.truncate', item_id: itemId, content_index: 0, audio_end_ms: ms });
  }

  appendAudio(int16) {
    if (this.ready) this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: toBase64(int16) }));
  }

  clearInput() {
    if (this.ready) this.ws.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
  }

  updateInstructions() {
    if (this.ready) this.ws.send(JSON.stringify({ type: 'session.update', session: { instructions: this.instructions() } }));
  }

  onEvent(data) {
    let e;
    try {
      e = JSON.parse(data);
    } catch {
      return;
    }
    switch (e?.type) {
      case 'session.updated':
        if (this.ready) return;
        this.ready = true;
        this.readyAt = this.call.d.now();
        this.status = 'ready';
        for (const msg of this.queue.splice(0)) this.ws.send(JSON.stringify(msg));
        return this.call.onReady(this);
      case 'response.created':
        this.clearReplyTimer();
        this.pending = false;
        this.active = true;
        this.text = '';
        this.itemId = null;
        this.discard = false;
        this.audioMs = 0;
        this.heardMs = 0;
        this.toolCalls = [];
        if (this.suppressNext) {
          this.suppressNext = false;
          this.cancel();
        }
        return;
      case 'response.output_item.added':
        this.itemId = e.item?.id ?? null;
        return;
      case 'response.output_audio.delta': {
        if (typeof e.delta !== 'string') return;
        const pcm = fromBase64(e.delta);
        this.audioMs += (pcm.length / SAMPLE_RATE) * 1000;
        if (!this.discard) this.call.player.enqueue(this.bot.id, this.itemKey(), pcm16ToFloat(pcm));
        return;
      }
      case 'response.output_audio_transcript.delta':
        if (typeof e.delta === 'string') this.text += e.delta;
        return;
      case 'response.output_audio_transcript.done':
        if (typeof e.transcript === 'string') this.text = e.transcript;
        return;
      case 'response.function_call_arguments.done':
        if (typeof e.call_id === 'string' && typeof e.name === 'string') {
          this.toolCalls.push({ callId: e.call_id, name: e.name, args: typeof e.arguments === 'string' ? e.arguments : '{}' });
        }
        return;
      case 'response.done': {
        const heard = !this.discard;
        this.active = false;
        this.discard = false;
        const status = heard ? (e.response?.status ?? 'completed') : 'cancelled';
        const calls = this.toolCalls.splice(0);
        const ran = heard && status === 'completed';
        const text = heard ? cleanTranscript(this.text) : '';
        let followUp = false;
        for (const c of calls) {
          let output = 'Not done: this reply was cut off before anyone heard it.';
          if (ran) {
            const r = this.call.onToolCall(this, c);
            output = r.output;
            // 'if-quiet': a bot that only wrote something and said nothing gets to speak, so the talk goes on.
            followUp ||= r.followUp === true || (r.followUp === 'if-quiet' && !text);
          }
          this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.callId, output } });
        }
        if (!heard && this.heardMs > 0) this.call.onBotCut(this, heardPart(cleanTranscript(this.text), this.heardMs, this.audioMs));
        this.heardMs = 0;
        return this.call.onBotDone(this, text, status, followUp);
      }
      case 'input_audio_buffer.speech_started':
        return this.call.onSpeechStart(this);
      case 'conversation.item.input_audio_transcription.completed':
        return this.call.onTranscript(this, typeof e.transcript === 'string' ? e.transcript : '');
      case 'error':
        // e.g. a reply asked for while one is running, or cancelling one that already ended
        this.pending = false;
        return;
      default:
        return;
    }
  }

  onClose(ws) {
    if (ws !== this.ws || this.closed) return;
    const wasUp = this.ready && this.call.d.now() - this.readyAt >= MIN_UPTIME_FOR_RETRY_MS;
    this.ready = false;
    this.active = false;
    this.pending = false;
    this.clearReplyTimer();
    if (!this.retried || wasUp) {
      this.retried = true;
      this.call.onDropped(this);
    } else {
      this.fail(new Error('Connection lost.'));
    }
  }

  fail(err) {
    this.ready = false;
    this.status = 'error';
    this.error = err?.message || 'Could not connect.';
    this.call.onFailed(this);
  }

  close() {
    this.closed = true;
    this.ready = false;
    this.clearReplyTimer();
    if (this.ws) this.ws.close();
  }
}

// ---------- the call ----------

/**
 * deps: {
 *   mintVoice(botId) -> Promise<{ clientSecret, url, instructions }>,
 *   openSocket(url, protocols) -> WebSocket-like,
 *   audio: { now(), play(samples, when) -> { stop() } },
 *   setTimer(fn, ms), clearTimer(handle), now() -> ms
 * }
 */
export class Call {
  constructor(deps) {
    this.d = deps;
    this.player = new Player(deps.audio);
    this.links = new Map();
    this.phase = 'idle';
    this.reset();
  }

  reset() {
    this.links.clear();
    this.available = []; // every Grok Bot on the account (who can be invited)
    this.invited = new Map(); // botId -> name of the bot that pulled it in
    this.order = [];
    this.lines = [];
    this.direction = []; // pinned host corrections, newest last
    this.notes = []; // shared notepad: { text, by }
    this.tasks = []; // { id, text, by, done, doneBy }
    this.notepadVersion = 0; // bumped on every notepad change, so the page redraws only then
    this.ear = null; // the bot hearing Shashank's mic right now
    this.opened = false;
    this.muted = false;
    this.userSpeaking = false;
    this.waitingForHost = false; // a bot used wait_for_host (or every bot passed): no bot turns until Shashank speaks
    this.passes = 0; // passes in a row
    this.gen = 0;
    this.nextTimer = null;
    this.preroll = [];
    this.lastLoud = -Infinity; // when the mic last went above BARGE_IN_LEVEL
    this.echoRisk = false; // bot audio was playing when Shashank's current speech started
    this.stuckTimer = null;
  }

  /** `available`: all of Shashank's Grok Bots, so bots in the call can pull others in. */
  join(bots, available = bots) {
    if (this.phase !== 'idle') throw new Error('already in a call');
    this.reset();
    this.phase = 'in-call';
    this.available = available;
    for (const bot of bots) this.add(bot);
  }

  leave() {
    if (this.phase === 'idle') return;
    this.stopNext();
    this.clearStuck();
    for (const link of this.links.values()) link.close();
    this.player.flush();
    this.phase = 'idle';
    this.reset();
  }

  addBot(bot) {
    if (this.phase !== 'in-call' || this.links.has(bot.id)) return;
    this.add(bot);
    this.rosterChanged();
  }

  removeBot(id) {
    const link = this.links.get(id);
    if (!link) return;
    link.close();
    this.links.delete(id);
    this.invited.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.player.flush(id);
    if (this.ear === link) this.setEar(this.readyLinks()[0] ?? null);
    this.rosterChanged();
  }

  setMuted(muted) {
    this.muted = muted;
    this.preroll = [];
  }

  /** Mic audio from the page: 24 kHz PCM16 plus its loudness (0..1). */
  micAudio(int16, level) {
    const ear = this.ear;
    if (this.phase !== 'in-call' || this.muted || !ear?.ready) {
      this.preroll = [];
      return;
    }
    if (level >= BARGE_IN_LEVEL) this.lastLoud = this.d.now();
    if (!this.userSpeaking && level < BARGE_IN_LEVEL && this.player.remainingMs() > 0) {
      this.preroll.push(int16);
      let total = this.preroll.reduce((n, c) => n + c.length, 0);
      while (total > (PREROLL_MS * SAMPLE_RATE) / 1000) total -= this.preroll.shift().length;
      return;
    }
    for (const chunk of this.preroll.splice(0)) ear.appendAudio(chunk);
    ear.appendAudio(int16);
  }

  roster() {
    return this.order.map((id) => this.links.get(id).bot.name);
  }

  /** Grok Bots not in the call that a bot could pull in. */
  invitable() {
    return this.available.filter((b) => !this.links.has(b.id));
  }

  readyLinks() {
    return this.order.map((id) => this.links.get(id)).filter((l) => l.ready && !l.leaving);
  }

  /** What the page draws: one entry per bot in the call. */
  view() {
    const speaking = this.player.speaking();
    return {
      phase: this.phase,
      muted: this.muted,
      userSpeaking: this.userSpeaking,
      waitingForHost: this.waitingForHost,
      direction: this.direction,
      notes: this.notes,
      tasks: this.tasks,
      notepadVersion: this.notepadVersion,
      bots: this.order.map((id) => {
        const l = this.links.get(id);
        let status = l.status;
        if (l.ready) {
          if (speaking === id) status = 'speaking';
          else if (l.pending || (l.active && !l.discard)) status = 'thinking';
          else if (this.ear === l) status = 'listening';
          else status = 'idle';
        }
        return { id, name: l.bot.name, color: l.bot.color, shape: l.bot.shape, status, error: l.error };
      }),
    };
  }

  // ----- internals -----

  add(bot) {
    const link = new BotLink(this, bot);
    this.links.set(bot.id, link);
    this.order.push(bot.id);
    void link.connect(this.lines.length ? contextText(this.lines.slice(-CONTEXT_LINES)) : null);
  }

  rosterChanged() {
    for (const link of this.links.values()) link.updateInstructions();
  }

  setEar(link) {
    if (this.ear === link) return;
    this.ear?.clearInput();
    this.ear = link;
    this.preroll = [];
  }

  record(who, text, from, cut = false) {
    const line = cut ? { who, text, cut } : { who, text };
    this.lines.push(line);
    for (const link of this.links.values()) if (link !== from) link.say(`[${tagOf(line)}]: ${text}`);
  }

  stopNext() {
    if (this.nextTimer !== null) this.d.clearTimer(this.nextTimer);
    this.nextTimer = null;
  }

  /** Shashank cut in: silence everyone and stop any queued bot turn. */
  interrupt() {
    this.gen++;
    this.stopNext();
    const cut = this.player.flush();
    for (const [itemId, { botId, ms }] of cut) this.links.get(botId)?.truncate(itemId, ms);
    for (const link of this.links.values()) {
      // Remember how much of a reply Shashank heard, so the others get only that part.
      if (link.active && !link.discard) link.heardMs = cut.get(link.itemKey())?.ms ?? this.player.heardMs(link.itemKey());
      link.cancel();
    }
  }

  onReady(link) {
    const by = this.invited.get(link.bot.id);
    if (by !== undefined) {
      this.invited.delete(link.bot.id);
      link.say(`[Call]: ${by} just pulled you into this call. Say a short hello.`);
      link.respond();
    }
    if (!this.opened) {
      this.opened = true;
      this.setEar(link);
      link.say(`[Call]: ${USER} just joined. Open the call with one short spoken line.`);
      link.respond();
    } else if (!this.ear) {
      this.setEar(link);
    }
  }

  onDropped(link) {
    void link.connect(this.lines.length ? contextText(this.lines.slice(-CONTEXT_LINES)) : null);
  }

  onFailed(link) {
    if (this.ear === link) this.setEar(this.readyLinks()[0] ?? null);
  }

  onSpeechStart(link) {
    if (link !== this.ear) return;
    this.userSpeaking = true;
    this.echoRisk = this.player.remainingMs() > 0;
    this.armStuck();
    this.interrupt();
    // The listening bot's server stops its own reply when Shashank talks, and its next
    // reply will be to him, so don't mark that one for cancelling.
    link.suppressNext = false;
  }

  onTranscript(link, text) {
    if (link !== this.ear) return;
    this.userSpeaking = false;
    this.clearStuck();
    // The echo check only runs if a bot's voice was playing when this speech started.
    const recent = this.echoRisk
      ? this.lines
          .filter((l) => l.who !== USER)
          .slice(-2)
          .map((l) => l.text)
          .join(' ')
      : '';
    this.echoRisk = false;
    if (isNoiseOrEcho(text, recent)) {
      link.suppress();
      return;
    }
    this.record(USER, text.trim(), link);
    this.hostSpoke(text.trim());
    const named = findAddressee(text, this.readyLinks().map((l) => l.bot));
    const target = named ? this.links.get(named) : link;
    if (target === link) {
      link.expectReply();
    } else {
      link.suppress();
      target.respond();
      this.setEar(target);
    }
  }

  armStuck() {
    this.clearStuck();
    this.stuckTimer = this.d.setTimer(() => this.checkStuck(), STUCK_SPEAKING_MS);
  }

  clearStuck() {
    if (this.stuckTimer !== null) this.d.clearTimer(this.stuckTimer);
    this.stuckTimer = null;
  }

  /** Shashank "started talking" but no transcript came: if his mic has gone quiet, stop waiting for him. */
  checkStuck() {
    this.stuckTimer = null;
    if (!this.userSpeaking) return;
    if (this.d.now() - this.lastLoud < STUCK_SPEAKING_MS) return this.armStuck();
    this.userSpeaking = false;
    this.echoRisk = false;
    this.ear?.clearInput();
    this.ear?.expectReply();
  }

  /** A reply Shashank cut off: the others get only the part he heard. */
  onBotCut(link, part) {
    if (!part || !this.links.has(link.bot.id)) return;
    this.record(link.bot.name, part, link, true);
  }

  /** Shashank said something: bots may take turns again, and a correction is pinned for every bot. */
  hostSpoke(text) {
    this.waitingForHost = false;
    this.passes = 0;
    if (!isDirection(text)) return;
    this.direction = [...this.direction, text].slice(-DIRECTION_MAX);
    for (const link of this.links.values()) link.updateInstructions();
  }

  /** A bot used a tool. Returns { output: what the bot is told, followUp: it should speak again }. */
  onToolCall(link, { name, args }) {
    let a = {};
    try {
      a = JSON.parse(args) ?? {};
    } catch {
      // bad arguments: treated as none
    }
    switch (name) {
      case INVITE_TOOL.name:
        return { output: this.invite(link, String(a.name ?? '')), followUp: true };
      case PASS_TOOL.name:
        link.turn = { kind: 'pass' };
        return { output: 'You passed this turn.', followUp: false };
      case HAND_TO_TOOL.name: {
        const others = this.readyLinks().filter((l) => l !== link);
        const wanted = String(a.name ?? '');
        const id = matchBot(wanted, others.map((l) => l.bot));
        if (!id) {
          const list = others.map((l) => l.bot.name).join(', ') || 'nobody';
          return { output: `No bot called "${wanted}" can take the turn. Bots in the call: ${list}. The turn goes on as usual.`, followUp: false };
        }
        link.turn = { kind: 'hand', target: id };
        return { output: `${this.links.get(id).bot.name} speaks next.`, followUp: false };
      }
      case WAIT_FOR_HOST_TOOL.name:
        link.turn = { kind: 'wait' };
        return { output: `The bots now wait for ${USER} to speak.`, followUp: false };
      case LEAVE_CALL_TOOL.name:
        link.turn = { kind: 'leave' };
        return { output: 'You are leaving the call.', followUp: false };
      case WRITE_NOTE_TOOL.name:
      case ADD_TASK_TOOL.name: {
        const text = cleanNote(a.text);
        if (!text) return { output: 'Nothing written: the text was empty.', followUp: 'if-quiet' };
        if (this.notes.length + this.tasks.length >= NOTEPAD_MAX) {
          return { output: `Nothing written: the notepad is full (${NOTEPAD_MAX} items).`, followUp: 'if-quiet' };
        }
        const by = link.bot.name;
        if (name === WRITE_NOTE_TOOL.name) {
          this.notes = [...this.notes, { text, by }];
          this.notepadChanged(link, `${by} wrote a note: "${text}"`);
          return { output: 'Note written.', followUp: 'if-quiet' };
        }
        const id = this.tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
        this.tasks = [...this.tasks, { id, text, by, done: false, doneBy: null }];
        this.notepadChanged(link, `${by} added task ${id}: "${text}"`);
        return { output: `Task ${id} added.`, followUp: 'if-quiet' };
      }
      case READ_NOTES_TOOL.name:
        return { output: notepadText(this.notes, this.tasks), followUp: true };
      case DONE_TASK_TOOL.name: {
        const id = Number(String(a.id ?? '').replace(/^#/, ''));
        const task = this.tasks.find((t) => t.id === id);
        if (!task) {
          const open = this.tasks.filter((t) => !t.done).map((t) => t.id).join(', ') || 'none';
          return { output: `There is no task ${a.id ?? ''}. Open tasks: ${open}.`, followUp: 'if-quiet' };
        }
        if (task.done) return { output: `Task ${id} is already done.`, followUp: 'if-quiet' };
        this.tasks = this.tasks.map((t) => (t === task ? { ...t, done: true, doneBy: link.bot.name } : t));
        this.notepadChanged(link, `${link.bot.name} marked task ${id} done: "${task.text}"`);
        return { output: `Task ${id} marked done.`, followUp: 'if-quiet' };
      }
      default:
        return { output: `Unknown tool "${name}". Tools in this call: ${TOOLS.map((t) => t.name).join(', ')}.`, followUp: false };
    }
  }

  /** Tell the other bots what changed on the notepad, and let the page redraw it. */
  notepadChanged(from, what) {
    this.notepadVersion++;
    for (const link of this.links.values()) if (link !== from) link.say(`[Notepad]: ${what}`);
  }

  invite(link, wanted) {
    const id = matchBot(wanted, this.available);
    const list = this.invitable().map((b) => b.name).join(', ') || 'nobody';
    if (!id) return `There is no Grok Bot called "${wanted}". Bots you can invite: ${list}.`;
    const bot = this.available.find((b) => b.id === id);
    if (this.links.has(id)) return `${bot.name} is already in the call.`;
    this.invited.set(id, link.bot.name);
    this.addBot(bot);
    return `${bot.name} is joining the call now. Tell everyone in one short line.`;
  }

  onBotDone(link, text, status, followUp = false) {
    if (status !== 'completed' || !this.links.has(link.bot.id)) {
      link.turn = null;
      return;
    }
    const said = text.trim();
    if (said) {
      this.record(link.bot.name, said, link);
      // Keep Shashank's mic on the same bot while he is (maybe) mid-sentence,
      // or his words get split between two bots.
      if (!this.userSpeaking && this.d.now() - this.lastLoud >= USER_ACTIVE_MS) this.setEar(link);
    }
    // After a tool like invite_bot the bot speaks again to say how it went; its turn decision waits until then.
    if (followUp) {
      if (!this.userSpeaking) link.respond();
      return;
    }
    const turn = link.turn;
    link.turn = null;
    if (turn?.kind === 'leave') this.leaveSoon(link);
    if (!said && !turn) return;
    if (turn?.kind === 'wait') {
      this.waitingForHost = true;
      return;
    }
    if (said) this.passes = 0;
    else if (turn?.kind === 'pass') this.passes++;
    const others = this.readyLinks().filter((l) => l !== link);
    if (this.passes > 0 && this.passes >= others.length + 1) {
      // Every bot passed in a row: nobody has anything to add.
      this.waitingForHost = true;
      return;
    }
    if (!others.length || this.userSpeaking || this.waitingForHost) return;
    const target = turn?.kind === 'hand' ? others.find((l) => l.bot.id === turn.target) : null;
    const named = findAddressee(said, others.map((l) => l.bot));
    const next = target ?? (named ? this.links.get(named) : this.after(link, others));
    const gen = this.gen;
    this.stopNext();
    this.nextTimer = this.d.setTimer(
      () => {
        this.nextTimer = null;
        // Skip a bot that is already about to speak (e.g. a newly invited bot saying hello).
        if (gen === this.gen && next.ready && !this.userSpeaking && !this.waitingForHost && !next.pending && !next.active) next.respond();
      },
      Math.max(0, this.player.remainingMs() - NEXT_TURN_LEAD_MS),
    );
  }

  /** A bot used leave_call: remove it once its goodbye has played. */
  leaveSoon(link) {
    link.leaving = true;
    this.d.setTimer(() => {
      if (this.links.get(link.bot.id) !== link) return;
      this.removeBot(link.bot.id);
      for (const l of this.links.values()) l.say(`[Call]: ${link.bot.name} left the call.`);
    }, this.player.remainingMs());
  }

  /** Next bot in call order after `link`, among `others`. */
  after(link, others) {
    const i = this.order.indexOf(link.bot.id) + 1;
    const rotated = [...this.order.slice(i), ...this.order.slice(0, i)];
    return rotated.map((id) => others.find((l) => l.bot.id === id)).find(Boolean);
  }
}
