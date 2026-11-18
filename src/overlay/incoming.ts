// Calls that come to you: standing calls on a weekly schedule, callbacks a bot promised during a call, and a ring
// when a bot's background job finishes or waits for your approval after the call ended. This decides when something
// rings, holds rings during quiet hours, a call or do-not-disturb, and keeps what you missed. It never joins a call
// itself: the app answers, and the server joins.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clockMinutes, inWindow, nextWeekly, validZone, zonedTime, addDays, localParts } from './zoned.ts';

export const INCOMING_FILE = 'incoming.json';
export const RING_SOURCES = ['schedule', 'callback', 'job', 'approval'] as const;
export type RingSource = (typeof RING_SOURCES)[number];
export type RingState = 'ringing' | 'held' | 'snoozed' | 'answered' | 'declined' | 'missed';

export const SCHEDULES_MAX = 20;
export const BOTS_PER_CALL_MAX = 8;
export const TITLE_MAX = 80;
export const AGENDA_MAX = 1000;
export const REASON_MAX = 300;
/** Waiting callbacks one bot may have. */
export const CALLBACKS_PER_BOT = 5;
/** A callback can be at most this far away. */
export const CALLBACK_MAX_MS = 7 * 86_400_000;
/** A standing call whose time passed while the app was closed or the Mac slept still rings if it is this recent. */
export const LATE_GRACE_MS = 10 * 60_000;
/** A held ring older than this is missed instead of ringing. */
export const HELD_MAX_MS = 60 * 60_000;
export const MISSED_KEPT = 30;
/** After you decline a bot's job or approval ring, its next ones are only listed as missed for this long. */
export const DECLINE_COOLDOWN_MS = 30 * 60_000;
/** A clock that moved back more than this was wrong before, not just synced. */
export const CLOCK_FIX_MS = 86_400_000;
/** Longest wait between checks, so a sleeping Mac or a changed clock is noticed. */
export const CHECK_MS = 30_000;
export const RING_SECONDS = { min: 15, max: 120, default: 45 } as const;
export const SNOOZE_MINUTES = [5, 10, 15, 30, 60] as const;
/** Action ids remembered so a job never rings twice. */
const SEEN_MAX = 2000;

export class IncomingError extends Error {}

export interface Schedule {
  id: string;
  title: string;
  botIds: string[];
  agenda: string;
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  /** "HH:MM", 24-hour, in `timezone`. */
  time: string;
  timezone: string;
  enabled: boolean;
  createdAt: number;
}

export interface Callback {
  id: string;
  botId: string;
  botName: string;
  reason: string;
  /** When it rings, or null when it waits for jobs. */
  at: number | null;
  /** The jobs it waits for (action ids); it rings once every one has finished. */
  waitsFor: string[];
  createdAt: number;
}

export interface Ring {
  id: string;
  source: RingSource;
  title: string;
  reason: string;
  /** Who is in the call when you answer; the first one opens it. */
  botIds: string[];
  agenda: string;
  createdAt: number;
  state: RingState;
  /** When it stops ringing and becomes missed (while ringing). */
  until: number | null;
  /** Why it is held or missed, in words. */
  note: string;
  scheduleId: string | null;
  /** When a snoozed ring rings again (while snoozed). */
  at: number | null;
}

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
  timezone: string;
}

export interface IncomingSettings {
  /** Bots may promise to call you back. */
  botCallbacks: boolean;
  /** A bot calls when a job from an ended call finishes. */
  jobResults: boolean;
  /** A bot calls when its work waits for your approval after the call ended. */
  approvals: boolean;
  quietHours: QuietHours;
  /** No rings until then (ms), or null. Standing calls during it are missed; the rest wait until it ends. */
  doNotDisturbUntil: number | null;
  ringSeconds: number;
}

/** What the server tells the manager about a bot action (from the action record). */
export interface ActionView {
  id: string;
  botId: string;
  botName: string;
  callId: string;
  target: string;
  tool: string;
  status: string;
  summary: string | null;
  error: string | null;
  approvalSummary: string | null;
}

interface Saved {
  version: 1;
  schedules: Schedule[];
  callbacks: Callback[];
  settings: IncomingSettings;
  rings: Ring[];
  /** Up to when standing calls have been checked. */
  checkedAt: number;
  /** Per bot: no job or approval rings until then. */
  cooldowns: Record<string, number>;
}

export interface IncomingDeps {
  dir: string;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
  /** True while you are in a call: nothing rings then. */
  busy: () => boolean;
  /** The Mac's time zone (for new settings). */
  zone: () => string;
  /** Something changed that the app shows (a ring started or ended, a schedule changed). */
  changed: () => void;
}

const oneLine = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function defaultSettings(zone: string): IncomingSettings {
  return {
    botCallbacks: true,
    jobResults: true,
    approvals: true,
    quietHours: { enabled: true, start: '22:00', end: '08:00', timezone: validZone(zone) ? zone : 'UTC' },
    doNotDisturbUntil: null,
    ringSeconds: RING_SECONDS.default,
  };
}

/**
 * Checks a standing call from the app. `known` is every bot id on the account. `pausedNoBots` lets a paused call have
 * no bots (one whose bots all left the account, when it is read back from disk).
 */
export function parseSchedule(raw: unknown, known: ReadonlySet<string>, pausedNoBots = false): Omit<Schedule, 'id' | 'createdAt'> {
  if (!isRecord(raw)) throw new IncomingError('schedule must be an object');
  const title = oneLine(raw.title, TITLE_MAX + 1);
  if (!title) throw new IncomingError('title is required');
  if (title.length > TITLE_MAX) throw new IncomingError(`title is longer than ${TITLE_MAX} characters`);
  const noBotsOk = pausedNoBots && raw.enabled === false;
  if (!Array.isArray(raw.botIds) || (!raw.botIds.length && !noBotsOk) || !raw.botIds.every((b) => typeof b === 'string')) throw new IncomingError('botIds must be a list of bot ids');
  const botIds = [...new Set(raw.botIds as string[])];
  if (botIds.length > BOTS_PER_CALL_MAX) throw new IncomingError(`a standing call can have at most ${BOTS_PER_CALL_MAX} bots`);
  const unknown = botIds.filter((b) => !known.has(b));
  if (unknown.length) throw new IncomingError('Some of those bots are not on this account any more.');
  if (raw.agenda !== undefined && raw.agenda !== null && typeof raw.agenda !== 'string') throw new IncomingError('agenda must be text');
  const agenda = typeof raw.agenda === 'string' ? raw.agenda.trim() : '';
  if (agenda.length > AGENDA_MAX) throw new IncomingError(`agenda is longer than ${AGENDA_MAX} characters`);
  if (!Array.isArray(raw.days) || !raw.days.length || !raw.days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) {
    throw new IncomingError('days must be a list of weekdays, 0 (Sunday) to 6 (Saturday)');
  }
  if (clockMinutes(raw.time) === null) throw new IncomingError('time must be HH:MM, 24-hour');
  if (!validZone(raw.timezone)) throw new IncomingError('timezone must be a time zone name, such as Europe/London');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new IncomingError('enabled must be true or false');
  return {
    title,
    botIds,
    agenda,
    days: [...new Set(raw.days as number[])].sort(),
    time: raw.time as string,
    timezone: raw.timezone,
    enabled: raw.enabled !== false,
  };
}

/** Checks a settings change from the app; only the fields given change. */
export function parseSettings(raw: unknown, current: IncomingSettings, now: number): IncomingSettings {
  if (!isRecord(raw)) throw new IncomingError('settings must be an object');
  const out: IncomingSettings = { ...current, quietHours: { ...current.quietHours } };
  for (const k of ['botCallbacks', 'jobResults', 'approvals'] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'boolean') throw new IncomingError(`${k} must be true or false`);
    out[k] = raw[k];
  }
  if (raw.quietHours !== undefined) {
    const q = raw.quietHours;
    if (!isRecord(q)) throw new IncomingError('quietHours must be an object');
    if (q.enabled !== undefined) {
      if (typeof q.enabled !== 'boolean') throw new IncomingError('quietHours.enabled must be true or false');
      out.quietHours.enabled = q.enabled;
    }
    for (const k of ['start', 'end'] as const) {
      if (q[k] === undefined) continue;
      if (clockMinutes(q[k]) === null) throw new IncomingError(`quietHours.${k} must be HH:MM, 24-hour`);
      out.quietHours[k] = q[k] as string;
    }
    if (q.timezone !== undefined) {
      if (!validZone(q.timezone)) throw new IncomingError('quietHours.timezone must be a time zone name');
      out.quietHours.timezone = q.timezone;
    }
  }
  if (raw.doNotDisturbUntil !== undefined) {
    const d = raw.doNotDisturbUntil;
    if (d !== null && (!Number.isSafeInteger(d) || (d as number) <= now || (d as number) > now + CALLBACK_MAX_MS)) {
      throw new IncomingError('doNotDisturbUntil must be a time within the next 7 days, or null');
    }
    out.doNotDisturbUntil = d as number | null;
  }
  if (raw.ringSeconds !== undefined) {
    const r = raw.ringSeconds;
    if (!Number.isInteger(r) || (r as number) < RING_SECONDS.min || (r as number) > RING_SECONDS.max) {
      throw new IncomingError(`ringSeconds must be ${RING_SECONDS.min} to ${RING_SECONDS.max}`);
    }
    out.ringSeconds = r as number;
  }
  return out;
}

/** Reads the saved file; anything malformed is dropped piece by piece, never the whole file for one bad entry. */
export function parseSaved(raw: unknown, zone: string, now: number): Saved {
  const r = isRecord(raw) ? raw : {};
  // Field by field: one bad value falls back to its default and keeps the rest.
  let settings = defaultSettings(zone);
  const saved = isRecord(r.settings) ? r.settings : {};
  for (const [k, v] of Object.entries(saved)) {
    const fields = k === 'quietHours' && isRecord(v) ? Object.entries(v).map(([q, x]) => ({ quietHours: { [q]: x } })) : [{ [k]: v }];
    for (const f of fields) {
      try {
        settings = parseSettings(f, settings, now - 1);
      } catch {
        // this field keeps its default
      }
    }
  }
  // A do-not-disturb that ran out while the app was closed is over.
  if (settings.doNotDisturbUntil !== null && settings.doNotDisturbUntil <= now) settings.doNotDisturbUntil = null;
  const schedules: Schedule[] = [];
  for (const s of Array.isArray(r.schedules) ? r.schedules : []) {
    if (!isRecord(s) || typeof s.id !== 'string' || !Number.isSafeInteger(s.createdAt)) continue;
    try {
      const p = parseSchedule(s, new Set(Array.isArray(s.botIds) ? (s.botIds as string[]) : []), true);
      schedules.push({ ...p, id: s.id, createdAt: s.createdAt as number });
    } catch {
      // dropped
    }
  }
  const callbacks: Callback[] = [];
  for (const c of Array.isArray(r.callbacks) ? r.callbacks : []) {
    if (!isRecord(c) || typeof c.id !== 'string' || typeof c.botId !== 'string' || !Number.isSafeInteger(c.createdAt)) continue;
    const at = Number.isSafeInteger(c.at) ? (c.at as number) : null;
    const waitsFor = Array.isArray(c.waitsFor) ? c.waitsFor.filter((x): x is string => typeof x === 'string') : [];
    if (at === null && !waitsFor.length) continue;
    callbacks.push({ id: c.id, botId: c.botId, botName: oneLine(c.botName, 100) || 'A bot', reason: oneLine(c.reason, REASON_MAX), at, waitsFor, createdAt: c.createdAt as number });
  }
  const rings: Ring[] = [];
  for (const g of Array.isArray(r.rings) ? r.rings : []) {
    if (!isRecord(g) || typeof g.id !== 'string' || !RING_SOURCES.includes(g.source as RingSource) || !Number.isSafeInteger(g.createdAt)) continue;
    if (!Array.isArray(g.botIds) || !g.botIds.every((b) => typeof b === 'string')) continue;
    // A ring that was sounding or waiting when the app closed is missed now: nobody heard it. A snoozed one still rings.
    const snoozed = g.state === 'snoozed' && Number.isSafeInteger(g.at);
    const state: RingState = g.state === 'answered' || g.state === 'declined' || snoozed ? (g.state as RingState) : 'missed';
    rings.push({
      id: g.id,
      source: g.source as RingSource,
      title: oneLine(g.title, TITLE_MAX),
      reason: oneLine(g.reason, REASON_MAX * 4),
      botIds: g.botIds as string[],
      agenda: typeof g.agenda === 'string' ? g.agenda.slice(0, AGENDA_MAX) : '',
      createdAt: g.createdAt as number,
      state,
      until: null,
      note: state === g.state ? oneLine(g.note, 200) : 'Grok Call was closed while this rang.',
      scheduleId: typeof g.scheduleId === 'string' ? g.scheduleId : null,
      at: snoozed ? (g.at as number) : null,
    });
  }
  const cooldowns: Record<string, number> = {};
  if (isRecord(r.cooldowns)) for (const [k, v] of Object.entries(r.cooldowns)) if (Number.isSafeInteger(v) && (v as number) > now) cooldowns[k] = v as number;
  return {
    version: 1,
    schedules: schedules.slice(0, SCHEDULES_MAX),
    callbacks,
    settings,
    rings: rings.slice(-MISSED_KEPT),
    checkedAt: Number.isSafeInteger(r.checkedAt) && (r.checkedAt as number) <= now ? (r.checkedAt as number) : now,
    cooldowns,
  };
}

/** The next time a standing call rings after `after`, or null when it is off. */
export function nextRun(s: Schedule, after: number): number | null {
  if (!s.enabled) return null;
  return nextWeekly(after, s.days, clockMinutes(s.time)!, s.timezone);
}

/** When quiet hours that contain `now` end, or null when `now` is outside them. */
export function quietUntil(q: QuietHours, now: number): number | null {
  const start = clockMinutes(q.start)!;
  const end = clockMinutes(q.end)!;
  if (!q.enabled || !inWindow(now, start, end, q.timezone)) return null;
  // Inside the window, its end is later today or (past midnight) tomorrow.
  const today = localParts(now, q.timezone);
  const at = (days: number) => {
    const d = addDays(today.year, today.month, today.day, days);
    return zonedTime(d.year, d.month, d.day, Math.floor(end / 60), end % 60, q.timezone);
  };
  const t = at(0);
  return t > now ? t : at(1);
}

export class IncomingCalls {
  private d: IncomingDeps;
  private file: string;
  private s: Saved;
  private timer: unknown = null;
  private ringTimer: unknown = null;
  /** Last status seen for each action, so a change rings once. */
  private seen = new Map<string, string>();
  private stopped = false;

  constructor(d: IncomingDeps) {
    this.d = d;
    this.file = path.join(d.dir, INCOMING_FILE);
    let raw: unknown = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      raw = null; // none yet, or unreadable: start fresh (the next save replaces it)
    }
    this.s = parseSaved(raw, d.zone(), d.now());
  }

  // ----- what the app shows -----

  state() {
    const now = this.d.now();
    return {
      settings: this.s.settings,
      schedules: this.s.schedules.map((s) => ({ ...s, nextAt: nextRun(s, now) })),
      callbacks: this.s.callbacks,
      ringing: this.s.rings.find((r) => r.state === 'ringing') ?? null,
      held: this.s.rings.filter((r) => r.state === 'held'),
      snoozed: this.s.rings.filter((r) => r.state === 'snoozed'),
      missed: this.s.rings.filter((r) => r.state === 'missed').reverse(),
      quietUntil: quietUntil(this.s.settings.quietHours, now),
    };
  }

  get settings(): IncomingSettings {
    return this.s.settings;
  }

  ring(id: string): Ring | null {
    return this.s.rings.find((r) => r.id === id) ?? null;
  }

  // ----- lifecycle -----

  /** Starts checking: standing calls missed while the app was closed ring now if recent, or are listed as missed. */
  start() {
    this.stopped = false;
    this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) this.d.clearTimer(this.timer);
    if (this.ringTimer !== null) this.d.clearTimer(this.ringTimer);
    this.timer = null;
    this.ringTimer = null;
  }

  private save() {
    fs.mkdirSync(this.d.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.s), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private commit() {
    this.save();
    this.d.changed();
  }

  /** Checks what is due, rings it, and sets the next check. Safe to call any time. */
  tick() {
    if (this.stopped) return;
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
    const now = this.d.now();
    let dirty = false;
    // A clock moved back a little (a time sync): keep counting from the later time, so nothing rings twice. Moved back
    // more than a day, the old time was wrong: count from now, or standing calls would stay silent until then.
    if (this.s.checkedAt - now > CLOCK_FIX_MS) this.s.checkedAt = now;
    const from = this.s.checkedAt;
    for (const s of this.s.schedules) {
      const due = nextRun(s, from);
      if (due === null || due > now) continue;
      // Already ringing or waiting (Ring now just before its time): that ring is this one.
      if (this.s.rings.some((r) => r.scheduleId === s.id && (r.state === 'held' || r.state === 'ringing'))) continue;
      dirty = true;
      const ring = this.newRing('schedule', s.title, s.agenda ? `Standing call. Agenda: ${s.agenda}` : 'Standing call.', s.botIds, s.agenda, s.id);
      if (now - due > LATE_GRACE_MS) this.miss(ring, 'It was due while Grok Call was closed or the Mac was asleep.');
      else if (this.dndActive(now)) this.miss(ring, 'Do not disturb was on.');
      else this.offer(ring);
    }
    this.s.checkedAt = Math.max(this.s.checkedAt, now);
    // Snoozed rings ring again as the same call; one due long ago (the app was closed) is missed.
    for (const r of this.s.rings.filter((x) => x.state === 'snoozed' && x.at! <= now)) {
      dirty = true;
      const late = now - r.at! > HELD_MAX_MS;
      r.createdAt = r.at!;
      r.at = null;
      if (late) this.miss(r, 'It was due while Grok Call was closed or the Mac was asleep.');
      else this.offer(r);
    }
    for (const c of [...this.s.callbacks]) {
      if (c.at === null || c.at > now) continue;
      dirty = true;
      this.s.callbacks.splice(this.s.callbacks.indexOf(c), 1);
      const ring = this.newRing('callback', `${c.botName} is calling back`, c.reason, [c.botId], '', null);
      if (now - c.at > HELD_MAX_MS) this.miss(ring, 'It was due while Grok Call was closed or the Mac was asleep.');
      else this.offer(ring);
    }
    dirty = this.release(now) || dirty;
    // Saved only when something changed: a quiet check writes nothing (the last saved check time is early, which only
    // means a restart looks at a little more of the past, where nothing was due).
    if (dirty) this.commit();
    this.arm(now);
  }

  /** When something next needs a look: a standing call, a callback, held rings becoming free, or CHECK_MS. */
  private arm(now: number) {
    let next = now + CHECK_MS;
    for (const s of this.s.schedules) {
      const t = nextRun(s, now);
      if (t !== null) next = Math.min(next, t);
    }
    for (const c of this.s.callbacks) if (c.at !== null) next = Math.min(next, c.at);
    for (const r of this.s.rings) if (r.state === 'snoozed') next = Math.min(next, r.at!);
    // Held rings ring as soon as do-not-disturb or quiet hours end.
    if (this.s.rings.some((r) => r.state === 'held')) {
      for (const t of [this.s.settings.doNotDisturbUntil, quietUntil(this.s.settings.quietHours, now)]) if (t !== null && t > now) next = Math.min(next, t);
    }
    this.timer = this.d.setTimer(() => {
      this.timer = null;
      this.tick();
    }, Math.max(250, next - now));
  }

  private dndActive(now: number) {
    const u = this.s.settings.doNotDisturbUntil;
    return u !== null && u > now;
  }

  /** Why a ring can't sound right now, or null when it can. */
  private holdReason(ring: Ring, now: number): string | null {
    if (this.d.busy()) return 'You were in a call.';
    if (this.s.rings.some((r) => r.state === 'ringing' && r !== ring)) return 'Another call was ringing.';
    // Do not disturb holds everything, Ring now included (a standing call that comes due during it is missed in tick).
    if (this.dndActive(now)) return 'Do not disturb was on.';
    if (ring.source === 'schedule') return null; // a time you chose yourself rings through quiet hours
    if (quietUntil(this.s.settings.quietHours, now) !== null) return 'It was during your quiet hours.';
    return null;
  }

  private newRing(source: RingSource, title: string, reason: string, botIds: string[], agenda: string, scheduleId: string | null): Ring {
    const ring: Ring = {
      id: crypto.randomUUID(),
      source,
      title: oneLine(title, TITLE_MAX),
      reason: oneLine(reason, REASON_MAX * 4),
      botIds,
      agenda,
      createdAt: this.d.now(),
      state: 'held',
      until: null,
      note: '',
      scheduleId,
      at: null,
    };
    this.s.rings.push(ring);
    return ring;
  }

  /** Rings now if it can, else holds it. */
  private offer(ring: Ring) {
    const now = this.d.now();
    const why = this.holdReason(ring, now);
    if (why === null) this.sound(ring, now);
    else {
      ring.state = 'held';
      ring.note = why;
    }
  }

  private sound(ring: Ring, now: number) {
    ring.state = 'ringing';
    ring.note = '';
    ring.until = now + this.s.settings.ringSeconds * 1000;
    // Only one ring sounds at a time (holdReason), so no other ring timer is running; ending a ring clears its timer.
    this.ringTimer = this.d.setTimer(() => {
      this.ringTimer = null;
      this.miss(ring, 'Nobody answered.');
      this.release(this.d.now());
      this.commit();
    }, ring.until - now);
  }

  private miss(ring: Ring, note: string) {
    ring.state = 'missed';
    ring.until = null;
    ring.note = note;
    this.trim();
  }

  /** Keeps the newest MISSED_KEPT finished rings; held, snoozed and ringing ones always stay. */
  private trim() {
    const done = this.s.rings.filter((r) => r.state !== 'ringing' && r.state !== 'held' && r.state !== 'snoozed');
    const drop = new Set(done.slice(0, Math.max(0, done.length - MISSED_KEPT)));
    this.s.rings = this.s.rings.filter((r) => !drop.has(r));
  }

  /** Rings the oldest held ring that may sound now. Too-old held rings become missed. Returns true if anything changed. */
  private release(now: number): boolean {
    let changed = false;
    for (const r of this.s.rings.filter((x) => x.state === 'held')) {
      if (now - r.createdAt > HELD_MAX_MS) {
        this.miss(r, `${r.note} It waited too long to ring.`);
        changed = true;
      }
    }
    const next = this.s.rings.find((r) => r.state === 'held');
    if (next && this.holdReason(next, now) === null) {
      this.sound(next, now);
      changed = true;
    }
    return changed;
  }

  /** A call ended (or anything else that may free a held ring). */
  freed() {
    if (this.release(this.d.now())) this.commit();
  }

  // ----- answering -----

  private sounding(id: string): Ring {
    const r = this.ring(id);
    if (!r) throw new IncomingError('That call is no longer there.');
    if (r.state !== 'ringing' && r.state !== 'held' && r.state !== 'snoozed' && r.state !== 'missed') throw new IncomingError(`That call was already ${r.state}.`);
    return r;
  }

  private end(r: Ring, state: 'answered' | 'declined', note = '') {
    const wasRinging = r.state === 'ringing';
    r.state = state;
    r.until = null;
    r.at = null;
    r.note = note;
    if (wasRinging) {
      this.d.clearTimer(this.ringTimer);
      this.ringTimer = null;
    }
    this.trim();
  }

  /** You picked up (or called back a missed one). Returns the ring; the server joins its bots. */
  answer(id: string): Ring {
    const r = this.sounding(id);
    this.end(r, 'answered');
    this.commit();
    return r;
  }

  /** The join failed: the ring goes back to missed, so it can be called back. */
  answerFailed(id: string, why: string) {
    const r = this.ring(id);
    if (!r || r.state !== 'answered') return;
    r.state = 'missed';
    r.note = `Answering failed: ${oneLine(why, 150)}`;
    this.commit();
  }

  decline(id: string) {
    const r = this.sounding(id);
    this.end(r, 'declined');
    // A declined job or approval ring quiets that bot for a while; its work still shows in the app.
    if (r.source === 'job' || r.source === 'approval') for (const b of r.botIds) this.s.cooldowns[b] = this.d.now() + DECLINE_COOLDOWN_MS;
    this.release(this.d.now());
    this.commit();
  }

  /** The same call rings again in `minutes`: same bots, agenda, reason and standing call. */
  snooze(id: string, minutes: unknown) {
    if (!SNOOZE_MINUTES.includes(minutes as (typeof SNOOZE_MINUTES)[number])) throw new IncomingError(`minutes must be one of ${SNOOZE_MINUTES.join(', ')}`);
    const r = this.sounding(id);
    this.end(r, 'declined', `Snoozed for ${minutes} min.`);
    const again = this.newRing(r.source, r.title, r.reason, r.botIds, r.agenda, r.scheduleId);
    again.state = 'snoozed';
    again.at = this.d.now() + (minutes as number) * 60_000;
    again.note = `Snoozed for ${minutes} min.`;
    this.release(this.d.now());
    this.commit();
    this.tick();
  }

  clearMissed() {
    this.s.rings = this.s.rings.filter((r) => r.state === 'ringing' || r.state === 'held' || r.state === 'snoozed');
    this.commit();
  }

  // ----- standing calls and settings -----

  saveSchedule(raw: unknown, known: ReadonlySet<string>): Schedule {
    const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : null;
    const parsed = parseSchedule(raw, known);
    let s: Schedule;
    if (id) {
      const old = this.s.schedules.find((x) => x.id === id);
      if (!old) throw new IncomingError('That standing call is no longer there.');
      s = Object.assign(old, parsed);
    } else {
      if (this.s.schedules.length >= SCHEDULES_MAX) throw new IncomingError(`You can have at most ${SCHEDULES_MAX} standing calls.`);
      s = { ...parsed, id: crypto.randomUUID(), createdAt: this.d.now() };
      this.s.schedules.push(s);
    }
    // Editing a call never makes an earlier time ring now.
    this.s.checkedAt = Math.max(this.s.checkedAt, this.d.now());
    this.commit();
    this.tick();
    return s;
  }

  deleteSchedule(id: string) {
    const i = this.s.schedules.findIndex((x) => x.id === id);
    if (i < 0) throw new IncomingError('That standing call is no longer there.');
    this.s.schedules.splice(i, 1);
    this.commit();
    this.tick();
  }

  /** Rings a standing call now (to try it), whatever its schedule says. */
  ringNow(id: string) {
    const s = this.s.schedules.find((x) => x.id === id);
    if (!s) throw new IncomingError('That standing call is no longer there.');
    if (this.d.busy()) throw new IncomingError('Leave the current call first.');
    // Already waiting or ringing: pressing again must not queue another ring to decline. A snoozed one rings now.
    const pending = this.s.rings.find((r) => r.scheduleId === s.id && (r.state === 'held' || r.state === 'ringing' || r.state === 'snoozed'));
    if (pending?.state === 'snoozed') {
      pending.at = null;
      pending.createdAt = this.d.now();
      this.offer(pending);
      this.commit();
      this.tick();
    }
    if (pending) return pending;
    const ring = this.newRing('schedule', s.title, s.agenda ? `Standing call. Agenda: ${s.agenda}` : 'Standing call.', s.botIds, s.agenda, s.id);
    this.offer(ring);
    this.commit();
    return ring;
  }

  setSettings(raw: unknown) {
    this.s.settings = parseSettings(raw, this.s.settings, this.d.now());
    this.release(this.d.now());
    this.commit();
    this.tick();
    return this.s.settings;
  }

  /** Forgets every standing call, callback and ring of bots that are gone from the account. */
  forgetBots(known: ReadonlySet<string>) {
    let changed = false;
    for (const s of this.s.schedules) {
      const keep = s.botIds.filter((b) => known.has(b));
      if (keep.length !== s.botIds.length) {
        changed = true;
        s.botIds = keep;
        if (!keep.length) s.enabled = false;
      }
    }
    const before = this.s.callbacks.length;
    this.s.callbacks = this.s.callbacks.filter((c) => known.has(c.botId));
    if (changed || before !== this.s.callbacks.length) this.commit();
  }

  // ----- callbacks from bots -----

  /**
   * A bot promised to call back: at a time (`inMinutes` or `at`, ms), or once the jobs in `waitsFor` finish.
   * Returns what the bot is told. Throws IncomingError with the reason it can't.
   */
  addCallback(botId: string, botName: string, reason: string, when: { at: number | null; waitsFor: string[] }): Callback {
    if (!this.s.settings.botCallbacks) throw new IncomingError('The host turned off bot callbacks in Grok Call settings. Tell him you can\'t call back.');
    const r = oneLine(reason, REASON_MAX);
    if (!r) throw new IncomingError('Give reason: what you will call about.');
    const now = this.d.now();
    if (when.at !== null && (!Number.isFinite(when.at) || when.at <= now || when.at > now + CALLBACK_MAX_MS)) throw new IncomingError('A callback must be in the future and within 7 days.');
    if (when.at === null && !when.waitsFor.length) throw new IncomingError('You have no job under way to wait for. Give in_minutes or at instead.');
    if (this.s.callbacks.filter((c) => c.botId === botId).length >= CALLBACKS_PER_BOT) {
      throw new IncomingError(`You already have ${CALLBACKS_PER_BOT} callbacks waiting. One of them has to happen first.`);
    }
    const c: Callback = { id: crypto.randomUUID(), botId, botName: oneLine(botName, 100), reason: r, at: when.at, waitsFor: [...new Set(when.waitsFor)], createdAt: now };
    this.s.callbacks.push(c);
    this.commit();
    this.tick();
    return c;
  }

  cancelCallback(id: string) {
    const i = this.s.callbacks.findIndex((c) => c.id === id);
    if (i < 0) throw new IncomingError('That callback is no longer there.');
    this.s.callbacks.splice(i, 1);
    this.commit();
    this.tick();
  }

  // ----- bot work that finished after its call -----

  /**
   * Remembers what every action looks like now without ringing: what happened before the app started has already
   * been seen in the app's history.
   */
  seed(actions: ActionView[]) {
    for (const a of actions) this.seen.set(a.id, a.status);
    this.trimSeen();
  }

  private trimSeen() {
    while (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value!);
  }

  /**
   * Looks at a bot's actions after its agent sent something. A job from an ended call that finished, or work now
   * waiting for approval, may ring; callbacks waiting on jobs ring once all of theirs have finished.
   * `liveCall` is the current call's id (or null): its own news reaches the call, not a ring.
   */
  observe(actions: ActionView[], liveCall: string | null) {
    const now = this.d.now();
    const finished = (s: string) => s === 'completed' || s === 'failed' || s === 'unknown';
    let dirty = false;
    // Callbacks waiting on jobs.
    const status = new Map(actions.map((a) => [a.id, a]));
    const claimed = new Set<string>();
    for (const c of [...this.s.callbacks]) {
      if (c.at !== null) continue; // a timed callback (a job wait always has jobs: addCallback and parseSaved see to it)
      for (const id of c.waitsFor) claimed.add(id);
      const jobs = c.waitsFor.map((id) => status.get(id));
      if (jobs.some((j) => !j)) continue; // not this bot's update
      if (!jobs.every((j) => finished(j!.status))) continue;
      this.s.callbacks.splice(this.s.callbacks.indexOf(c), 1);
      dirty = true;
      // Finished while their call is still on: the bot tells the result there, so no call back is needed.
      if (liveCall !== null && jobs.every((j) => j!.callId === `${liveCall}-${j!.botId}`)) continue;
      const results = jobs.map((j) => (j!.status === 'completed' ? j!.summary ?? 'done' : `did not finish (${j!.error ?? j!.status})`)).join('; ');
      this.offer(this.newRing('callback', `${c.botName} is calling back`, `${c.reason} Result: ${results}`, [c.botId], '', null));
    }
    for (const a of actions) {
      const before = this.seen.get(a.id);
      this.seen.delete(a.id);
      this.seen.set(a.id, a.status);
      if (before === a.status || claimed.has(a.id)) continue;
      const live = liveCall !== null && a.callId === `${liveCall}-${a.botId}`;
      if (live || a.callId === 'workspace' || a.target !== 'agent') continue;
      const cooling = (this.s.cooldowns[a.botId] ?? 0) > now;
      if (a.status === 'waiting_approval' && this.s.settings.approvals) {
        dirty = true;
        this.botRing(a, 'approval', `${a.botName} needs your OK`, a.approvalSummary ?? 'Work is waiting for your approval.', cooling);
      } else if (before !== undefined && finished(a.status) && !finished(before) && this.s.settings.jobResults) {
        dirty = true;
        const result = a.status === 'completed' ? (a.summary ?? 'The job finished.') : `The job did not finish: ${a.error ?? a.status}.`;
        this.botRing(a, 'job', `${a.botName} has results`, result, cooling);
      }
    }
    this.trimSeen();
    if (dirty) this.commit();
  }

  /** One ring per bot at a time: news for a bot that is already ringing or waiting to is added to that ring. */
  private botRing(a: ActionView, source: 'job' | 'approval', title: string, reason: string, cooling: boolean) {
    const open = this.s.rings.find((r) => (r.state === 'ringing' || r.state === 'held') && (r.source === 'job' || r.source === 'approval') && r.botIds[0] === a.botId);
    if (open) {
      open.reason = oneLine(`${open.reason} Also: ${reason}`, REASON_MAX * 4);
      if (source === 'approval') {
        open.source = 'approval';
        open.title = oneLine(title, TITLE_MAX);
      }
      return;
    }
    const ring = this.newRing(source, title, reason, [a.botId], '', null);
    if (cooling) this.miss(ring, 'You declined this bot\'s last call, so it did not ring.');
    else this.offer(ring);
  }
}

const WHEN_KEYS = ['in_minutes', 'at', 'when_job_done'] as const;

/**
 * When a bot's call back should ring, from its call_back_later arguments: in some minutes, at a clock time (the next
 * time it comes round in `zone`, 24-hour or with am/pm), at an ISO date-time (local to `zone` unless it has an offset),
 * or once its jobs finish (`jobs`). Throws IncomingError with what to fix.
 */
export function callbackWhen(args: Record<string, unknown>, now: number, zone: string): { at: number | null; jobs: boolean } {
  const given = WHEN_KEYS.filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== false && args[k] !== '');
  if (given.length !== 1) throw new IncomingError('Give exactly one of in_minutes, at or when_job_done.');
  const key = given[0];
  if (key === 'when_job_done') {
    if (args.when_job_done !== true) throw new IncomingError('when_job_done must be true.');
    return { at: null, jobs: true };
  }
  if (key === 'in_minutes') {
    const m = args.in_minutes;
    if (!Number.isInteger(m) || (m as number) < 1 || (m as number) > CALLBACK_MAX_MS / 60_000) throw new IncomingError('in_minutes must be a whole number from 1 to 10080.');
    return { at: now + (m as number) * 60_000, jobs: false };
  }
  const text = typeof args.at === 'string' ? args.at.trim() : '';
  const clock = /^(\d{1,2}):(\d{2})\s*(?:([ap])\.?\s?m\.?)?$/i.exec(text);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2]);
    const half = clock[3]?.toLowerCase();
    if (half && (hour < 1 || hour > 12)) throw new IncomingError('at: with am or pm, the hour must be 1 to 12.');
    if (half === 'p' && hour !== 12) hour += 12;
    if (half === 'a' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) throw new IncomingError('at must be a real time, such as 15:30.');
    return { at: nextWeekly(now, [0, 1, 2, 3, 4, 5, 6], hour * 60 + minute, zone), jobs: false };
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (!iso) throw new IncomingError('at must be HH:MM or an ISO date-time such as 2026-11-20T15:30.');
  const [y, mo, d, h, mi] = iso.slice(1, 6).map(Number);
  const offset = iso[6];
  // A real calendar date (no 30 February) and a real time, before anything reads it.
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59) throw new IncomingError('at must be a real date and time.');
  const at = offset ? Date.parse(text.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : zonedTime(y, mo, d, h, mi, zone);
  // An offset that does not exist, such as +24:00, reads as no time at all.
  if (!Number.isFinite(at)) throw new IncomingError('at must be a real date and time.');
  return { at, jobs: false };
}
