// Wall-clock times in a named time zone (IANA, e.g. "America/New_York"), using only Intl: what a standing call at
// "09:30 on weekdays" means on a given day, across daylight-saving changes.

export interface LocalParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** True for a time zone this system knows (an IANA name, or UTC). */
export function validZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    format(tz);
    return true;
  } catch {
    return false;
  }
}

function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formats.set(tz, f);
  }
  return f;
}

/** The wall-clock date and time at `ms` in `tz`. */
export function localParts(ms: number, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const x of format(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), weekday: WEEKDAYS[p.weekday] };
}

/** How far `tz` is ahead of UTC at `ms`, in ms (whole seconds; zones with odd historic offsets keep them). */
export function zoneOffset(ms: number, tz: string): number {
  const p: Record<string, string> = {};
  for (const x of format(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in `tz`. A time that happens twice (clocks going back) is the first one; a
 * time that never happens (clocks going forward) moves forward by the gap, as calendars do (02:30 → 03:30).
 */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set([zoneOffset(guess - 86_400_000, tz), zoneOffset(guess, tz), zoneOffset(guess + 86_400_000, tz)]);
  const candidates = [...offsets].map((o) => guess - o);
  const valid = candidates.filter((t) => {
    const p = localParts(t, tz);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  });
  return valid.length ? Math.min(...valid) : Math.max(...candidates);
}

/** The calendar date `days` after the given one (any number of days, either way). */
export function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number; weekday: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

/** "HH:MM" (24-hour) as minutes after midnight, or null if it isn't one. */
export function clockMinutes(hhmm: unknown): number | null {
  const m = typeof hhmm === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The first time after `after` when the wall clock in `tz` reads `minutes` (after midnight) on one of `days`. */
export function nextWeekly(after: number, days: readonly number[], minutes: number, tz: string): number | null {
  const today = localParts(after, tz);
  // Today and the next seven days hold every weekday, including today's again when its time has passed.
  const later: number[] = [];
  for (let i = 0; i <= 7; i++) {
    const d = addDays(today.year, today.month, today.day, i);
    if (!days.includes(d.weekday)) continue;
    const t = zonedTime(d.year, d.month, d.day, Math.floor(minutes / 60), minutes % 60, tz);
    if (t > after) later.push(t);
  }
  return later.length ? Math.min(...later) : null;
}

/** True when the wall clock in `tz` at `ms` is inside [start, end) minutes; a window past midnight wraps (22:00-08:00). */
export function inWindow(ms: number, start: number, end: number, tz: string): boolean {
  if (start === end) return false;
  const p = localParts(ms, tz);
  const now = p.hour * 60 + p.minute;
  return start < end ? now >= start && now < end : now >= start || now < end;
}
