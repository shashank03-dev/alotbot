// The overlay's call: the web app's call engine (public/core.js, unchanged) with tasks in place of
// the shared notepad, plus what the overlay draws (who looks at whom, the live transcript).

import {
  BotLink,
  Call,
  CONTEXT_LINES,
  contextText,
  matchBot,
  tagOf,
  USER,
  ADD_TASK_TOOL,
  DONE_TASK_TOOL,
  READ_NOTES_TOOL,
  WRITE_NOTE_TOOL,
} from '../../public/core.js';
import type { Bot } from '../grokbot.ts';
import { STATUSES, type Task, TaskBoard, TaskError, type TaskStatus } from './tasks.ts';

// core.js is untyped JavaScript: its classes are typed loosely here, and this file's own code stays strict.
const LinkBase: new (call: any, bot: Bot) => any = BotLink;
const CallBase: new (deps: any) => any = Call;

const NOTEPAD_TOOLS = new Set<string>([WRITE_NOTE_TOOL.name, READ_NOTES_TOOL.name, ADD_TASK_TOOL.name, DONE_TASK_TOOL.name]);

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'function',
  name,
  description,
  parameters: { type: 'object', properties, required },
});

const ID = { type: 'integer', description: 'A task number, as list_tasks shows it (without the #).' };

export const TASK_TOOLS = [
  fn(
    'add_task',
    'Add a task. Give it an owner, put it under a bigger task as a part, or make it wait on other tasks.',
    {
      title: { type: 'string', description: 'The task, starting with a verb.' },
      owner: { type: 'string', description: `Who does it: a bot's exact name, your own name, or ${USER}. Leave out if nobody yet.` },
      parent: { ...ID, description: 'The bigger task this is a part of. Parts cannot have parts of their own.' },
      waits_on: { type: 'array', items: ID, description: 'Tasks that must be done before this one can start.' },
    },
    ['title'],
  ),
  fn(
    'update_task',
    'Mark a task doing or done (or open again). A task cannot start until every task it waits on is done.',
    { id: ID, status: { type: 'string', enum: [...STATUSES] } },
    ['id', 'status'],
  ),
  fn('link_tasks', 'Make one task wait on another, e.g. when it needs the other one\'s result.', { id: ID, waits_on: ID }, ['id', 'waits_on']),
  fn('list_tasks', 'See every task: owner, status, parts and what each waits on.'),
];

const NOTEPAD_SENTENCE = /There is a shared notepad[\s\S]*?someone changed it\. /;

export function tasksText(board: TaskBoard, me: string): string {
  const mine = board.ownText(me);
  return (
    `There is a task list that every bot and ${USER} can see. A task has an owner, can be a part of one bigger task, ` +
    `and can wait on other tasks, even ones other bots own. add_task adds one, update_task marks one doing or done, ` +
    `link_tasks makes one wait on another, and list_tasks shows them all. Mark your own tasks as you work on them. ` +
    `A "[Tasks]:" message tells you about a change that concerns you. ` +
    (mine ? `Your open tasks:\n${mine}\n` : 'You have no open tasks. ')
  );
}

export interface OverlayMemory {
  summary: string;
  tasks: Task[];
}

export interface LiveLine {
  seq: number;
  who: string;
  /** The bot's id, or null for the host. */
  botId: string | null;
  text: string;
  cut: boolean;
}

export type Gaze = 'host' | string | null;

export interface OverlayBotView {
  id: string;
  name: string;
  color: string | null;
  shape: string | null;
  status: string;
  error: string | null;
  search: boolean;
  /** 'host', another bot's id, or null (looking ahead). */
  looksAt: Gaze;
}

export interface OverlayView {
  phase: string;
  muted: boolean;
  userSpeaking: boolean;
  waitingForHost: boolean;
  /** The bot in a one-on-one with the host, or null. */
  focus: string | null;
  bots: OverlayBotView[];
  /** What the speaking bot has said so far in this reply. */
  live: { botId: string; text: string } | null;
  linesSeq: number;
  tasksVersion: number;
}

/**
 * Who looks at whom: when the host talks, every bot looks at the host, or only the one-on-one bot does;
 * when a bot talks, the others look at it and it looks at the host. Otherwise nobody looks anywhere.
 */
export function gaze(bots: { id: string; status: string }[], userSpeaking: boolean, focus: string | null): Map<string, Gaze> {
  const speaker = bots.find((b) => b.status === 'speaking')?.id ?? null;
  return new Map(
    bots.map((b): [string, Gaze] => {
      if (userSpeaking) return [b.id, !focus || focus === b.id ? 'host' : null];
      if (!speaker) return [b.id, null];
      if (b.id === speaker) return [b.id, 'host'];
      return [b.id, focus && focus !== speaker ? null : speaker];
    }),
  );
}

class OverlayLink extends LinkBase {
  sessionUpdate() {
    const u = super.sessionUpdate();
    u.session.tools = [...u.session.tools.filter((t: { name?: string }) => !NOTEPAD_TOOLS.has(t.name ?? '')), ...TASK_TOOLS];
    return u;
  }

  instructions() {
    const call = this.call as OverlayCall;
    const tasks = tasksText(call.board, this.bot.name);
    let text = super.instructions() as string;
    text = NOTEPAD_SENTENCE.test(text) ? text.replace(NOTEPAD_SENTENCE, tasks) : `${text}\n\n${tasks}`;
    return call.lastSummary ? `${text}\n\n# Your last call with ${USER}\nSummary: ${call.lastSummary}` : text;
  }
}

export class OverlayCall extends CallBase {
  board = new TaskBoard();
  lastSummary = '';

  /** `memory`: the last overlay call's summary and open tasks, or null. */
  joinWith(bots: Bot[], available: Bot[], memory: OverlayMemory | null) {
    this.board = new TaskBoard(memory?.tasks ?? []);
    this.lastSummary = memory?.summary ?? '';
    this.join(bots, available, null);
  }

  add(bot: Bot) {
    const link = new OverlayLink(this, bot);
    this.links.set(bot.id, link);
    this.order.push(bot.id);
    void link.connect(this.lines.length ? contextText(this.lines.slice(-CONTEXT_LINES)) : null);
  }

  /** Every bot this call knows by name: in the call, or on the account. */
  private knownBots(): Bot[] {
    const all = new Map<string, Bot>();
    for (const b of this.available as Bot[]) all.set(b.id, b);
    for (const l of this.links.values()) all.set(l.bot.id, l.bot);
    return [...all.values()];
  }

  /** A task owner from free text: a bot, the host, or "me" (the bot asking). */
  ownerOf(wanted: unknown, me: string | null): string | null {
    const w = String(wanted ?? '').trim();
    if (!w) return null;
    if (/^(me|myself|i)$/i.test(w) && me) return me;
    if (new RegExp(`^(${USER}|host|you|the host)$`, 'i').test(w)) return USER;
    const pool = this.knownBots();
    const id = matchBot(w, pool);
    if (!id) throw new TaskError(`No bot called "${w}". Owners can be: ${[USER, ...pool.map((b) => b.name)].join(', ')}.`);
    return pool.find((b) => b.id === id)!.name;
  }

  onToolCall(link: any, c: { name: string; args: string }) {
    if (NOTEPAD_TOOLS.has(c.name) && !TASK_TOOLS.some((t) => t.name === c.name)) {
      return { output: `"${c.name}" is not a tool in this call. Use add_task, update_task, link_tasks or list_tasks.`, followUp: false };
    }
    if (!TASK_TOOLS.some((t) => t.name === c.name)) return super.onToolCall(link, c);
    let a: Record<string, unknown> = {};
    try {
      a = JSON.parse(c.args) ?? {};
    } catch {
      // bad arguments: treated as none
    }
    const me: string = link.bot.name;
    try {
      switch (c.name) {
        case 'add_task': {
          const t = this.addTask({ title: a.title, owner: this.ownerOf(a.owner, me), parent: num(a.parent), waitsOn: nums(a.waits_on) }, me, link);
          return { output: `Task #${t.id} added${t.owner ? ` for ${t.owner === me ? 'you' : t.owner}` : ''}.`, followUp: 'if-quiet' };
        }
        case 'update_task': {
          const t = this.setTaskStatus(Number(a.id), String(a.status) as TaskStatus, me, link);
          return { output: `Task #${t.id} is ${t.status}.`, followUp: 'if-quiet' };
        }
        case 'link_tasks': {
          const t = this.linkTasks(Number(a.id), Number(a.waits_on), me, link);
          return { output: `Task #${t.id} now waits on #${Number(a.waits_on)}.`, followUp: 'if-quiet' };
        }
        default:
          this.event('tool', `${me} read the task list`);
          return { output: this.board.text(), followUp: true };
      }
    } catch (err) {
      if (err instanceof TaskError) return { output: `Not done: ${err.message}`, followUp: 'if-quiet' };
      throw err;
    }
  }

  // ----- task changes, from a bot (`from` is its link) or from the host (`from` is null) -----

  addTask(n: { title: unknown; owner: string | null; parent: number | null; waitsOn: number[] }, by: string, from: any = null): Task {
    const t = this.board.add({ ...n, by });
    this.event('task', `${by} added task #${t.id}: "${t.title}"${t.owner ? ` for ${t.owner}` : ''}`);
    if (t.owner && t.owner !== by) this.tell(t.owner, `${by} gave you task #${t.id}: ${t.title}`, from);
    this.refreshOwners([t.owner]);
    return t;
  }

  setTaskStatus(id: number, status: TaskStatus, by: string, from: any = null): Task {
    const { task, ready } = this.board.setStatus(id, status, by);
    this.event('task', `${by} marked task #${id} ${status}`);
    if (task.owner && task.owner !== by) this.tell(task.owner, `${by} marked your task #${id} ${status}`, from);
    for (const r of ready) if (r.owner) this.tell(r.owner, `#${id} is done, so your task #${r.id} (${r.title}) can start`, from);
    this.refreshOwners([task.owner, ...ready.map((r) => r.owner)]);
    return task;
  }

  linkTasks(id: number, on: number, by: string, from: any = null): Task {
    const t = this.board.link(id, on);
    this.event('task', `${by} made task #${id} wait on #${on}`);
    if (t.owner && t.owner !== by) this.tell(t.owner, `${by} made your task #${id} wait on #${on}`, from);
    this.refreshOwners([t.owner]);
    return t;
  }

  unlinkTasks(id: number, on: number, by: string): Task {
    const t = this.board.unlink(id, on);
    this.event('task', `${by} made task #${id} stop waiting on #${on}`);
    this.refreshOwners([t.owner]);
    return t;
  }

  removeTask(id: number, by: string): Task[] {
    const gone = this.board.remove(id);
    this.event('task', `${by} removed task #${id}`);
    for (const t of gone) if (t.owner && t.owner !== by) this.tell(t.owner, `${by} removed your task #${t.id} (${t.title})`, null);
    this.refreshOwners(gone.map((t) => t.owner));
    return gone;
  }

  /** Tells a bot in the call about a change; the bot that made the change already knows. */
  private tell(owner: string, text: string, from: any) {
    for (const l of this.links.values()) if (l.bot.name === owner && l !== from) l.say(`[Tasks]: ${text}`);
  }

  /** Owners' instructions list their open tasks, so refresh them after a change. */
  private refreshOwners(owners: (string | null)[]) {
    const names = new Set(owners.filter(Boolean));
    for (const l of this.links.values()) if (names.has(l.bot.name)) l.updateInstructions();
  }

  // ----- ending the call -----

  /** The summary bot sees the task list (in the old notepad format) with the transcript. */
  wrapUp() {
    this.notes = [];
    this.tasks = this.board.tasks.map((t) => ({ id: t.id, text: `${t.title}${t.owner ? ` (owner: ${t.owner})` : ''}`, by: t.by, done: this.board.statusOf(t) === 'done', doneBy: t.doneBy }));
    return super.wrapUp();
  }

  /** What the overlay saves: the export data plus tasks, and memory for the next call. */
  overlayExport() {
    const data = this.exportData();
    return {
      startedAt: data.startedAt as number,
      endedAt: data.endedAt as number,
      bots: data.bots as string[],
      lines: data.lines as { who: string; text: string; cut?: boolean }[],
      summary: data.summary as string,
      actionItems: this.actionItems as string[],
      tasks: this.board.tasks.map((t) => ({ ...t, status: this.board.statusOf(t) })),
      memory: { summary: (data.summary as string) || this.lastSummary, tasks: this.board.carryOver() } as OverlayMemory,
      saveWorthy: data.lines.length > 0 || this.board.version > 0,
    };
  }

  // ----- what the overlay draws -----

  /** Transcript lines after `seq` (1-based), with who said them. */
  linesSince(seq: number): LiveLine[] {
    const ids = new Map<string, string>();
    for (const b of this.knownBots()) ids.set(b.name, b.id);
    return (this.lines as { who: string; text: string; cut?: boolean }[]).slice(Math.max(0, seq)).map((l, i) => ({
      seq: seq + i + 1,
      who: l.who,
      botId: l.who === USER ? null : (ids.get(l.who) ?? null),
      text: l.text,
      cut: l.cut === true,
    }));
  }

  overlayView(): OverlayView {
    const v = this.view() as { phase: string; muted: boolean; userSpeaking: boolean; waitingForHost: boolean; bots: Omit<OverlayBotView, 'looksAt'>[] };
    const focusId = this.focus?.bot.id ?? null;
    const looks = gaze(v.bots, v.userSpeaking, focusId);
    const speaking = v.bots.find((b) => b.status === 'speaking');
    const live: string = speaking ? this.links.get(speaking.id).text : '';
    return {
      phase: v.phase,
      muted: v.muted,
      userSpeaking: v.userSpeaking,
      waitingForHost: v.waitingForHost,
      focus: focusId,
      bots: v.bots.map((b) => ({ ...b, looksAt: looks.get(b.id) ?? null })),
      live: speaking && live ? { botId: speaking.id, text: live } : null,
      linesSeq: this.lines.length,
      tasksVersion: this.board.version,
    };
  }
}

const num = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Number(String(v).replace(/^#/, '')));
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map((x) => Number(String(x).replace(/^#/, ''))) : []);

/** The call as Markdown: summary, tasks, action items and the transcript. */
export function overlayMarkdown(d: ReturnType<OverlayCall['overlayExport']>, formatTime = (ms: number) => new Date(ms).toISOString()): string {
  const mins = Math.max(0, Math.round((d.endedAt - d.startedAt) / 60000));
  const out = [`# Grok Call, ${formatTime(d.startedAt)}`, '', `Bots: ${d.bots.join(', ') || 'none'}  `, `Length: ${mins} min`, ''];
  out.push('## Summary', '', d.summary || '_No summary was saved._', '');
  if (d.actionItems.length) out.push('## Action items', '', ...d.actionItems.map((a) => `- ${a}`), '');
  if (d.tasks.length) {
    const line = (t: (typeof d.tasks)[number]) => {
      const bits = [t.owner ? `owner: ${t.owner}` : 'no owner'];
      if (t.waitsOn.length) bits.push(`waits on ${t.waitsOn.map((x) => `#${x}`).join(', ')}`);
      if (t.doneBy) bits.push(`done by ${t.doneBy}`);
      return `${t.parent === null ? '' : '  '}- [${t.status === 'done' ? 'x' : ' '}] #${t.id} ${t.title} (${bits.join('; ')})`;
    };
    const ordered = d.tasks.filter((t) => t.parent === null).flatMap((p) => [p, ...d.tasks.filter((t) => t.parent === p.id)]);
    out.push('## Tasks', '', ...ordered.map(line), '');
  }
  out.push('## Transcript', '', ...(d.lines.length ? d.lines.map((l) => `**${tagOf(l)}:** ${l.text}  `) : ['_Nothing was said._']), '');
  return out.join('\n');
}
