// Search over the host's saved calls (<dataDir>/calls/*.md), so a bot can answer "what did we decide about X?"
// from what earlier calls actually recorded. Both the browser version and the Mac app save calls in this format.

import fs from 'node:fs';
import path from 'node:path';
import { normalize, PAST_CALLS_TOOL_NAME, USER } from '../public/core.js';

export const CALL_FILE = /^call-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?\.md$/;
/** Newest saved calls searched. */
export const CALLS_SEARCHED = 200;
/** Most matching lines returned. */
export const MATCHES_MAX = 12;
/** Calls listed when there is no query. */
export const LATEST_LISTED = 5;
const SNIPPET_MAX = 300;

/** The tool each bot gets in its voice session. The backend runs it; no request leaves this machine. */
export const PAST_CALLS_TOOL = {
  type: 'function',
  name: PAST_CALLS_TOOL_NAME,
  description:
    `Search ${USER}'s saved earlier group calls (summaries, decisions, agenda outcomes, votes, action items and transcripts) ` +
    `for what was said or decided. Use it when ${USER} asks about an earlier call. With no query, it lists the latest calls.`,
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Words to look for: a topic, a name or a decision.' } },
    required: [],
  },
};

/** When a call was saved, from its file name (ms). */
export function callTime(file: string): number {
  return Date.parse(file.slice(5, 25).replace(/T(\d{2})-(\d{2})-(\d{2})Z/, 'T$1:$2:$3Z'));
}

/** call-…Z.md is 1, call-…Z-2.md is 2: later saves in the same second. */
const copyNumber = (file: string) => Number(/-(\d+)\.md$/.exec(file)?.[1] ?? 1);

/** Saved call files in `dir`, newest first; none if the folder is missing. */
export function callFiles(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => CALL_FILE.test(n));
  } catch {
    return [];
  }
  return names.sort((a, b) => callTime(b) - callTime(a) || copyNumber(b) - copyNumber(a));
}

/** "2026-11-10 14:05 UTC", from a call's file name. */
export function callLabel(file: string): string {
  return `${file.slice(5, 15)} ${file.slice(16, 18)}:${file.slice(19, 21)} UTC`;
}

export interface CallUnit {
  section: string;
  text: string;
}

/**
 * A saved call's searchable pieces: each paragraph, list item or transcript line, with the section it is in.
 * The title block, placeholders ("_Nothing was said._") and the Timeline (a copy of the rest) are left out.
 */
export function callUnits(markdown: string): CallUnit[] {
  const units: CallUnit[] = [];
  let section = '';
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      section = heading[1];
      continue;
    }
    if (!line || !section || section === 'Timeline' || /^_.*_$/.test(line)) continue;
    units.push({ section, text: line.replace(/^[-*]\s+(\[[ x]\]\s+)?/, '').replace(/\*\*/g, '').trim() });
  }
  return units;
}

// Words that say nothing about what to look for ("what did we decide on the launch last call").
const QUERY_FILLER = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'about', 'from', 'by',
  'we', 'i', 'you', 'us', 'our', 'my', 'me', 'it', 'is', 'was', 'were', 'be', 'did', 'do', 'does',
  'what', 'when', 'which', 'who', 'how', 'that', 'this', 'last', 'time', 'call', 'calls', 'earlier', 'before',
]);

/** The words of a query worth matching. */
export function queryWords(query: string): string[] {
  return [...new Set(normalize(query).split(' ').filter((w: string) => w.length >= 2 && !QUERY_FILLER.has(w)))];
}

/** True if `tokens` has `word`, or the same word in another form ("launch" and "launching"). */
function hasWord(tokens: string[], word: string): boolean {
  return tokens.some((t) => t === word || (word.length >= 4 && t.length >= 4 && (t.startsWith(word) || word.startsWith(t))));
}

// What a call settled outranks what was said along the way.
const SECTION_WEIGHT: Record<string, number> = { Decisions: 3, Summary: 2, Agenda: 2, Polls: 2, 'Action items': 1, Tasks: 1 };

const cut = (text: string) => (text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1)}…` : text);

/**
 * Searches the saved calls in `dir`. A line matches when it has at least one of the query's words; lines with more
 * of them come first, then decisions and summaries before talk, then newer calls. With no query, lists the latest.
 */
export function searchPastCalls(dir: string, query: unknown) {
  const files = callFiles(dir).slice(0, CALLS_SEARCHED);
  if (!files.length) return { found: 0, note: 'There are no saved calls yet.' };
  const units = new Map(files.map((f) => [f, callUnits(fs.readFileSync(path.join(dir, f), 'utf8'))]));
  const summary = (f: string) => cut(units.get(f)!.filter((u) => u.section === 'Summary').map((u) => u.text).join(' ')) || '(no summary was saved)';
  const words = queryWords(typeof query === 'string' ? query : '');
  if (!words.length) {
    return {
      saved: files.length,
      latest: files.slice(0, LATEST_LISTED).map((f) => ({
        call: callLabel(f),
        summary: summary(f),
        decisions: units.get(f)!.filter((u) => u.section === 'Decisions').map((u) => cut(u.text)),
      })),
    };
  }
  const hits: { file: string; age: number; weight: number; score: number; unit: CallUnit }[] = [];
  files.forEach((file, age) => {
    for (const unit of units.get(file)!) {
      const tokens = normalize(unit.text).split(' ');
      const score = words.filter((w) => hasWord(tokens, w)).length;
      if (score) hits.push({ file, age, weight: SECTION_WEIGHT[unit.section] ?? 0, score, unit });
    }
  });
  hits.sort((a, b) => b.score - a.score || b.weight - a.weight || a.age - b.age);
  const top = hits.slice(0, MATCHES_MAX);
  return {
    query: words.join(' '),
    searched: files.length,
    found: hits.length,
    matches: top.map((h) => ({ call: callLabel(h.file), section: h.unit.section, text: cut(h.unit.text) })),
    calls: [...new Set(top.map((h) => h.file))].map((f) => ({ call: callLabel(f), summary: summary(f) })),
    ...(top.length ? {} : { note: 'Nothing in the saved calls matches. Try other words, or no query to list the latest calls.' }),
  };
}
