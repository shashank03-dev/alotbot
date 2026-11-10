import { Call, SAMPLE_RATE, USER, floatTo16, resample, rms } from './core.js';

const $ = (sel) => document.querySelector(sel);
const screens = ['boot', 'signin', 'lobby', 'call'];

const state = {
  bots: [], // every Grok Bot on the account
  selected: new Set(),
  call: null,
  audio: null, // { ctx, stream, nodes }
  level: 0,
  tiles: new Map(),
  frame: 0,
};

// ---------- helpers ----------

class SignedOut extends Error {}

async function api(path, method = 'GET') {
  let res;
  try {
    res = await fetch(path, { method });
  } catch {
    throw new Error('Grok Call server is not reachable. Is it still running?');
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new SignedOut(body.error || 'Signed out.');
  if (!res.ok) throw new Error(body.error || `Request failed (HTTP ${res.status}).`);
  return body;
}

function show(name) {
  for (const s of screens) $(`#${s}`).hidden = s !== name;
  document.body.dataset.screen = name;
}

const COLORS = {
  black: '#3b404c', white: '#d9dde4', gray: '#6b7280', grey: '#6b7280', red: '#ef4444', orange: '#f97316',
  amber: '#f59e0b', yellow: '#eab308', lime: '#84cc16', green: '#22c55e', emerald: '#10b981', teal: '#14b8a6',
  cyan: '#06b6d4', sky: '#0ea5e9', blue: '#3b82f6', indigo: '#6366f1', violet: '#8b5cf6', purple: '#a855f7',
  fuchsia: '#d946ef', pink: '#ec4899', rose: '#f43f5e',
};

function colorOf(bot) {
  if (bot.color && COLORS[bot.color]) return COLORS[bot.color];
  let h = 0;
  for (const ch of bot.name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 60% 55%)`;
}

function initials(name) {
  const words = name.replace(/[’']s\b/g, '').split(/\s+/).filter(Boolean);
  if (words.length < 2) return name.slice(0, 2).toUpperCase();
  // "Shashank's X bot" -> "SX", so it doesn't look the same as "Shashank's Bot" -> "SB"
  const last = words.length > 2 && /^bots?$/i.test(words[words.length - 1]) ? words.length - 2 : words.length - 1;
  return (words[0][0] + words[last][0]).toUpperCase();
}

function avatar(bot) {
  const el = document.createElement('div');
  el.className = 'avatar';
  el.dataset.shape = bot.shape || 'circle';
  el.style.setProperty('--c', colorOf(bot));
  el.textContent = initials(bot.name);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

const ICONS = {
  mic: '<path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/>',
  micOff: '<path d="M15 9.4V6a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 5.1 2.1M19 11a7 7 0 0 1-1.1 3.8M5 11a7 7 0 0 0 11.4 5.4M12 18v3M3 3l18 18"/>',
  people: '<path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1"/><circle cx="9.5" cy="7.5" r="3.5"/><path d="M21 19v-1a4 4 0 0 0-3-3.9M15.5 4.1a3.5 3.5 0 0 1 0 6.8"/>',
  leave: '<path d="M4.5 14.2c-1-.9-1-2.4 0-3.3 4.2-3.9 10.8-3.9 15 0 1 .9 1 2.4 0 3.3l-1.6 1.4a1.5 1.5 0 0 1-2 0l-1.4-1.3a1.5 1.5 0 0 1-.4-1.5l.3-1a9 9 0 0 0-4.8 0l.3 1a1.5 1.5 0 0 1-.4 1.5l-1.4 1.3a1.5 1.5 0 0 1-2 0Z"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
}

// ---------- sign-in ----------

async function boot() {
  show('boot');
  try {
    const { state: s } = await api('/api/state');
    if (s === 'signed-in') return loadLobby();
  } catch {
    // fall through to sign-in, which shows its own errors
  }
  showSignIn();
}

function showSignIn(message = '') {
  show('signin');
  $('#signin-status').textContent = message;
  $('#signin-btn').disabled = false;
}

async function signIn() {
  const btn = $('#signin-btn');
  const status = $('#signin-status');
  btn.disabled = true;
  // Open the tab now, inside the click, so the browser doesn't block it.
  const tab = window.open('about:blank', '_blank');
  try {
    const { loginUrl } = await api('/api/login', 'POST');
    if (tab) {
      tab.opener = null;
      tab.location.href = loginUrl;
      status.textContent = 'Finish signing in on the page that just opened. This updates by itself.';
    } else {
      status.innerHTML = '';
      const a = document.createElement('a');
      a.href = loginUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Open the sign-in page';
      status.append(a, ' and finish signing in there. This updates by itself.');
    }
  } catch (err) {
    tab?.close();
    return showSignIn(err.message);
  }
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    let s;
    try {
      s = await api('/api/state');
    } catch (err) {
      return showSignIn(err.message);
    }
    if (s.state === 'signed-in') return loadLobby();
    if (s.state === 'signed-out') return showSignIn(s.error || 'Sign-in did not finish. Try again.');
  }
}

// ---------- lobby ----------

async function loadLobby(message = '') {
  show('lobby');
  const list = $('#picker');
  list.innerHTML = '<p class="muted">Loading your Grok Bots…</p>';
  $('#lobby-error').textContent = message;
  $('#join').disabled = true;
  try {
    ({ bots: state.bots } = await api('/api/bots'));
  } catch (err) {
    if (err instanceof SignedOut) return showSignIn(err.message);
    list.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `Couldn't load your bots: ${err.message}`;
    const retry = document.createElement('button');
    retry.className = 'ghost';
    retry.textContent = 'Try again';
    retry.onclick = () => loadLobby();
    list.append(p, retry);
    return;
  }
  const ids = new Set(state.bots.map((b) => b.id));
  for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
  renderPicker();
}

function renderPicker() {
  const list = $('#picker');
  list.innerHTML = '';
  if (!state.bots.length) {
    list.innerHTML = '<p class="muted">No Grok Bots on this account yet. Create one in the Grok Bot app, then reload this page.</p>';
  }
  for (const bot of state.bots) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick';
    b.setAttribute('aria-pressed', String(state.selected.has(bot.id)));
    const text = document.createElement('span');
    text.className = 'pick-text';
    const name = document.createElement('strong');
    name.textContent = bot.name;
    const voice = document.createElement('small');
    voice.textContent = bot.voice ? `Voice: ${bot.voice}` : 'Default voice';
    text.append(name, voice);
    const check = document.createElement('span');
    check.className = 'check';
    check.setAttribute('aria-hidden', 'true');
    b.append(avatar(bot), text, check);
    b.onclick = () => {
      if (state.selected.has(bot.id)) state.selected.delete(bot.id);
      else state.selected.add(bot.id);
      b.setAttribute('aria-pressed', String(state.selected.has(bot.id)));
      updateJoin();
    };
    list.append(b);
  }
  updateJoin();
}

function updateJoin() {
  const n = state.selected.size;
  $('#join').disabled = n === 0;
  $('#count').textContent = n ? `${n} ${n === 1 ? 'bot' : 'bots'} selected` : 'Pick at least one bot';
}

// ---------- audio ----------

const WORKLET = `
class Mic extends AudioWorkletProcessor {
  constructor() { super(); this.size = Math.round(sampleRate * 0.04); this.buf = new Float32Array(this.size); this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('mic', Mic);`;

async function startAudio() {
  const ctx = new AudioContext();
  try {
    await ctx.resume();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      const name = err?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new Error('Microphone access is blocked. Allow it for this page, then join again.');
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        throw new Error('No microphone found. Connect one, then join again.');
      }
      throw new Error(`Couldn't open the microphone (${name || 'unknown error'}). Check it isn't in use, then join again.`);
    }
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'mic');
    const sink = ctx.createGain();
    sink.gain.value = 0; // keeps the worklet running without playing the mic back
    source.connect(node).connect(sink).connect(ctx.destination);
    node.port.onmessage = ({ data }) => {
      const level = rms(data);
      state.level = state.level * 0.7 + level * 0.3;
      state.call?.micAudio(floatTo16(resample(data, ctx.sampleRate, SAMPLE_RATE)), level);
    };
    return { ctx, stream, nodes: [source, node, sink] };
  } catch (err) {
    ctx.close();
    throw err;
  }
}

function stopAudio() {
  const a = state.audio;
  state.audio = null;
  if (!a) return;
  for (const n of a.nodes) n.disconnect();
  for (const t of a.stream.getTracks()) t.stop();
  a.ctx.close();
}

// ---------- call ----------

async function join() {
  const btn = $('#join');
  btn.disabled = true;
  $('#lobby-error').textContent = '';
  try {
    state.audio = await startAudio();
  } catch (err) {
    $('#lobby-error').textContent = err.message;
    return updateJoin();
  }
  const { ctx } = state.audio;
  state.call = new Call({
    mintVoice: (id) => api(`/api/bots/${encodeURIComponent(id)}/voice`, 'POST'),
    openSocket: (url, protocols) => new WebSocket(url, protocols),
    audio: {
      now: () => ctx.currentTime,
      play(samples, when) {
        const buf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
        buf.copyToChannel(samples, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(when);
        return {
          stop() {
            try {
              src.stop();
            } catch {
              // already stopped
            }
          },
        };
      },
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t),
    now: () => Date.now(),
  });
  state.call.join(
    state.bots.filter((b) => state.selected.has(b.id)),
    state.bots,
  );
  state.tiles.clear();
  $('#grid').innerHTML = '';
  setPeople(false);
  show('call');
  renderMute();
  state.frame = requestAnimationFrame(renderCall);
}

function leave() {
  cancelAnimationFrame(state.frame);
  state.call?.leave();
  state.call = null;
  stopAudio();
  setPeople(false);
  show('lobby');
  renderPicker();
}

function toggleMute() {
  const call = state.call;
  call.setMuted(!call.muted);
  for (const t of state.audio.stream.getAudioTracks()) t.enabled = !call.muted;
  renderMute();
}

function renderMute() {
  const muted = state.call.muted;
  const btn = $('#mute');
  btn.setAttribute('aria-pressed', String(muted));
  btn.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
  btn.innerHTML = icon(muted ? 'micOff' : 'mic');
}

const STATUS_TEXT = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  speaking: 'Speaking',
  thinking: 'Thinking…',
  listening: 'Listening to you',
  idle: '',
};

function makeTile(bot) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.style.setProperty('--c', bot ? colorOf(bot) : 'var(--accent)');
  const face = bot ? avatar(bot) : avatar({ name: USER, shape: 'circle', color: null });
  if (!bot) face.style.setProperty('--c', 'var(--accent)');
  const eq = document.createElement('div');
  eq.className = 'eq';
  eq.innerHTML = '<i></i><i></i><i></i><i></i>';
  const label = document.createElement('div');
  label.className = 'label';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = bot ? bot.name : `You (${USER})`;
  const status = document.createElement('span');
  status.className = 'status';
  label.append(name, status);
  tile.append(face, eq, label);
  return { tile, status, last: '' };
}

function renderCall() {
  const call = state.call;
  if (!call) return;
  const view = call.view();
  const grid = $('#grid');
  if (!state.tiles.has('you')) {
    const t = makeTile(null);
    t.tile.classList.add('you');
    state.tiles.set('you', t);
    grid.append(t.tile);
  }
  const you = state.tiles.get('you');
  you.tile.style.setProperty('--lvl', call.muted ? 0 : Math.min(1, state.level * 8).toFixed(3));
  const youKey = `${call.muted}|${view.userSpeaking}`;
  if (you.last !== youKey) {
    you.last = youKey;
    you.tile.dataset.status = call.muted ? 'muted' : view.userSpeaking ? 'speaking' : 'idle';
    you.status.textContent = call.muted ? 'Muted' : '';
  }
  const ids = new Set(view.bots.map((b) => b.id));
  for (const [id, t] of state.tiles) {
    if (id !== 'you' && !ids.has(id)) {
      t.tile.remove();
      state.tiles.delete(id);
    }
  }
  for (const b of view.bots) {
    let t = state.tiles.get(b.id);
    if (!t) {
      t = makeTile(b);
      state.tiles.set(b.id, t);
      grid.append(t.tile);
    }
    const key = `${b.status}|${b.error}`;
    if (t.last !== key) {
      t.last = key;
      t.tile.dataset.status = b.status;
      t.status.textContent = b.status === 'error' ? b.error : STATUS_TEXT[b.status];
      t.tile.setAttribute('aria-label', `${b.name}${t.status.textContent ? `, ${t.status.textContent}` : ''}`);
    }
  }
  grid.dataset.count = String(Math.min(view.bots.length + 1, 7));
  $('#empty-hint').hidden = view.bots.length > 0;
  if (!$('#people').hidden) renderPeople(view);
  state.frame = requestAnimationFrame(renderCall);
}

// ---------- per-bot selection during the call ----------

function setPeople(open) {
  $('#people').hidden = !open;
  $('#people-btn').setAttribute('aria-expanded', String(open));
  if (open) {
    $('#people-list').innerHTML = '';
    renderPeople(state.call.view());
    $('#people-close').focus();
  }
}

function renderPeople(view) {
  const list = $('#people-list');
  const inCall = new Map(view.bots.map((b) => [b.id, b]));
  for (const bot of state.bots) {
    let row = list.querySelector(`[data-id="${CSS.escape(bot.id)}"]`);
    if (!row) {
      row = document.createElement('button');
      row.type = 'button';
      row.className = 'person';
      row.dataset.id = bot.id;
      row.setAttribute('role', 'switch');
      const text = document.createElement('span');
      text.className = 'pick-text';
      const name = document.createElement('strong');
      name.textContent = bot.name;
      text.append(name, document.createElement('small'));
      const sw = document.createElement('span');
      sw.className = 'switch';
      sw.setAttribute('aria-hidden', 'true');
      row.append(avatar(bot), text, sw);
      row.onclick = () => {
        if (state.call.links.has(bot.id)) state.call.removeBot(bot.id);
        else state.call.addBot(bot);
        renderPeople(state.call.view());
      };
      list.append(row);
    }
    const here = inCall.get(bot.id);
    row.setAttribute('aria-checked', String(Boolean(here)));
    row.querySelector('small').textContent = here ? 'In the call' : 'Not in the call';
  }
}

// ---------- wiring ----------

$('#signin-btn').onclick = signIn;
$('#join').onclick = join;
$('#mute').onclick = toggleMute;
$('#leave').onclick = leave;
$('#leave').innerHTML = icon('leave');
$('#people-btn').innerHTML = icon('people');
$('#people-btn').onclick = () => setPeople($('#people').hidden);
$('#people-close').onclick = () => {
  setPeople(false);
  $('#people-btn').focus();
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#people').hidden) {
    setPeople(false);
    $('#people-btn').focus();
  }
});
window.addEventListener('pagehide', () => state.call?.leave());

boot();
