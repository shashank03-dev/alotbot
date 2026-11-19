import { CONNECT_TIMEOUT_MS, Call, SAMPLE_RATE, TOOL_TIMEOUT_MS, USER, exportMarkdown, floatTo16, resample, rms } from './core.js';

const $ = (sel) => document.querySelector(sel);
const screens = ['boot', 'signin', 'lobby', 'call'];

const state = {
  bots: [], // every Grok Bot on the account
  memory: null, // the last call's summary, open items and notes, given to the bots on join
  selected: new Set(),
  call: null,
  audio: null, // { ctx, stream, nodes }
  level: 0,
  tiles: new Map(),
  frame: 0,
  panel: null, // 'people' | 'tasks' | 'timeline' | null
  timelineSeq: 0, // last timeline entry drawn
  toastTimer: 0,
  tasksSeen: -1, // task state last drawn: `${notepadVersion}|${direction.length}`
};

// ---------- helpers ----------

class SignedOut extends Error {}

/** This run's key, from the link the server printed (#t=...). Kept for this tab only, and taken out of the address bar. */
const TOKEN = (() => {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('t');
  if (fromLink) {
    try { sessionStorage.setItem('alotbot-token', fromLink); } catch {}
    history.replaceState(null, '', location.pathname);
    return fromLink;
  }
  try { return sessionStorage.getItem('alotbot-token') ?? ''; } catch { return ''; }
})();

async function api(path, method = 'GET', payload = undefined, timeoutMs = 0) {
  let res;
  const headers = { 'x-alotbot-token': TOKEN };
  const opts = payload === undefined ? { method, headers } : { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload) };
  if (timeoutMs) opts.signal = AbortSignal.timeout(timeoutMs);
  try {
    res = await fetch(path, opts);
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new Error(`No answer within ${timeoutMs / 1000} s.`);
    throw new Error('Alotbot server is not reachable. Is it still running?');
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
  timeline: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  tasks: '<path d="M8 3h8l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2"/><path d="M8 3v3h8V3M8 12h8M8 16h5"/>',
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
  try {
    ({ memory: state.memory } = await api('/api/memory'));
  } catch {
    state.memory = null; // bots just start fresh
  }
  renderMemoryHint();
}

function renderMemoryHint() {
  const m = state.memory;
  $('#memory-hint').hidden = !(m && (m.summary || m.actionItems.length || m.notes.length));
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

/** How long the echo-safe output may take to connect before plain output is used instead. */
const LOOPBACK_TIMEOUT_MS = 3000;

/**
 * Bot voices go to the speakers through a local WebRTC loopback and an <audio> element, not straight from
 * Web Audio. Chrome's echo canceller is reported to skip Web Audio output, so without this the mic hears the
 * bots and they cut each other off or answer their own words.
 */
async function loopbackOutput(ctx) {
  const dest = ctx.createMediaStreamDestination();
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  const el = new Audio();
  const close = () => {
    a.close();
    b.close();
    el.pause();
    el.srcObject = null;
  };
  try {
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
    const remote = new Promise((resolve) => {
      b.ontrack = (e) => resolve(e.streams[0] ?? new MediaStream([e.track]));
    });
    const connected = new Promise((resolve, reject) => {
      b.onconnectionstatechange = () => {
        if (b.connectionState === 'connected') resolve();
        else if (b.connectionState === 'failed') reject(new Error('loopback failed'));
      };
    });
    for (const t of dest.stream.getAudioTracks()) a.addTrack(t, dest.stream);
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
    el.srcObject = await remote;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('loopback timed out')), LOOPBACK_TIMEOUT_MS);
    });
    try {
      await Promise.race([Promise.all([connected, el.play()]), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return { node: dest, close };
  } catch (err) {
    close();
    throw err;
  }
}

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
    let loopback = null;
    try {
      loopback = await loopbackOutput(ctx);
    } catch (err) {
      console.warn('Echo-safe output unavailable, playing bots directly:', err);
    }
    return { ctx, stream, nodes: [source, node, sink], out: loopback?.node ?? ctx.destination, loopback };
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
  a.loopback?.close();
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
  const { ctx, out } = state.audio;
  state.call = new Call({
    mintVoice: (id) => api(`/api/bots/${encodeURIComponent(id)}/voice`, 'POST', undefined, CONNECT_TIMEOUT_MS),
    callTool: (id, req) => api(`/api/bots/${encodeURIComponent(id)}/tool`, 'POST', req, TOOL_TIMEOUT_MS),
    landedWork: async (id, callId, after) => (await api(`/api/bots/${encodeURIComponent(id)}/landed`, 'POST', { callId, after }, TOOL_TIMEOUT_MS)).work,
    openSocket: (url, protocols) => new WebSocket(url, protocols),
    audio: {
      now: () => ctx.currentTime,
      play(samples, when) {
        const buf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
        buf.copyToChannel(samples, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(out);
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
    state.memory,
  );
  if (!state.audio.loopback) {
    state.call.event('error', 'Echo protection could not start: use headphones, or the bots may hear themselves');
  }
  $('#saved').hidden = true;
  $('#leave').disabled = false;
  $('#wrap-status').hidden = true;
  $('#say-text').value = '';
  setSayEnabled(true);
  state.tiles.clear();
  $('#grid').innerHTML = '';
  state.tasksSeen = -1;
  setPanel(null);
  show('call');
  renderMute();
  state.frame = requestAnimationFrame(renderCall);
}

/** Leave: one bot saves a summary (up to 20 s), then the call is saved and shown in the lobby. */
async function leave() {
  const call = state.call;
  if (!call || call.phase !== 'in-call') return;
  $('#leave').disabled = true;
  setSayEnabled(false);
  $('#wrap-status').hidden = false;
  const data = await call.wrapUp();
  cancelAnimationFrame(state.frame);
  call.leave();
  if (state.call === call) state.call = null;
  stopAudio();
  setPanel(null);
  show('lobby');
  renderPicker();
  // A call where nothing was said and no tasks changed is not saved, so it can't wipe the last call's memory.
  if (data.lines.length || data.notepadChanged) await saveCall(data);
}

async function saveCall(data) {
  const markdown = exportMarkdown(data, (ms) => new Date(ms).toLocaleString());
  state.memory = data.memory;
  renderMemoryHint();
  const card = $('#saved');
  card.hidden = false;
  $('#saved-summary').textContent = data.summary || 'No summary was saved: no bot answered in time.';
  const items = data.memory.actionItems;
  $('#saved-items').replaceChildren(...items.map((a) => listItem(a, '')));
  $('#saved-items-wrap').hidden = !items.length;
  const download = $('#saved-download');
  URL.revokeObjectURL(download.href);
  download.href = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
  download.download = `alotbot-${new Date(data.endedAt).toISOString().slice(0, 16).replace(/:/g, '-')}.md`;
  const where = $('#saved-where');
  where.className = 'muted';
  where.textContent = 'Saving…';
  try {
    const { file } = await api('/api/calls', 'POST', { memory: data.memory, markdown });
    where.textContent = `Saved to .data/${file}. The bots get this summary and open action items in your next call.`;
  } catch (err) {
    where.className = 'error';
    where.textContent = `Couldn't save the call: ${err.message.replace(/\.?$/, '.')} Download it instead.`;
  }
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
  quiet: 'Staying quiet',
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
    const key = `${b.status}|${b.error}|${b.search}`;
    if (t.last !== key) {
      t.last = key;
      t.tile.dataset.status = b.status;
      t.status.textContent =
        b.status === 'error' ? b.error : [STATUS_TEXT[b.status], b.search ? '' : 'Search off'].filter(Boolean).join(' · ');
      t.tile.setAttribute('aria-label', `${b.name}${t.status.textContent ? `, ${t.status.textContent}` : ''}`);
    }
  }
  grid.dataset.count = String(Math.min(view.bots.length + 1, 7));
  $('#empty-hint').hidden = view.bots.length > 0;
  if (state.panel === 'people') renderPeople(view);
  if (state.panel === 'timeline') renderTimeline(view);
  const tasksKey = `${view.notepadVersion}|${view.direction.length}`;
  if (tasksKey !== state.tasksSeen) {
    if (state.panel === 'tasks') renderTasks(view);
    if (state.panel === 'tasks' || state.tasksSeen === -1) state.tasksSeen = tasksKey;
  }
  state.frame = requestAnimationFrame(renderCall);
}

// ---------- per-bot selection during the call ----------

/** Opens one side panel ('people', 'tasks' or 'timeline'), or closes them with null. */
function setPanel(name) {
  state.panel = name;
  for (const p of ['people', 'tasks', 'timeline']) {
    $(`#${p}`).hidden = p !== name;
    $(`#${p}-btn`).setAttribute('aria-expanded', String(p === name));
  }
  if (name === 'people') {
    $('#people-list').innerHTML = '';
    renderPeople(state.call.view());
  }
  if (name === 'tasks') {
    const view = state.call.view();
    renderTasks(view);
    state.tasksSeen = `${view.notepadVersion}|${view.direction.length}`;
  }
  if (name === 'timeline') {
    $('#timeline-list').replaceChildren();
    state.timelineSeq = 0;
    renderTimeline(state.call.view());
    const list = $('#timeline-list');
    list.scrollTop = list.scrollHeight;
  }
  if (name) $(`#${name}-close`).focus();
}

function togglePanel(name) {
  setPanel(state.panel === name ? null : name);
}

function closePanel() {
  const open = state.panel;
  setPanel(null);
  $(`#${open}-btn`).focus();
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

// ---------- shared tasks ----------

function hasTasks(view) {
  return view.direction.length + view.tasks.length > 0;
}

function listItem(text, meta, cls = '') {
  const li = document.createElement('li');
  if (cls) li.className = cls;
  const p = document.createElement('span');
  p.textContent = text;
  li.append(p);
  if (meta) {
    const m = document.createElement('small');
    m.textContent = meta;
    li.append(m);
  }
  return li;
}

function renderTasks(view) {
  const section = (id, items) => {
    $(`#${id}`).hidden = !items.length;
    const list = $(`#${id} ul`);
    list.replaceChildren(...items);
  };
  section('direction', view.direction.map((d, i, all) => listItem(d, i === all.length - 1 ? 'Latest' : '')));
  section(
    'task-list',
    view.tasks.map((t) =>
      listItem(`${t.id}. ${t.text}`, t.done ? `Done by ${t.doneBy}` : `Added by ${t.by}`, t.done ? 'task done' : 'task'),
    ),
  );
  $('#tasks-empty').hidden = hasTasks(view);
}

// ---------- message box, stop hotkey, timeline ----------

function setSayEnabled(on) {
  $('#say-text').disabled = !on;
  $('#say-send').disabled = !on;
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => (el.hidden = true), 2500);
}

function sendMessage(e) {
  e.preventDefault();
  const input = $('#say-text');
  if (!input.value.trim()) return;
  if (state.call?.sendText(input.value)) input.value = '';
  else toast('No bot is ready to hear that yet.');
}

function stopAll() {
  if (state.call?.phase !== 'in-call') return;
  state.call.stopAll();
  toast('Stopped every bot. They wait for you.');
}

const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/** Appends timeline entries not drawn yet, and drops ones the call no longer keeps. */
function renderTimeline(view) {
  const list = $('#timeline-list');
  const fresh = view.timeline.filter((e) => e.seq > state.timelineSeq);
  $('#timeline-empty').hidden = view.timeline.length > 0;
  if (!fresh.length) return;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  for (const e of fresh) {
    const li = document.createElement('li');
    li.dataset.kind = e.kind;
    const t = document.createElement('time');
    t.textContent = clock(e.at);
    const text = document.createElement('span');
    text.textContent = e.text;
    li.append(t, text);
    list.append(li);
  }
  state.timelineSeq = fresh.at(-1).seq;
  while (list.children.length > view.timeline.length) list.firstElementChild.remove();
  if (atBottom) list.scrollTop = list.scrollHeight;
}

// ---------- wiring ----------

$('#signin-btn').onclick = signIn;
$('#join').onclick = join;
$('#mute').onclick = toggleMute;
$('#leave').onclick = leave;
$('#leave').innerHTML = icon('leave');
$('#people-btn').innerHTML = icon('people');
$('#people-btn').onclick = () => togglePanel('people');
$('#people-close').onclick = closePanel;
$('#tasks-btn').innerHTML = icon('tasks');
$('#tasks-btn').onclick = () => togglePanel('tasks');
$('#tasks-close').onclick = closePanel;
$('#timeline-btn').innerHTML = icon('timeline');
$('#timeline-btn').onclick = () => togglePanel('timeline');
$('#timeline-close').onclick = closePanel;
$('#say-send').innerHTML = icon('send');
$('#say').onsubmit = sendMessage;
// Esc: closes the side panel you are in; anywhere else in a call, it stops every bot.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.panel && $(`#${state.panel}`).contains(document.activeElement)) closePanel();
  else stopAll();
});
window.addEventListener('pagehide', () => state.call?.leave());

boot();
