// Call engine: one realtime voice session per Grok Bot, turn-taking between
// Shashank and the bots, and a single playback queue so voices never overlap.
// No DOM or Web Audio here; the page passes those in, so this runs under tests.

export const USER = 'Shashank';
export const SAMPLE_RATE = 24000;
/** Bot turns in a row (bots talking among themselves) before they wait for Shashank. */
export const MAX_BOT_TURNS = 6;
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

/** True for empty speech, or speech that is mostly words a bot just said (speaker echo). */
export function isNoiseOrEcho(heard, recentBotText) {
  const words = normalize(heard).split(' ').filter(Boolean);
  if (!words.length) return true;
  if (words.length < 3) return false;
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

export function groupInstructions(base, me, roster, invitable = []) {
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
    `Speak only as yourself and never say a "[Name]:" prefix. Keep each turn to one to three short spoken sentences. ` +
    `To ask someone to answer, say their name. ${invite} ` +
    `Your other tools are not available during this call; invite_bot is the only one.`
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

export function contextText(lines) {
  return `Conversation so far in this call:\n${lines.map((l) => `[${l.who}]: ${l.text}`).join('\n')}`;
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
    this.replyTimer = null;
    this.toolCalls = [];
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
        tools: [INVITE_TOOL],
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
    return groupInstructions(this.base, this.bot.name, this.call.roster(), this.call.invitable().map((b) => b.name));
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
        this.toolCalls = [];
        if (this.suppressNext) {
          this.suppressNext = false;
          this.cancel();
        }
        return;
      case 'response.output_item.added':
        this.itemId = e.item?.id ?? null;
        return;
      case 'response.output_audio.delta':
        if (!this.discard && typeof e.delta === 'string') {
          this.call.player.enqueue(this.bot.id, this.itemId ?? `${this.bot.id}:reply`, pcm16ToFloat(fromBase64(e.delta)));
        }
        return;
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
        for (const c of calls) {
          const output = ran ? this.call.onToolCall(this, c) : 'Not done: this reply was cut off before anyone heard it.';
          this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.callId, output } });
        }
        return this.call.onBotDone(this, heard ? cleanTranscript(this.text) : '', status, ran && calls.length > 0);
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
    this.ear = null; // the bot hearing Shashank's mic right now
    this.opened = false;
    this.muted = false;
    this.userSpeaking = false;
    this.botTurns = 0;
    this.gen = 0;
    this.nextTimer = null;
    this.preroll = [];
    this.lastLoud = -Infinity; // when the mic last went above BARGE_IN_LEVEL
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
    return this.order.map((id) => this.links.get(id)).filter((l) => l.ready);
  }

  /** What the page draws: one entry per bot in the call. */
  view() {
    const speaking = this.player.speaking();
    return {
      phase: this.phase,
      muted: this.muted,
      userSpeaking: this.userSpeaking,
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

  record(who, text, from) {
    this.lines.push({ who, text });
    for (const link of this.links.values()) if (link !== from) link.say(`[${who}]: ${text}`);
  }

  stopNext() {
    if (this.nextTimer !== null) this.d.clearTimer(this.nextTimer);
    this.nextTimer = null;
  }

  /** Shashank cut in: silence everyone and stop any queued bot turn. */
  interrupt() {
    this.gen++;
    this.stopNext();
    for (const [itemId, { botId, ms }] of this.player.flush()) this.links.get(botId)?.truncate(itemId, ms);
    for (const link of this.links.values()) link.cancel();
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
    this.interrupt();
    // The listening bot's server stops its own reply when Shashank talks, and its next
    // reply will be to him, so don't mark that one for cancelling.
    link.suppressNext = false;
  }

  onTranscript(link, text) {
    if (link !== this.ear) return;
    this.userSpeaking = false;
    const recent = this.lines
      .filter((l) => l.who !== USER)
      .slice(-2)
      .map((l) => l.text)
      .join(' ');
    if (isNoiseOrEcho(text, recent)) {
      link.suppress();
      return;
    }
    this.record(USER, text.trim(), link);
    this.botTurns = 0;
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

  /** A bot used a tool. Returns what the bot is told back. */
  onToolCall(link, { name, args }) {
    if (name !== INVITE_TOOL.name) return `Unknown tool "${name}". The only tool in this call is invite_bot.`;
    let wanted = '';
    try {
      wanted = String(JSON.parse(args)?.name ?? '');
    } catch {
      // bad arguments: treated as no name
    }
    const id = matchBot(wanted, this.available);
    const list = this.invitable().map((b) => b.name).join(', ') || 'nobody';
    if (!id) return `There is no Grok Bot called "${wanted}". Bots you can invite: ${list}.`;
    const bot = this.available.find((b) => b.id === id);
    if (this.links.has(id)) return `${bot.name} is already in the call.`;
    this.invited.set(id, link.bot.name);
    this.addBot(bot);
    return `${bot.name} is joining the call now. Tell everyone in one short line.`;
  }

  onBotDone(link, text, status, usedTool = false) {
    if (status !== 'completed' || !this.links.has(link.bot.id)) return;
    const said = text.trim();
    if (said) {
      this.record(link.bot.name, said, link);
      // Keep Shashank's mic on the same bot while he is (maybe) mid-sentence,
      // or his words get split between two bots.
      if (!this.userSpeaking && this.d.now() - this.lastLoud >= USER_ACTIVE_MS) this.setEar(link);
    }
    // After a tool call the bot speaks again to say how it went; the next turn is cued after that.
    if (usedTool) {
      if (!this.userSpeaking) link.respond();
      return;
    }
    if (!said) return;
    this.botTurns++;
    const others = this.readyLinks().filter((l) => l !== link);
    if (!others.length || this.botTurns >= MAX_BOT_TURNS || this.userSpeaking) return;
    const named = findAddressee(text, others.map((l) => l.bot));
    const next = named ? this.links.get(named) : this.after(link, others);
    const gen = this.gen;
    this.stopNext();
    this.nextTimer = this.d.setTimer(
      () => {
        this.nextTimer = null;
        // Skip a bot that is already about to speak (e.g. a newly invited bot saying hello).
        if (gen === this.gen && next.ready && !this.userSpeaking && !next.pending && !next.active) next.respond();
      },
      Math.max(0, this.player.remainingMs() - NEXT_TURN_LEAD_MS),
    );
  }

  /** Next bot in call order after `link`, among `others`. */
  after(link, others) {
    const i = this.order.indexOf(link.bot.id) + 1;
    const rotated = [...this.order.slice(i), ...this.order.slice(0, i)];
    return rotated.map((id) => others.find((l) => l.bot.id === id)).find(Boolean);
  }
}
