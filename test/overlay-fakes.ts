// Fake voice sockets, audio and timers for the overlay call (same shape as the ones in core.test.ts).
import { floatTo16, SAMPLE_RATE, toBase64 } from '../public/core.js';
import { OverlayCall } from '../src/overlay/call.ts';

export class FakeAudio {
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

export class FakeSocket {
  sent: any[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
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
  said(): string[] {
    return this.sent.filter((m) => m.type === 'conversation.item.create' && m.item.type === 'message').map((m) => m.item.content[0].text);
  }
  outputs(): string[] {
    return this.sent.filter((m) => m.type === 'conversation.item.create' && m.item.type === 'function_call_output').map((m) => m.item.output);
  }
  lastSession() {
    return this.sent.filter((m) => m.type === 'session.update').at(-1).session;
  }
}

export const flush = () => new Promise((r) => setImmediate(r));
export const bot = (id: string, extra: object = {}) => ({ id, name: `Bot ${id.toUpperCase()}`, voice: null, speed: 1, language: null, color: null, shape: null, ...extra });
const b64audio = (seconds: number) => toBase64(floatTo16(new Float32Array(Math.round(seconds * SAMPLE_RATE)).fill(0.25)));

export function setup() {
  const audio = new FakeAudio();
  const sockets = new Map<string, FakeSocket>();
  let clock = 0;
  let tid = 0;
  const timers: { fn: () => void; id: number; done: boolean }[] = [];
  const call = new OverlayCall({
    mintVoice: async (id: string) => ({ clientSecret: `sec-${id}`, url: `wss://voice.test/${id}`, instructions: `I am ${id}.` }),
    openSocket: (url: string) => {
      const ws = new FakeSocket(url);
      sockets.set(url.split('/').pop()!, ws);
      return ws;
    },
    audio,
    setTimer: (fn: () => void) => {
      timers.push({ fn, id: ++tid, done: false });
      return tid;
    },
    clearTimer: (id: number) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.done = true;
    },
    now: () => clock,
  });
  const ws = (id: string) => sockets.get(id)!;
  async function ready(...ids: string[]) {
    await flush();
    for (const id of ids) {
      ws(id).onopen!();
      ws(id).emit('session.updated');
    }
  }
  return { call, audio, ws, ready, timers, setClock: (ms: number) => (clock = ms) };
}

/** A bot replies: optional words (with audio) and optional tool calls. */
export function reply(s: FakeSocket, text: string, tools: [string, unknown][] = [], seconds = 1) {
  s.emit('response.created');
  s.emit('response.output_item.added', { item: { id: `item-${Math.random()}` } });
  if (text) {
    s.emit('response.output_audio.delta', { delta: b64audio(seconds) });
    s.emit('response.output_audio_transcript.done', { transcript: text });
  }
  tools.forEach(([name, args], i) =>
    s.emit('response.function_call_arguments.done', { call_id: `c${i}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }),
  );
  s.emit('response.done', { response: { status: 'completed' } });
}

export function hostSays(s: FakeSocket, text: string) {
  s.emit('input_audio_buffer.speech_started');
  s.emit('conversation.item.input_audio_transcription.completed', { transcript: text });
}
