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
/** Longest call summary kept. */
export const SUMMARY_MAX_CHARS = 2000;
/** Most notes plus tasks the notepad holds. */
export const NOTEPAD_MAX = 200;
/** How long Leave waits for a bot to save the call summary before ending anyway. */
export const WRAP_UP_MS = 20000;
/** How many times Leave asks for the summary before ending without one. */
export const WRAP_UP_ASKS = 2;
/** Most action items kept from one summary. */
export const ACTION_ITEMS_MAX = 50;
/** Lines of the call given to the bot writing the summary. */
export const SUMMARY_LINES = 300;
/** Longest message Shashank can type to the bots. */
export const MESSAGE_MAX_CHARS = 1000;
/** Timeline entries kept (oldest dropped first). */
export const TIMELINE_MAX = 500;
/** A correction this short ("no", "wait, stop") is a nudge, not a new direction to pin. */
export const DIRECTION_MIN_WORDS = 3;
/** Once the mic is loud, keep sending it this long, so the quieter parts of Shashank's words get through too. */
export const GATE_HOLD_MS = 600;
/** A host line this long or shorter can be a "stop talking" command. */
export const STOP_MAX_WORDS = 8;
/** A bot line is a repeat if it matches one of this many recent bot lines. */
export const REPEAT_LOOKBACK = 6;
/** Replies a bot is asked for in a row after using a tool (spoken or not) before its turn simply ends. */
export const MAX_TOOL_ROUNDS = 3;
/** In a one-on-one, this much quiet from Shashank after the bot's reply means the conversation is over. */
export const FOCUS_IDLE_MS = 20000;
/** A host line this long or shorter can be a "we're done" line ("thanks", "got it"). */
export const CLOSING_MAX_WORDS = 6;
/** A reply asked for that hasn't started after this long is given up on, and the talk moves on. */
export const RESPONSE_START_MS = 10000;
/** A reply that has started but sent nothing for this long is stopped, and the talk moves on. */
export const RESPONSE_STALL_MS = 45000;
/** A bot whose voice session isn't up this long after it was asked for is marked as failed. */
export const CONNECT_TIMEOUT_MS = 15000;
/** How long the page waits for Grok Bot to run a call tool (the server gives up at 20 s). */
export const TOOL_TIMEOUT_MS = 25000;

// ---------- text ----------

export function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Words that are never a bot's short name on their own: "Shashank's Bot" does not shrink to "bot". */
const GENERIC_NAME_WORDS = new Set(['bot', 'bots', 'ai', 'assistant', 'agent', 'grok']);

/**
 * The ways a bot's name can be said: the full name, the name without its owner ("Shashank's X bot" → "x bot"),
 * and each of those run together, as speech-to-text often writes them ("xbot", "mybot"). Normalized.
 */
function ownForms(name) {
  const full = normalize(name);
  const forms = new Set(full ? [full] : []);
  const short = normalize(String(name).replace(/^\s*\S+?['’]s\s+/u, ''));
  const words = short.split(' ');
  if (short && short !== full && !(words.length === 1 && (GENERIC_NAME_WORDS.has(short) || short.length < 3))) forms.add(short);
  for (const f of [...forms]) if (f.includes(' ')) forms.add(f.replaceAll(' ', ''));
  return forms;
}

/**
 * Every way each bot can be named, as [{ id, form }]. A full name always counts; a short form counts only
 * if no other bot has the same one, so a short name never points at the wrong bot.
 */
export function nameForms(bots) {
  const fulls = new Set(bots.map((b) => normalize(b.name)));
  const holders = new Map();
  for (const b of bots) for (const f of ownForms(b.name)) holders.set(f, [...(holders.get(f) ?? []), b.id]);
  return [...holders].flatMap(([form, ids]) => (fulls.has(form) ? ids : ids.length === 1 ? ids : []).map((id) => ({ id, form })));
}

/** Words that belong to a bot's name, in any of its forms. */
function nameWordsOf(names) {
  return new Set(names.flatMap((n) => [...ownForms(n)].flatMap((f) => f.split(' '))));
}

/** The bot named first in the text (longest name wins on a tie), or null. Short names count (see nameForms). */
export function findAddressee(text, bots) {
  const hay = ` ${normalize(text)} `;
  let best = null;
  for (const { id, form } of nameForms(bots)) {
    const i = hay.indexOf(` ${form} `);
    if (i < 0) continue;
    if (!best || i < best.i || (i === best.i && form.length > best.len)) best = { id, i, len: form.length };
  }
  return best ? best.id : null;
}

/** True if the text has a correction word ("no", "wait", "stop", "actually", "wrong") as a whole word. */
export function hasCorrection(text) {
  const words = new Set(normalize(text).split(' '));
  return CORRECTION_WORDS.some((w) => words.has(w));
}

/** Words a bot says when it really means to pass ("Pass.", "Nothing to add from me.", "(silence)"). */
const FILLER_CORE = new Set(['pass', 'passing', 'passed', 'push', 'skip', 'skipping', 'skipped', 'silence', 'silent', 'silently', 'quiet', 'quietly', 'nothing', 'none', 'suggestion', 'suggestions', 'comment', 'comments']);
const FILLER_OTHER = new Set([
  'no', 'to', 'add', 'adding', 'more', 'from', 'me', 'i', 'im', 'ill', 'will', 'have', 'ive', 'got', 'here', 'for', 'now', 'this', 'that',
  'thats', 'one', 'time', 'turn', 'my', 'ok', 'okay', 'hmm', 'um', 'uh', 'mm', 'yeah', 'sure', 'fine', 'the', 'a', 'tool', 'using', 'use',
  'call', 'calling', 'wait', 'waiting', 'host', 'stay', 'staying', 'stays', 'remain', 'remaining', 'keep', 'keeping', 'thanks', 'thank', 'you', 'all', 'set', 'good', 'at', 'on',
]);

/** Text a bot spoke with stage directions removed ("*stays silent*", "(pause)", "[silence]"). */
export function spokenWords(text) {
  const bare = cleanTranscript(text).replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ');
  return normalize(bare).split(' ').filter(Boolean);
}

/**
 * True if a bot's line is only a spoken pass ("Pass.", "Silence.", "Nothing to add from me.") or only stage directions.
 * Such a line is never passed on to the other bots, so they don't copy it. `names`: bot names, allowed in the line.
 */
export function isFiller(text, names = []) {
  const words = spokenWords(text);
  if (!words.length) return true;
  const nameWords = nameWordsOf(names);
  return words.some((w) => FILLER_CORE.has(w)) && words.every((w) => FILLER_CORE.has(w) || FILLER_OTHER.has(w) || nameWords.has(w));
}

/** True once a bot's words so far include one that can't be part of a spoken pass, so its voice can be played. */
export function hasRealWords(text, names = []) {
  const nameWords = nameWordsOf(names);
  return spokenWords(text).some((w) => !FILLER_CORE.has(w) && !FILLER_OTHER.has(w) && !nameWords.has(w));
}

/** Every bot named in the text. A name inside a longer named one ("Bot" in "My Bot") doesn't count on its own. */
export function namedBots(text, bots) {
  let hay = ` ${normalize(text)} `;
  const found = [];
  for (const { id, form } of nameForms(bots).sort((x, y) => y.form.length - x.form.length)) {
    if (!hay.includes(` ${form} `)) continue;
    if (!found.includes(id)) found.push(id);
    hay = hay.split(` ${form} `).join('  ');
  }
  return found;
}

const GROUP_WORDS = ['everyone', 'everybody', 'guys', 'anyone', 'anybody', 'folks', 'yall', 'you all', 'all of you'];

/** True if the host is talking to every bot ("everyone", "guys", "all of you"). */
export function isGroupAddress(text) {
  const hay = ` ${normalize(text)} `;
  return GROUP_WORDS.some((w) => hay.includes(` ${w} `));
}

const CLOSING_KEYS = new Set(['thanks', 'thank', 'thx', 'done', 'perfect', 'bye', 'appreciate', 'helpful']);
const CLOSING_PHRASES = ['thats all', 'thats it', 'got it', 'makes sense', 'all good', 'im good'];
const CLOSING_FILLER = new Set([
  'ok', 'okay', 'cool', 'great', 'nice', 'awesome', 'alright', 'good', 'so', 'much', 'very', 'a', 'lot', 'you', 'that', 'thats', 'was',
  'it', 'all', 'for', 'now', 'the', 'help', 'really', 'got', 'makes', 'sense', 'im', 'i', 'yeah', 'yes', 'sounds', 'man',
  'everyone', 'everybody', 'guys',
]);

/** True if a short host line says the conversation is done ("thanks", "got it, thanks", "that's all"). `names`: bot names, allowed as filler. */
export function isClosing(text, names = []) {
  const norm = normalize(text);
  const words = norm.split(' ').filter(Boolean);
  if (!words.length || words.length > CLOSING_MAX_WORDS) return false;
  const nameWords = nameWordsOf(names);
  const keyed = words.some((w) => CLOSING_KEYS.has(w)) || CLOSING_PHRASES.some((p) => ` ${norm} `.includes(` ${p} `));
  return keyed && words.every((w) => CLOSING_KEYS.has(w) || CLOSING_FILLER.has(w) || nameWords.has(w));
}

/** What the bots are told about a one-on-one between Shashank and `focus` (a bot name), from `me`'s side. */
export function focusText(me, focus) {
  if (!focus) return '';
  if (focus === me) {
    return (
      `\n\n# One-on-one right now\n${USER} is talking with you one-on-one. The other bots are listening and stay quiet. ` +
      `Answer ${USER} directly and keep it a two-way conversation; don't hand the turn to another bot or bring others in unless ${USER} asks.`
    );
  }
  return (
    `\n\n# One-on-one right now\n${USER} is talking with ${focus} one-on-one. Stay completely silent: don't answer or comment, ` +
    `even when the topic is yours. When it is over you may be asked whether you have a suggestion.`
  );
}

/** The one-off note asking a bot that listened to a one-on-one for a suggestion. */
export function suggestionPrompt(focus) {
  return (
    `[Call]: ${USER}'s one-on-one with ${focus} just ended, and you listened to all of it. ` +
    `Speak only if you have a specific suggestion or correction that clearly helps ${USER} with that topic and you fully understand it; ` +
    `then say it in one or two short sentences. Otherwise call the pass tool without speaking: no "pass", no "silence", no "nothing to add". ` +
    `Don't repeat or sum up what was said, and don't speak just to be polite.`
  );
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

/** Words that make a short host line a "stop talking" command. */
const STOP_KEYS = new Set(['stop', 'wait', 'hold', 'hang', 'shut', 'quiet', 'shush', 'shh', 'pause', 'enough', 'silence', 'let', 'sec', 'second', 'moment', 'minute']);
/** Words that can sit around a stop key without changing what it means ("okay guys, stop talking please"). */
const STOP_FILLER = new Set([
  'ok', 'okay', 'hey', 'no', 'oh', 'guys', 'everyone', 'everybody', 'all', 'you', 'bots', 'please', 'just', 'now', 'a', 'one',
  'on', 'up', 'be', 'it', 'me', 'give', 'talking', 'speaking', 'talk', 'speak', 'finish', 'listen', 'there', 'right', 'thats', 'for',
]);

/** True if a host line only tells the bots to stop ("stop", "wait", "hold on", "be quiet", "let me talk"). `names`: bot names, allowed as filler. */
export function isStopCommand(text, names = []) {
  const words = normalize(text).split(' ').filter(Boolean);
  if (!words.length || words.length > STOP_MAX_WORDS) return false;
  const nameWords = nameWordsOf(names);
  return words.some((w) => STOP_KEYS.has(w)) && words.every((w) => STOP_KEYS.has(w) || STOP_FILLER.has(w) || nameWords.has(w));
}

/**
 * True for empty speech, or speech that is mostly words a bot just said (speaker echo).
 * Pass '' as `recentBotText` when no bot audio was playing: then only empty speech is dropped.
 * A correction word the bots did not just say can only be the host's, so a line with one is kept;
 * a bot's own "no" or "actually" coming back through the speakers is still echo.
 */
export function isNoiseOrEcho(heard, recentBotText) {
  const words = normalize(heard).split(' ').filter(Boolean);
  if (!words.length) return true;
  const pool = new Set(normalize(recentBotText).split(' ').filter(Boolean));
  if (!pool.size) return false;
  if (CORRECTION_WORDS.some((w) => words.includes(w) && !pool.has(w))) return false;
  const hits = words.filter((w) => pool.has(w)).length;
  return hits / words.length >= 0.8;
}

const FILLER_WORDS = new Set(['that', 'this', 'with', 'have', 'what', 'your', 'just', 'like', 'about', 'they', 'them', 'there', 'their', 'from', 'will', 'would', 'could', 'should', 'really', 'yeah', 'okay', 'sure', 'well', 'into', 'also', 'here', 'then', 'than', 'were', 'been']);
const contentWords = (text) => new Set(normalize(text).split(' ').filter((w) => w.length >= 4 && !FILLER_WORDS.has(w)));

/** True if `text` says again what one of `earlier` already said (most of the shorter line's key words match). */
export function isRepeat(text, earlier) {
  const a = contentWords(text);
  if (a.size < 3) return false;
  return earlier.some((e) => {
    const b = contentWords(e);
    if (b.size < 3) return false;
    let same = 0;
    for (const w of a) if (b.has(w)) same++;
    return same / Math.min(a.size, b.size) >= 0.8;
  });
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
export const PASS_TOOL = fn(
  'pass',
  'Skip your turn when you have nothing useful to add. It is a silent action: produce no speech with it, and never say "pass", "silence" or that you have nothing to add.',
);
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

export const SAVE_SUMMARY_TOOL = fn(
  'save_summary',
  'Save the summary and action items of this call. Only use it when the call asks you to, as it ends.',
  {
    summary: { type: 'string', description: 'Three to six sentences: what was discussed and decided.' },
    action_items: { type: 'array', items: { type: 'string' }, description: 'Each concrete next step, with who does it if known.' },
  },
  ['summary', 'action_items'],
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
  SAVE_SUMMARY_TOOL,
];

/** xAI's built-in search tools: they run on xAI's side, so the call never sees or answers them. */
export const SEARCH_TOOLS = [{ type: 'web_search' }, { type: 'x_search' }];

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
export function cleanNote(text, max = NOTE_MAX_CHARS) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** What bots are told about the last call: its summary and open action items. */
export function lastCallText(memory) {
  if (!memory || (!memory.summary && !memory.actionItems.length && !memory.notes.length)) return '';
  let text = `\n\n# Your last call with ${USER}\n`;
  if (memory.summary) text += `Summary: ${memory.summary}\n`;
  if (memory.actionItems.length) text += `Open action items:\n${memory.actionItems.map((a) => `- ${a}`).join('\n')}\n`;
  return `${text}The shared notepad starts with the notes and open action items from that call. Bring them up when they fit; don't recite them.`;
}

/** The one-off instructions for the bot writing the summary as the call ends. */
export function wrapUpInstructions(lines, notes, tasks) {
  return (
    `${USER} is ending this group voice call now. Do not speak. Call the save_summary tool once, right now, with ` +
    `a summary of three to six sentences on what was discussed and decided, and every concrete next step as an action item ` +
    `(with who does it, if known). Use only what is in this record.\n\n` +
    `${contextText(lines.slice(-SUMMARY_LINES))}\n\nShared notepad:\n${notepadText(notes, tasks)}`
  );
}

/** Open action items for the next call: open notepad tasks plus the summary's items, without repeats. */
export function openItems(tasks, actionItems) {
  const seen = new Set();
  const out = [];
  for (const text of [...tasks.filter((t) => !t.done).map((t) => t.text), ...actionItems]) {
    const key = normalize(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** The call as Markdown: summary, action items, notes and the transcript. */
export function exportMarkdown(data, formatTime = (ms) => new Date(ms).toISOString()) {
  const mins = Math.max(0, Math.round((data.endedAt - data.startedAt) / 60000));
  const out = [`# Grok Call, ${formatTime(data.startedAt)}`, '', `Bots: ${data.bots.join(', ') || 'none'}  `, `Length: ${mins} min`, ''];
  out.push('## Summary', '', data.summary || '_No summary was saved._', '');
  out.push('## Action items', '', ...(data.memory.actionItems.length ? data.memory.actionItems.map((a) => `- [ ] ${a}`) : ['_None._']), '');
  const done = data.tasks.filter((t) => t.done);
  if (done.length) out.push('## Done during the call', '', ...done.map((t) => `- [x] ${t.text} (${t.doneBy})`), '');
  if (data.notes.length) out.push('## Notes', '', ...data.notes.map((n) => `- ${n.text} (${n.by})`), '');
  if (data.direction.length) out.push('## Current direction', '', ...data.direction.map((d) => `- ${d}`), '');
  out.push('## Transcript', '', ...(data.lines.length ? data.lines.map((l) => `**${tagOf(l)}:** ${l.text}  `) : ['_Nothing was said._']), '');
  return out.join('\n');
}

/**
 * Grok Bot's own call instructions are written for a one-to-one phone call. These rules adapt them to a group call.
 * `canSendTasks`: the bot has its send_task tool here.
 */
export function groupRulesText(canSendTasks) {
  return (
    `\n\n# Group call rules (these override anything above)\n` +
    `- This is a group call, not a one-to-one phone call. There is no end_the_call here: a goodbye, "stop" or "wait" from the host never ends the call. ` +
    `"Stop" or "wait" means go quiet. Use leave_call only when the host asks you to leave.\n` +
    `- Do not end a turn with a question just to keep the call going. Ask only when you need the host's answer.\n` +
    `- Tools are silent actions. Never say a tool's name, never say "pass" or "silence", and never describe what you are doing with a tool.\n` +
    `- No work_landed, work_overheard or user_message entries arrive on this call; ignore what the instructions above say about them.` +
    (canSendTasks
      ? `\n- send_task hands a job to your own agent, which has ${USER}'s computer, files, web, browser, mail and connected apps. ` +
        `Its result does not come back on this call: it lands in your chat with ${USER}. Say that in a few words when you send a job. ` +
        `If ${USER} asks for the result later, look for it with search_conversations, scope "this-chat".`
      : '')
  );
}

export function groupInstructions(base, me, roster, invitable = [], direction = [], memory = null, focus = null, canSendTasks = false) {
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
    `Never repeat a point already made in the call; if you have nothing new, pass. ` +
    `When the host says stop or wait, every bot goes quiet until the host speaks again. ` +
    `When the host names one bot, that is a one-on-one: only that bot answers, and the others stay silent until it is over. ` +
    `and leave_call takes you out of the call. ` +
    `There is a shared notepad that every bot and ${USER} can see: write_note keeps a fact, decision or idea, add_task adds an action item, ` +
    `done_task ticks one off, and read_notes shows it all. A "[Notepad]:" message tells you someone changed it. ` +
    `You can search the web and X for current facts and posts; say in a few words that you are looking it up, and keep what you found short. ` +
    `Only the tools given here are available during this call.` +
    groupRulesText(canSendTasks) +
    lastCallText(memory) +
    directionText(direction) +
    focusText(me, focus)
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
    this.audioMs = 0; // audio generated so far for the current reply, played or not
    this.replyTimer = null;
    this.toolCalls = [];
    this.turn = null; // what this bot decided with a turn tool: { kind, target? }
    this.leaving = false; // used leave_call; removed once its goodbye has played
    this.search = true; // web and X search on; turned off if this session refuses them
    this.queued = null; // instructions for a reply to ask for once the current one ends
    this.joined = false; // has been ready at least once (so a later ready is a reconnect)
    this.toolRounds = 0; // follow-up replies after a tool, in a row
    this.harnessTools = []; // the bot's own Grok Bot call tools (send_task, search_conversations), run by Grok Bot
    this.harness = true; // those tools are on; turned off if this session refuses them
    this.lastError = ''; // why the voice setup was last refused
    this.connectTimer = null;
    this.watchTimer = null; // gives up on a reply that never starts or stalls
    this.replySeq = 0;
    this.pendingEventId = null; // event_id of the response.create waiting to start
    this.holdNext = false; // the next reply is a turn the call started: hold its voice until it says something real
    this.holding = false;
    this.held = []; // [itemKey, samples] held back
    this.toolsBusy = false; // waiting for Grok Bot to run one of the bot's call tools
    this.sessionGen = 0; // bumped per connection, so late tool results for a dead session are dropped
    this.tasksSent = new Set(); // send_task jobs already sent this call (normalized), so a job is never sent twice
  }

  /** Identifies this bot's part of the call to Grok Bot. */
  get callId() {
    return `${this.call.callId}-${this.bot.id}`;
  }

  /** True if `name` is one of the bot's Grok Bot call tools and they are on. */
  isHarnessTool(name) {
    return this.harness && this.harnessTools.some((t) => t.name === name);
  }

  async connect(context) {
    this.ready = false;
    this.queue = [];
    this.status = this.retried ? 'reconnecting' : 'connecting';
    this.error = null;
    this.lastError = '';
    const gen = ++this.sessionGen;
    if (context) this.say(context);
    // The whole setup, from asking Grok Bot for a session to the session being ready, gets CONNECT_TIMEOUT_MS.
    this.clearConnectTimer();
    this.connectTimer = this.call.d.setTimer(() => {
      this.connectTimer = null;
      this.fail(new Error(this.lastError ? `Voice setup was refused: ${this.lastError}` : 'Timed out connecting.'));
    }, CONNECT_TIMEOUT_MS);
    let voice;
    try {
      voice = await this.call.d.mintVoice(this.bot.id);
    } catch (err) {
      if (gen === this.sessionGen) this.fail(err);
      return;
    }
    if (this.closed || gen !== this.sessionGen) return; // left the call, or already timed out
    this.base = voice.instructions;
    this.harnessTools = Array.isArray(voice.tools) ? voice.tools : [];
    const ws = this.call.d.openSocket(voice.url, [`xai-client-secret.${voice.clientSecret}`], this.bot.id);
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
        tools: [...TOOLS, ...(this.harness ? this.harnessTools : []), ...(this.search ? SEARCH_TOOLS : [])],
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
    return groupInstructions(this.base, this.bot.name, this.call.roster(), this.call.invitable().map((b) => b.name), this.call.direction, this.call.memory, this.call.focus?.bot.name ?? null, this.isHarnessTool('send_task'));
  }

  send(msg) {
    if (this.ready) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  say(text) {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  }

  /** Ask for a reply; `instructions` replace the session's instructions for this one reply only. */
  respond(instructions) {
    this.suppressNext = false;
    this.clearReplyTimer();
    this.pending = true;
    // Tagged, so an error about this request can be told apart from other errors.
    this.pendingEventId = `reply-${this.bot.id}-${++this.replySeq}`;
    // While the call ends, replies are text only: the API cannot force the save_summary call, so a bot that talks
    // instead must not be heard.
    const response = { ...(instructions ? { instructions } : {}), ...(this.call.phase === 'wrapping' ? { modalities: ['text'] } : {}) };
    this.send({ type: 'response.create', event_id: this.pendingEventId, ...(Object.keys(response).length ? { response } : {}) });
    this.watch(RESPONSE_START_MS);
  }

  /** Reply now, or as soon as the current reply (and any call tool it is waiting on) has ended. */
  respondWhenFree(instructions) {
    if (this.active || this.pending || this.toolsBusy) this.queued = instructions ?? '';
    else this.respond(instructions);
  }

  /** Asks for the reply that was waiting for this one to end. */
  flushQueued() {
    if (this.queued === null || this.toolsBusy || !this.ready) return;
    const q = this.queued;
    this.queued = null;
    this.respond(q);
  }

  /** (Re)starts the reply watchdog. */
  watch(ms) {
    this.clearWatch();
    this.watchTimer = this.call.d.setTimer(() => this.onStall(), ms);
  }

  clearWatch() {
    if (this.watchTimer !== null) this.call.d.clearTimer(this.watchTimer);
    this.watchTimer = null;
  }

  clearConnectTimer() {
    if (this.connectTimer !== null) this.call.d.clearTimer(this.connectTimer);
    this.connectTimer = null;
  }

  /** A reply never started, or went silent mid-way: drop it so nobody waits on it forever. */
  onStall() {
    this.watchTimer = null;
    if (this.active) {
      // A reply we already cut off only needed its end confirmed; one that went quiet on its own loses its turn.
      const cutOff = this.discard;
      this.send({ type: 'response.cancel' });
      this.active = false;
      this.discard = true; // if it ever ends, it counts as cut off
      this.holding = false;
      this.held = [];
      if (!cutOff) this.lost('went silent mid-reply');
      else this.flushQueued();
    } else if (this.pending) {
      this.pending = false;
      this.suppressNext = true; // if it starts late after all, it is cancelled
      this.lost('never started its reply');
    }
  }

  /** Its reply is gone. If Shashank was waiting on this bot, it answers him now; otherwise the turn moves on. */
  lost(why) {
    if (this.queued !== null) {
      this.call.event('error', `${this.bot.name} ${why}: asking it again`);
      this.flushQueued();
    } else {
      this.call.onReplyLost(this, why);
    }
  }

  /** Plays the voice held back for this reply. */
  release() {
    this.holding = false;
    for (const [key, samples] of this.held.splice(0)) this.call.player.enqueue(this.bot.id, key, samples);
  }

  /** Stop the current reply, or the one about to start. */
  cancel() {
    if (this.active) {
      this.discard = true;
      this.held = [];
      this.send({ type: 'response.cancel' });
    } else if (this.pending) {
      this.suppressNext = true;
      this.clearWatch();
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
      if (!this.active && !this.pending && !this.toolsBusy && this.ready) this.respond();
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
        this.clearConnectTimer();
        this.ready = true;
        this.readyAt = this.call.d.now();
        this.status = 'ready';
        for (const msg of this.queue.splice(0)) this.ws.send(JSON.stringify(msg));
        return this.call.onReady(this);
      case 'response.created':
        this.clearReplyTimer();
        this.watch(RESPONSE_STALL_MS);
        this.pending = false;
        this.active = true;
        this.text = '';
        this.itemId = null;
        this.discard = false;
        this.audioMs = 0;
        this.toolCalls = [];
        this.holding = this.holdNext;
        this.holdNext = false;
        this.held = [];
        if (this.suppressNext) {
          this.suppressNext = false;
          this.cancel();
        }
        return;
      case 'response.output_item.added':
        if (this.active) this.watch(RESPONSE_STALL_MS);
        this.itemId = e.item?.id ?? null;
        return;
      case 'response.output_audio.delta': {
        if (typeof e.delta !== 'string') return;
        if (this.active) this.watch(RESPONSE_STALL_MS);
        const pcm = fromBase64(e.delta);
        this.audioMs += (pcm.length / SAMPLE_RATE) * 1000;
        if (this.discard || this.call.phase === 'wrapping') return;
        if (this.holding) this.held.push([this.itemKey(), pcm16ToFloat(pcm)]);
        else this.call.player.enqueue(this.bot.id, this.itemKey(), pcm16ToFloat(pcm));
        return;
      }
      case 'response.output_audio_transcript.delta':
        if (typeof e.delta !== 'string') return;
        if (this.active) this.watch(RESPONSE_STALL_MS);
        this.text += e.delta;
        if (this.holding && hasRealWords(this.text, this.call.roster())) this.release();
        return;
      case 'response.output_audio_transcript.done':
        if (typeof e.transcript !== 'string') return;
        this.text = e.transcript;
        if (this.holding && hasRealWords(this.text, this.call.roster())) this.release();
        return;
      case 'response.function_call_arguments.done':
        if (this.active) this.watch(RESPONSE_STALL_MS);
        if (typeof e.call_id === 'string' && typeof e.name === 'string') {
          this.toolCalls.push({ callId: e.call_id, name: e.name, args: typeof e.arguments === 'string' ? e.arguments : '{}' });
        }
        return;
      case 'response.done': {
        this.clearWatch();
        const heard = !this.discard;
        this.active = false;
        this.discard = false;
        const status = heard ? (e.response?.status ?? 'completed') : 'cancelled';
        const calls = this.toolCalls.splice(0);
        const ran = heard && status === 'completed';
        const names = this.call.roster();
        let text = heard ? cleanTranscript(this.text) : '';
        const filler = text !== '' && isFiller(text, names);
        if (this.holding) {
          // Nothing real was said while its voice was held: play it now, or drop a spoken "pass" unheard.
          if (ran && text && !filler) this.release();
          this.holding = false;
          this.held = [];
        }
        if (filler) {
          // A spoken "Pass." or "Silence." is a pass. It is never passed on, or the other bots start saying it too.
          if (ran) {
            this.turn ??= { kind: 'pass' };
            this.call.event('tool', `${this.bot.name} passed (it said "${text}" out loud; not passed on)`);
          }
          text = '';
        }
        let followUp = false;
        const remote = [];
        for (const c of calls) {
          if (ran && this.isHarnessTool(c.name)) {
            remote.push(c);
            continue;
          }
          let output = 'Not done: this reply was cut off before anyone heard it.';
          if (ran) {
            const r = this.call.onToolCall(this, c);
            output = r.output;
            // 'if-quiet': a bot that only wrote something and said nothing gets to speak, so the talk goes on.
            followUp ||= r.followUp === true || (r.followUp === 'if-quiet' && !text);
          }
          this.sendToolOutput(c.callId, output);
        }
        if (remote.length) {
          void this.runRemote(remote, text, followUp);
          return;
        }
        this.call.onBotDone(this, text, status, followUp);
        this.flushQueued();
        return;
      }
      case 'input_audio_buffer.speech_started':
        return this.call.onSpeechStart(this);
      case 'conversation.item.input_audio_transcription.completed':
        return this.call.onTranscript(this, typeof e.transcript === 'string' ? e.transcript : '');
      case 'error': {
        const message = typeof e.error?.message === 'string' && e.error.message ? e.error.message : 'unknown error';
        // Before the session is set up, an error means our setup was refused (the session keeps its old one).
        // Try again without the parts most likely to be refused: search first, then the bot's own call tools.
        if (!this.ready && this.ws) {
          this.lastError = message;
          if (this.search) {
            this.search = false;
            this.ws.send(JSON.stringify(this.sessionUpdate()));
            this.call.event('error', `${this.bot.name}: web and X search were refused, joining without them`);
          } else if (this.harness && this.harnessTools.length) {
            this.harness = false;
            this.ws.send(JSON.stringify(this.sessionUpdate()));
            this.call.event('error', `${this.bot.name}: its Grok Bot tools were refused, joining without them`);
          } else {
            this.fail(new Error(`Voice setup was refused: ${message}`));
          }
          return;
        }
        // The reply we asked for was refused: don't wait for it.
        if (this.pending && e.error?.event_id === this.pendingEventId) {
          this.pending = false;
          this.clearWatch();
          this.lost(`could not start a reply (${message})`);
        }
        // Anything else (e.g. cancelling a reply that already ended) changes nothing.
        return;
      }
      default:
        return;
    }
  }

  onClose(ws) {
    if (ws !== this.ws || this.closed) return;
    const wasUp = this.ready && this.call.d.now() - this.readyAt >= MIN_UPTIME_FOR_RETRY_MS;
    const busy = this.stopEverything();
    if (!this.retried || wasUp) {
      this.retried = true;
      this.call.onDropped(this, busy);
    } else {
      this.fail(new Error('Connection lost.'), busy);
    }
  }

  /** Forgets every reply, held voice, tool wait and timer of this connection. Returns true if the bot was mid-turn. */
  stopEverything() {
    const busy = this.active || this.pending || this.toolsBusy;
    this.ready = false;
    this.active = false;
    this.pending = false;
    this.toolsBusy = false;
    this.holding = false;
    this.held = [];
    this.queued = null;
    this.sessionGen++;
    this.clearReplyTimer();
    this.clearWatch();
    this.clearConnectTimer();
    return busy;
  }

  fail(err, busy = false) {
    busy = this.stopEverything() || busy;
    this.status = 'error';
    this.error = err?.message || 'Could not connect.';
    const ws = this.ws;
    this.ws = null; // its close event is ours, not a drop
    ws?.close();
    this.call.onFailed(this, busy);
  }

  close() {
    this.closed = true;
    this.stopEverything();
    if (this.ws) this.ws.close();
  }

  sendToolOutput(callId, output) {
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output } });
  }

  /**
   * The reply used the bot's own Grok Bot tools: its words count now, but its turn waits until Grok Bot answers,
   * so the bot never speaks again before it has the result.
   */
  async runRemote(calls, text, followUp) {
    const gen = this.sessionGen;
    const callGen = this.call.gen;
    const theyJustTalked = this.call.lines.at(-1)?.who === USER;
    this.toolsBusy = true;
    const said = this.call.onBotSaid(this, text, 'completed');
    const line = { theyJustTalked, newsOwed: false, receiptOwed: false, alreadySpokeThisTurn: text !== '' };
    const results = await Promise.all(calls.map((c) => this.call.runHarnessTool(this, c, line)));
    if (gen !== this.sessionGen) return; // the connection dropped or closed meanwhile; that session is gone
    this.toolsBusy = false;
    calls.forEach((c, i) => {
      this.sendToolOutput(c.callId, results[i].output);
      followUp ||= results[i].followUp === true || (results[i].followUp === 'if-quiet' && !text);
    });
    // If the host cut in meanwhile, the call has moved on: only a reply the host asked for (queued) is given.
    if (said !== null && callGen === this.call.gen) {
      this.call.onTurnDone(this, said, followUp);
    } else {
      this.turn = null; // its turn decision belonged to the moment that has passed
      this.toolRounds = 0;
    }
    this.flushQueued();
  }
}

// ---------- the call ----------

/**
 * deps: {
 *   mintVoice(botId) -> Promise<{ clientSecret, url, instructions }>,
 *   openSocket(url, protocols, botId) -> WebSocket-like (botId: whose voice session it is),
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
    this.memory = null; // { summary, actionItems, notes } from the last call
    this.summary = '';
    this.actionItems = [];
    this.startedAt = 0;
    this.wrap = null; // while Leave waits for the summary: { replied(link), finish() }
    this.timeline = []; // { seq, at (ms into the call), kind, text }
    this.seq = 0;
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
    this.echoText = ''; // what the bots were saying when that speech started (for the echo check)
    this.cutBot = null; // the bot last cut off by speech that may turn out to be echo
    this.stuckTimer = null;
    this.focus = null; // the bot in a one-on-one with Shashank: only it talks
    this.focusClosing = false; // Shashank said he's done: suggestions follow the bot's last reply
    this.focusTimer = null;
    this.suggesting = null; // after a one-on-one: { from, queue, current } asking the others for a suggestion
    this.callId = ''; // identifies this call to Grok Bot when a bot uses its own tools
  }

  /**
   * `available`: all of Shashank's Grok Bots, so bots in the call can pull others in.
   * `memory`: { summary, actionItems, notes } saved from the last call, or null.
   */
  join(bots, available = bots, memory = null) {
    if (this.phase !== 'idle') throw new Error('already in a call');
    this.reset();
    this.phase = 'in-call';
    this.available = available;
    this.startedAt = this.d.now();
    this.callId = globalThis.crypto.randomUUID();
    if (memory) {
      this.memory = memory;
      this.notes = memory.notes.map((n) => ({ ...n }));
      this.tasks = memory.actionItems.map((text, i) => ({ id: i + 1, text, by: 'Last call', done: false, doneBy: null }));
    }
    for (const bot of bots) this.add(bot);
  }

  /**
   * Ending the call: one bot saves a summary (or WRAP_UP_MS passes), then resolves with the call's export data.
   * Bots stop taking turns and the mic is ignored meanwhile. Call leave() after.
   */
  wrapUp() {
    if (this.phase !== 'in-call') return Promise.resolve(null);
    this.phase = 'wrapping';
    this.interrupt();
    this.waitingForHost = true;
    const link = this.ear && this.readyLinks().includes(this.ear) ? this.ear : this.readyLinks()[0];
    if (!link || !this.lines.length) return Promise.resolve(this.exportData());
    return new Promise((resolve) => {
      const ask = () => link.respondWhenFree(wrapUpInstructions(this.lines, this.notes, this.tasks));
      let asked = 1;
      const finish = () => {
        this.d.clearTimer(timer);
        this.wrap = null;
        resolve(this.exportData());
      };
      const timer = this.d.setTimer(finish, WRAP_UP_MS);
      this.wrap = {
        finish,
        // It replied without saving a summary: ask once more, then end without one instead of waiting it out.
        replied: (replier) => {
          if (replier !== link) return;
          if (asked++ < WRAP_UP_ASKS) ask();
          else finish();
        },
      };
      ask();
    });
  }

  /** Everything the page saves and exports when the call ends. */
  exportData() {
    return {
      startedAt: this.startedAt,
      endedAt: this.d.now(),
      bots: this.roster(),
      lines: this.lines,
      summary: this.summary,
      notes: this.notes,
      tasks: this.tasks,
      direction: this.direction,
      notepadChanged: this.notepadVersion > 0,
      // With no new summary (none asked for, or no answer in time), the last call's summary is kept for next time.
      memory: { summary: this.summary || (this.memory?.summary ?? ''), actionItems: openItems(this.tasks, this.actionItems), notes: this.notes },
    };
  }

  leave() {
    if (this.phase === 'idle') return;
    this.stopNext();
    this.clearStuck();
    this.clearFocusIdle();
    this.wrap?.finish();
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
    if (this.focus === link) this.setFocus(null);
    this.rosterChanged();
    this.event('leave', `${link.bot.name} left the call`);
  }

  /**
   * Shashank typed a message to all bots. It counts as him speaking: whoever is talking is cut off,
   * every bot gets it, and the bot he names (or the listening bot) answers. Returns false if not sent.
   */
  sendText(text) {
    const said = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MESSAGE_MAX_CHARS);
    const ready = this.readyLinks();
    if (this.phase !== 'in-call' || !said || !ready.length) return false;
    this.interrupt();
    this.record(USER, said, null);
    if (isStopCommand(said, ready.map((l) => l.bot.name))) {
      this.stopAll(`You said "${said}": every bot is waiting for you`);
      return true;
    }
    this.hostSpoke(said);
    const target = this.hostTarget(said, ready.includes(this.ear) ? this.ear : ready[0]);
    this.setEar(target);
    target.respondWhenFree();
    return true;
  }

  /** The stop hotkey (or Shashank saying "stop"): every bot goes quiet now and waits for him. */
  stopAll(why = 'You stopped every bot') {
    if (this.phase !== 'in-call') return;
    this.interrupt();
    this.waitingForHost = true;
    this.passes = 0;
    this.cutBot = null;
    this.suggesting = null;
    this.clearFocusIdle();
    this.event('stop', why);
  }

  /** Adds an entry to the call timeline the page shows. */
  event(kind, text) {
    this.timeline.push({ seq: ++this.seq, at: Math.max(0, this.d.now() - this.startedAt), kind, text });
    if (this.timeline.length > TIMELINE_MAX) this.timeline.shift();
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
    if (!this.userSpeaking && this.d.now() - this.lastLoud >= GATE_HOLD_MS && this.player.remainingMs() > 0) {
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
      focus: this.focus?.bot.name ?? null,
      direction: this.direction,
      notes: this.notes,
      tasks: this.tasks,
      notepadVersion: this.notepadVersion,
      timeline: this.timeline,
      bots: this.order.map((id) => {
        const l = this.links.get(id);
        let status = l.status;
        if (l.ready) {
          if (speaking === id) status = 'speaking';
          else if (l.pending || l.toolsBusy || (l.active && !l.discard)) status = 'thinking';
          else if (this.ear === l) status = 'listening';
          else if (this.focus && this.focus !== l) status = 'quiet';
          else status = 'idle';
        }
        return { id, name: l.bot.name, color: l.bot.color, shape: l.bot.shape, status, error: l.error, search: l.search };
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
    this.event(who === USER ? 'host' : cut ? 'cut' : 'bot', `${tagOf(line)}: ${text}`);
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
    this.cutBot = null;
    for (const link of this.links.values()) {
      // Pass on only the part of a reply Shashank heard, now, so it comes before whatever he says next.
      if (link.active && !link.discard) {
        const heardMs = cut.get(link.itemKey())?.ms ?? this.player.heardMs(link.itemKey());
        this.onBotCut(link, heardPart(cleanTranscript(link.text), heardMs, link.audioMs));
        this.cutBot = link;
      }
      // Nothing asked for before the cut may start after it.
      link.clearReplyTimer();
      link.queued = null;
      link.cancel();
    }
  }

  onReady(link) {
    this.event('join', `${link.bot.name} ${link.joined ? 'reconnected' : 'joined'}`);
    link.joined = true;
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

  /** A bot's connection dropped: it reconnects; meanwhile the mic and its turn go to the others. */
  onDropped(link, busy = false) {
    this.event('error', `${link.bot.name} lost its connection: reconnecting`);
    if (this.ear === link && this.readyLinks().length) this.setEar(this.readyLinks()[0]);
    if (busy) this.moveOn(link);
    void link.connect(this.lines.length ? contextText(this.lines.slice(-CONTEXT_LINES)) : null);
  }

  onFailed(link, busy = false) {
    this.event('error', `${link.bot.name}: ${link.error}`);
    if (this.ear === link) this.setEar(this.readyLinks()[0] ?? null);
    if (this.focus === link) this.setFocus(null);
    if (busy) this.moveOn(link);
  }

  /** A bot's reply was lost (refused, never started, or stalled): the talk goes on without it. */
  onReplyLost(link, why) {
    this.event('error', `${link.bot.name} ${why}: moving on`);
    this.moveOn(link);
  }

  /** Hands on the turn of a bot that can't finish it, unless Shashank is talking or the call is ending. */
  moveOn(link) {
    if (this.phase === 'in-call' && !this.userSpeaking) this.afterTurn(link, '', { kind: 'resume' });
  }

  /** Runs one of a bot's own Grok Bot tools. Returns { output, followUp } like onToolCall. Never throws. */
  async runHarnessTool(link, { name, args }, line) {
    let input = null;
    try {
      input = JSON.parse(args);
    } catch {
      // bad arguments: sent as none, and Grok Bot says what is missing
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
    const job = name === 'send_task' ? normalize(String(input.request ?? '')) : '';
    if (job && link.tasksSent.has(job)) {
      return { output: 'Not sent again: that same job is already under way. Its result lands in your chat with the host.', followUp: 'if-quiet' };
    }
    if (name === 'send_task') this.event('task', `${link.bot.name} sent a job to its agent: "${cleanNote(input.request, 200)}"`);
    else if (name === 'search_conversations') this.event('tool', `${link.bot.name} searched its past chats for "${cleanNote(input.query, 100)}"`);
    else this.event('tool', `${link.bot.name} used ${name}`);
    try {
      const r = await this.d.callTool(link.bot.id, { callId: link.callId, name, input, line });
      if (r.kind === 'served') {
        if (job) link.tasksSent.add(job);
        // A job's receipt only needs words if the bot said none; a search result always needs telling.
        return { output: JSON.stringify(r.output ?? {}), followUp: name === 'send_task' ? 'if-quiet' : true };
      }
      const why = typeof r.output?.error === 'string' ? r.output.error : r.kind.replace('_', ' ');
      this.event('error', `${link.bot.name}: ${name} was refused (${why})`);
      return { output: `Not done: ${why}.`, followUp: 'if-quiet' };
    } catch (err) {
      const why = err?.message || 'no answer';
      this.event('error', `${link.bot.name}: ${name} failed (${why})`);
      return { output: `Not done: ${why}. Tell ${USER} in a few words that it did not go through.`, followUp: 'if-quiet' };
    }
  }

  onSpeechStart(link) {
    if (link !== this.ear || this.phase !== 'in-call') return;
    this.userSpeaking = true;
    this.echoRisk = this.player.remainingMs() > 0;
    // What could be coming back through the speakers: the last bot lines and any reply being spoken now.
    this.echoText = this.echoRisk
      ? [
          ...this.lines
            .filter((l) => l.who !== USER)
            .slice(-2)
            .map((l) => l.text),
          ...[...this.links.values()].filter((l) => l.active && !l.discard).map((l) => cleanTranscript(l.text)),
        ].join(' ')
      : '';
    this.armStuck();
    this.clearFocusIdle();
    this.interrupt();
    // The listening bot's server stops its own reply when Shashank talks, and its next
    // reply will be to him, so don't mark that one for cancelling.
    link.suppressNext = false;
  }

  onTranscript(link, text) {
    if (link !== this.ear || this.phase !== 'in-call') return;
    this.userSpeaking = false;
    this.clearStuck();
    // The echo check only runs if a bot's voice was playing when this speech started.
    const recent = this.echoRisk ? this.echoText : '';
    this.echoRisk = false;
    this.echoText = '';
    const names = this.readyLinks().map((l) => l.bot.name);
    const stop = isStopCommand(text, names);
    if (!stop && isNoiseOrEcho(text, recent)) {
      link.suppress();
      if (text.trim()) this.event('echo', `Ignored as speaker echo: "${text.trim()}"`);
      // Echo cut a bot off by mistake: let the talk go on from where it stopped.
      const cut = this.cutBot;
      this.cutBot = null;
      if (cut && this.links.get(cut.bot.id) === cut) this.afterTurn(cut, '', { kind: 'resume' });
      return;
    }
    this.record(USER, text.trim(), link);
    if (stop) {
      link.suppress();
      this.stopAll(`You said "${text.trim()}": every bot is waiting for you`);
      return;
    }
    this.hostSpoke(text.trim());
    const target = this.hostTarget(text.trim(), link);
    if (target === link && !link.toolsBusy) {
      link.expectReply();
    } else {
      // Another bot answers, or this one answers once its tool is done: its own automatic reply never plays.
      link.suppress();
      target.respondWhenFree();
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
    this.event('stuck', 'Your mic went quiet with no words heard: stopped waiting for you');
    this.ear?.clearInput();
    this.ear?.expectReply();
  }

  /** A reply Shashank cut off: the others get only the part he heard. */
  onBotCut(link, part) {
    if (part) this.record(link.bot.name, part, link, true);
  }

  /** Shashank said something: bots may take turns again, and a correction is pinned for every bot. */
  hostSpoke(text) {
    this.waitingForHost = false;
    this.passes = 0;
    this.cutBot = null;
    this.suggesting = null;
    this.clearFocusIdle();
    if (!isDirection(text)) return;
    this.direction = [...this.direction, text].slice(-DIRECTION_MAX);
    this.event('direction', `Direction pinned: "${text}"`);
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
        this.event('tool', `${link.bot.name} passed`);
        return { output: 'You passed this turn.', followUp: false };
      case HAND_TO_TOOL.name: {
        if (this.focus === link) {
          return { output: `${USER} is talking with you one-on-one, so the other bots stay quiet until it is over. Keep talking with ${USER}.`, followUp: false };
        }
        const others = this.readyLinks().filter((l) => l !== link);
        const wanted = String(a.name ?? '');
        const id = matchBot(wanted, others.map((l) => l.bot));
        if (!id) {
          const list = others.map((l) => l.bot.name).join(', ') || 'nobody';
          return { output: `No bot called "${wanted}" can take the turn. Bots in the call: ${list}. The turn goes on as usual.`, followUp: false };
        }
        link.turn = { kind: 'hand', target: id };
        this.event('tool', `${link.bot.name} handed the turn to ${this.links.get(id).bot.name}`);
        return { output: `${this.links.get(id).bot.name} speaks next.`, followUp: false };
      }
      case WAIT_FOR_HOST_TOOL.name:
        link.turn = { kind: 'wait' };
        this.event('tool', `${link.bot.name} asked the bots to wait for you`);
        return { output: `The bots now wait for ${USER} to speak.`, followUp: false };
      case LEAVE_CALL_TOOL.name:
        link.turn = { kind: 'leave' };
        this.event('tool', `${link.bot.name} is leaving the call`);
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
      case SAVE_SUMMARY_TOOL.name: {
        this.summary = cleanNote(a.summary, SUMMARY_MAX_CHARS);
        const items = Array.isArray(a.action_items) ? a.action_items : [];
        this.actionItems = items.map((x) => cleanNote(x)).filter(Boolean).slice(0, ACTION_ITEMS_MAX);
        this.event('tool', `${link.bot.name} saved the call summary`);
        this.wrap?.finish();
        return { output: 'Saved.', followUp: false };
      }
      case READ_NOTES_TOOL.name:
        this.event('tool', `${link.bot.name} read the notepad`);
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
    this.event('notepad', what);
    for (const link of this.links.values()) if (link !== from) link.say(`[Notepad]: ${what}`);
  }

  invite(link, wanted) {
    const id = matchBot(wanted, this.available);
    const list = this.invitable().map((b) => b.name).join(', ') || 'nobody';
    if (!id) return `There is no Grok Bot called "${wanted}". Bots you can invite: ${list}.`;
    const bot = this.available.find((b) => b.id === id);
    if (this.links.has(id)) return `${bot.name} is already in the call.`;
    this.invited.set(id, link.bot.name);
    this.event('tool', `${link.bot.name} pulled ${bot.name} into the call`);
    this.addBot(bot);
    return `${bot.name} is joining the call now. Tell everyone in one short line.`;
  }

  onBotDone(link, text, status, followUp = false) {
    // While the call ends, what a bot says is not part of the call.
    // A reply cut off by Leave itself is not an answer to the summary request.
    if (this.phase === 'wrapping') return void (status === 'completed' && this.wrap?.replied(link));
    const said = this.onBotSaid(link, text, status);
    if (said !== null) this.onTurnDone(link, said, followUp);
  }

  /** Passes on what a bot said. Returns the line ('' for none), or null if the reply doesn't count (cut off, or the bot left). */
  onBotSaid(link, text, status) {
    if (status !== 'completed' || !this.links.has(link.bot.id)) {
      link.turn = null;
      return null;
    }
    const said = text.trim();
    const earlier = this.lines
      .filter((l) => l.who !== USER && !l.cut)
      .slice(-REPEAT_LOOKBACK)
      .map((l) => l.text);
    link.repeated = said !== '' && isRepeat(said, earlier);
    if (said) {
      this.record(link.bot.name, said, link);
      // Keep Shashank's mic on the same bot while he is (maybe) mid-sentence,
      // or his words get split between two bots.
      // In a one-on-one the mic stays with that bot, whoever else says something.
      if (!this.userSpeaking && this.d.now() - this.lastLoud >= USER_ACTIVE_MS && (!this.focus || this.focus === link)) this.setEar(link);
    }
    return said;
  }

  /** A bot's reply (and any tool it used) is over: decide who speaks next. */
  onTurnDone(link, said, followUp) {
    if (!this.links.has(link.bot.id) || this.phase !== 'in-call') {
      link.turn = null;
      return;
    }
    // After a tool like invite_bot the bot speaks again to say how it went; its turn decision waits until then.
    // A bot that keeps using tools gets a few rounds, then its turn ends. Spoken rounds count too: a bot that
    // says a line and reads something every time would otherwise keep the turn, talking on its own forever.
    link.toolRounds = followUp ? link.toolRounds + 1 : 0;
    const ending = link.turn && link.turn.kind !== 'hand';
    // A repeated line gets no follow-up: the loop breaker below stops the round instead.
    if (followUp && !ending && !link.repeated && link.toolRounds <= MAX_TOOL_ROUNDS) {
      if (!this.userSpeaking && !this.waitingForHost && this.phase === 'in-call') link.respond();
      return;
    }
    link.toolRounds = 0;
    const turn = link.turn;
    link.turn = null;
    if (turn?.kind === 'leave') this.leaveSoon(link);
    if (link.repeated && !this.focus && !this.suggesting) {
      // Going in circles: stop here rather than hope a bot calls wait_for_host.
      this.waitingForHost = true;
      this.event('loop', `${link.bot.name} repeated what was already said: waiting for you`);
      return;
    }
    // A bot cut short of its tool rounds hands the turn on like any other.
    this.afterTurn(link, said, turn ?? (followUp ? { kind: 'resume' } : null));
  }

  /** A bot's turn is over: carry on the suggestion round, the one-on-one, or the group talk. */
  afterTurn(link, said, turn) {
    if (this.suggesting) return this.nextSuggestion(link, turn);
    if (this.focus) return this.focusTurnDone(link);
    this.nextTurn(link, said, turn);
  }

  /**
   * Who answers a host line, and what it does to the one-on-one: naming one bot starts (or moves) it, a line
   * with no name stays in it, "thanks"-style lines end it, and naming several bots or everyone ends it.
   */
  hostTarget(text, fallback) {
    const ready = this.readyLinks();
    if (this.focus && !ready.includes(this.focus)) this.setFocus(null);
    const named = namedBots(text, ready.map((l) => l.bot)).map((id) => this.links.get(id));
    const first = findAddressee(text, ready.map((l) => l.bot));
    if (this.focus && (!named.length || (named.length === 1 && named[0] === this.focus))) {
      if (isClosing(text, ready.map((l) => l.bot.name))) {
        this.focusClosing = true;
        this.event('focus', `You wrapped up with ${this.focus.bot.name}`);
        return this.focus;
      }
      if (!isGroupAddress(text)) {
        this.focusClosing = false;
        return this.focus;
      }
    }
    if (named.length === 1 && ready.length > 1 && !isGroupAddress(text)) {
      this.setFocus(named[0]);
      return named[0];
    }
    if (this.focus) this.setFocus(null);
    return first ? this.links.get(first) : fallback;
  }

  /** Starts, moves or ends (null) the one-on-one, and tells every bot. */
  setFocus(link) {
    const was = this.focus;
    this.focus = link;
    this.focusClosing = false;
    this.clearFocusIdle();
    if (link) this.event('focus', `One-on-one with ${link.bot.name}: the other bots stay quiet`);
    else this.event('focus', `One-on-one with ${was.bot.name} ended: talking with everyone again`);
    for (const l of this.links.values()) l.updateInstructions();
  }

  /** The one-on-one bot finished a reply: if Shashank wrapped up, the others get their say; else wait for him. */
  focusTurnDone(link) {
    if (link !== this.focus) return;
    if (this.focusClosing) return this.startSuggestions();
    this.armFocusIdle();
  }

  armFocusIdle() {
    this.clearFocusIdle();
    this.focusTimer = this.d.setTimer(() => {
      this.focusTimer = null;
      const f = this.focus;
      // Still mid-conversation: he is talking, or the bot is.
      if (this.userSpeaking || f.active || f.pending || this.d.now() - this.lastLoud < USER_ACTIVE_MS) return this.armFocusIdle();
      this.event('focus', `No reply for a while: the one-on-one with ${f.bot.name} is over`);
      this.startSuggestions();
    }, this.player.remainingMs() + FOCUS_IDLE_MS);
  }

  clearFocusIdle() {
    if (this.focusTimer !== null) this.d.clearTimer(this.focusTimer);
    this.focusTimer = null;
  }

  /** The one-on-one is over: each other bot, in turn, may add a suggestion or pass. */
  startSuggestions() {
    const from = this.focus;
    this.focus = null;
    this.focusClosing = false;
    this.clearFocusIdle();
    for (const l of this.links.values()) l.updateInstructions();
    this.suggesting = { from: from.bot.name, queue: this.readyLinks().filter((l) => l !== from), current: null };
    this.event('focus', `The others may now add a suggestion about your talk with ${from.bot.name}`);
    this.nextSuggestion(null, null);
  }

  /** `done` finished its turn in the suggestion round: ask the next bot, or end the round and wait for Shashank. */
  nextSuggestion(done, turn) {
    const round = this.suggesting;
    if (done !== round.current) return; // not the bot whose turn it is (e.g. a late reply)
    if (turn?.kind === 'wait') round.queue = [];
    const ready = this.readyLinks();
    round.queue = round.queue.filter((l) => ready.includes(l)); // skip bots that left or dropped meanwhile
    const next = round.queue.shift();
    if (!next) {
      this.suggesting = null;
      this.waitingForHost = true;
      this.event('focus', 'Suggestions done: waiting for you');
      return;
    }
    round.current = next;
    this.cueTurn(next, () => next.say(suggestionPrompt(round.from)));
  }

  /** Who speaks after `link`: the bot it handed to or named, or the next in order. Nobody if the call should wait. */
  nextTurn(link, said, turn) {
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
      this.event('tool', 'Every bot passed: waiting for you');
      return;
    }
    if (!others.length || this.userSpeaking || this.waitingForHost) return;
    const target = turn?.kind === 'hand' ? others.find((l) => l.bot.id === turn.target) : null;
    const named = findAddressee(said, others.map((l) => l.bot));
    const next = target ?? (named ? this.links.get(named) : this.after(link, others));
    this.cueTurn(next);
  }

  /** Asks `next` to speak shortly before the current voice ends, unless Shashank cuts in first. `prepare` runs just before. */
  cueTurn(next, prepare) {
    const gen = this.gen;
    this.stopNext();
    this.nextTimer = this.d.setTimer(
      () => {
        this.nextTimer = null;
        if (gen !== this.gen || this.userSpeaking || this.waitingForHost) return;
        // It dropped, failed or is leaving since it was picked: the turn goes past it.
        if (!next.ready || next.leaving) return this.afterTurn(next, '', { kind: 'resume' });
        // Skip a bot that is already about to speak (e.g. a newly invited bot saying hello).
        if (next.pending || next.active || next.toolsBusy) return;
        prepare?.();
        // A turn the call started may well be a pass: its voice is held until it says something real.
        next.holdNext = true;
        next.respond();
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
