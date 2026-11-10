// Tasks for the overlay call: each task has an owner (a bot or the host), one optional parent
// (one level only), and cross-links ("waits on") to any other task. No cycles.

export type TaskStatus = 'open' | 'doing' | 'done';

export interface Task {
  id: number;
  title: string;
  /** A bot's name, the host's name, or null for nobody yet. */
  owner: string | null;
  /** Stored status. For a parent with parts, use TaskBoard.statusOf (it follows the parts). */
  status: TaskStatus;
  parent: number | null;
  /** Tasks that must be done before this one can start. */
  waitsOn: number[];
  by: string;
  doneBy: string | null;
}

export const TASK_LIMITS = { title: 300, max: 200, by: 100 };
export const STATUSES: readonly TaskStatus[] = ['open', 'doing', 'done'];

/** A task change that is refused; the message says why, in words a bot can act on. */
export class TaskError extends Error {}

export function cleanTitle(v: unknown): string {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TASK_LIMITS.title);
}

export interface NewTask {
  title: unknown;
  owner?: string | null;
  parent?: number | null;
  waitsOn?: number[];
  by: string;
}

export interface StatusChange {
  task: Task;
  /** Tasks that were waiting and can start now. */
  ready: Task[];
}

export class TaskBoard {
  tasks: Task[];
  /** Bumped on every change, so viewers redraw only then. */
  version = 0;

  constructor(tasks: Task[] = []) {
    this.tasks = tasks.map((t) => ({ ...t, waitsOn: [...t.waitsOn] }));
  }

  get(id: number): Task {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) throw new TaskError(`There is no task #${id}.`);
    return t;
  }

  children(id: number): Task[] {
    return this.tasks.filter((t) => t.parent === id);
  }

  /** A parent with parts is done when every part is done, doing once any part has started. */
  statusOf(task: Task): TaskStatus {
    const parts = this.children(task.id);
    if (!parts.length) return task.status;
    const s = parts.map((p) => p.status);
    if (s.every((x) => x === 'done')) return 'done';
    return s.some((x) => x !== 'open') ? 'doing' : 'open';
  }

  /** Tasks this one waits on that are not done yet. */
  blockers(task: Task): Task[] {
    return task.waitsOn.map((id) => this.get(id)).filter((t) => this.statusOf(t) !== 'done');
  }

  add(n: NewTask): Task {
    const title = cleanTitle(n.title);
    if (!title) throw new TaskError('The task needs a title.');
    if (this.tasks.length >= TASK_LIMITS.max) throw new TaskError(`The task list is full (${TASK_LIMITS.max} tasks).`);
    const parent = n.parent ?? null;
    if (parent !== null) {
      const p = this.get(parent);
      if (p.parent !== null) throw new TaskError(`Task #${parent} is already a part of #${p.parent}; parts can't have parts of their own.`);
    }
    const waitsOn = [...new Set(n.waitsOn ?? [])];
    for (const id of waitsOn) {
      this.get(id);
      if (id === parent) throw new TaskError(`A part can't wait on its own parent #${id}: the parent is only done when its parts are.`);
    }
    const id = this.tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    const task: Task = { id, title, owner: n.owner ?? null, status: 'open', parent, waitsOn, by: n.by, doneBy: null };
    this.tasks.push(task);
    this.version++;
    return task;
  }

  setStatus(id: number, status: TaskStatus, by: string): StatusChange {
    const task = this.get(id);
    if (!STATUSES.includes(status)) throw new TaskError(`Status must be one of ${STATUSES.join(', ')}.`);
    if (this.children(id).length) throw new TaskError(`Task #${id} has parts; it is done when all of its parts are done.`);
    if (status !== 'open') {
      const blocking = this.blockers(task);
      if (blocking.length) throw new TaskError(`Task #${id} waits on ${blocking.map((b) => `#${b.id}`).join(', ')}, which ${blocking.length > 1 ? 'are' : 'is'} not done yet.`);
    }
    const waitingBefore = new Set(this.waitingIds());
    task.status = status;
    task.doneBy = status === 'done' ? by : null;
    this.version++;
    const ready = this.tasks.filter((t) => waitingBefore.has(t.id) && this.statusOf(t) !== 'done' && !this.blockers(t).length);
    return { task, ready };
  }

  /** Makes `id` wait on `on`. Refuses links that would make a loop. */
  link(id: number, on: number): Task {
    const task = this.get(id);
    this.get(on);
    if (id === on) throw new TaskError("A task can't wait on itself.");
    if (task.parent === on) throw new TaskError(`A part can't wait on its own parent #${on}: the parent is only done when its parts are.`);
    if (task.waitsOn.includes(on)) return task;
    if (this.reaches(on, id)) throw new TaskError(`#${on} already waits on #${id} (directly or through other tasks), so this would make a loop.`);
    task.waitsOn.push(on);
    this.version++;
    return task;
  }

  unlink(id: number, on: number): Task {
    const task = this.get(id);
    task.waitsOn = task.waitsOn.filter((x) => x !== on);
    this.version++;
    return task;
  }

  /** Removes a task, its parts, and every link to them. */
  remove(id: number): Task[] {
    this.get(id);
    const gone = new Set([id, ...this.children(id).map((c) => c.id)]);
    const removed = this.tasks.filter((t) => gone.has(t.id));
    this.tasks = this.tasks.filter((t) => !gone.has(t.id));
    for (const t of this.tasks) t.waitsOn = t.waitsOn.filter((x) => !gone.has(x));
    this.version++;
    return removed;
  }

  /** Does `from` wait on `to`, directly or through a chain? */
  private reaches(from: number, to: number): boolean {
    const seen = new Set<number>();
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...this.get(cur).waitsOn);
    }
    return false;
  }

  private waitingIds(): number[] {
    return this.tasks.filter((t) => this.statusOf(t) !== 'done' && this.blockers(t).length).map((t) => t.id);
  }

  /** One line per task, the way a bot reads them. */
  line(t: Task): string {
    const status = this.statusOf(t);
    const blocking = status === 'done' ? [] : this.blockers(t);
    const bits = [`#${t.id} ${t.title}`, `owner: ${t.owner ?? 'nobody'}`, blocking.length ? `waiting on ${blocking.map((b) => `#${b.id}`).join(', ')}` : status];
    if (t.parent !== null) bits.push(`part of #${t.parent}`);
    if (status === 'done' && t.doneBy) bits.push(`done by ${t.doneBy}`);
    return `- ${bits.join(' · ')}`;
  }

  text(): string {
    if (!this.tasks.length) return 'There are no tasks yet.';
    return this.tasks.map((t) => this.line(t)).join('\n');
  }

  /** Open tasks a participant owns, for their instructions. Empty string when there are none. */
  ownText(owner: string): string {
    const mine = this.tasks.filter((t) => t.owner === owner && this.statusOf(t) !== 'done');
    return mine.length ? mine.map((t) => this.line(t)).join('\n') : '';
  }

  /**
   * What the next call starts with: tasks not done, plus the parents of those, with links to
   * tasks that are left behind (done) dropped.
   */
  carryOver(): Task[] {
    const keep = new Set(this.tasks.filter((t) => this.statusOf(t) !== 'done').map((t) => t.id));
    for (const t of this.tasks) if (keep.has(t.id) && t.parent !== null) keep.add(t.parent);
    return this.tasks
      .filter((t) => keep.has(t.id))
      .map((t) => ({ ...t, waitsOn: t.waitsOn.filter((x) => keep.has(x)) }));
  }
}

/** Checks saved tasks (from a file that may be hand-edited). Throws TaskError with the reason. */
export function parseTasks(raw: unknown): Task[] {
  if (!Array.isArray(raw)) throw new TaskError('tasks must be a list');
  if (raw.length > TASK_LIMITS.max) throw new TaskError(`more than ${TASK_LIMITS.max} tasks`);
  const ids = new Set<number>();
  const tasks = raw.map((r): Task => {
    const t = r as Record<string, unknown> | null;
    if (!t || typeof t !== 'object') throw new TaskError('each task must be an object');
    const id = t.id;
    if (!Number.isSafeInteger(id) || (id as number) < 1 || ids.has(id as number)) throw new TaskError('each task needs its own whole-number id');
    ids.add(id as number);
    const title = cleanTitle(t.title);
    if (!title) throw new TaskError(`task #${id} has no title`);
    const opt = (v: unknown, what: string) => {
      if (v === null || v === undefined) return null;
      if (typeof v !== 'string') throw new TaskError(`task #${id}: ${what} must be text`);
      return v.slice(0, TASK_LIMITS.by);
    };
    if (!STATUSES.includes(t.status as TaskStatus)) throw new TaskError(`task #${id}: unknown status`);
    const parent = t.parent ?? null;
    if (parent !== null && !Number.isSafeInteger(parent)) throw new TaskError(`task #${id}: parent must be a task id`);
    if (!Array.isArray(t.waitsOn) || !t.waitsOn.every((x) => Number.isSafeInteger(x))) throw new TaskError(`task #${id}: waitsOn must be task ids`);
    return {
      id: id as number,
      title,
      owner: opt(t.owner, 'owner'),
      status: t.status as TaskStatus,
      parent: parent as number | null,
      waitsOn: [...new Set(t.waitsOn as number[])],
      by: opt(t.by, 'by') ?? 'unknown',
      doneBy: opt(t.doneBy, 'doneBy'),
    };
  });
  // Rebuild through the board's own rules so broken parents and loops are caught.
  const board = new TaskBoard();
  for (const t of tasks) {
    if (t.parent !== null && (!ids.has(t.parent) || t.parent === t.id)) throw new TaskError(`task #${t.id}: parent #${t.parent} is not a task`);
    const p = tasks.find((x) => x.id === t.parent);
    if (p && p.parent !== null) throw new TaskError(`task #${t.id}: its parent #${p.id} is itself a part`);
    for (const w of t.waitsOn) if (!ids.has(w)) throw new TaskError(`task #${t.id}: waits on #${w}, which is not a task`);
  }
  board.tasks = tasks.map((t) => ({ ...t, waitsOn: [] }));
  for (const t of tasks) for (const w of t.waitsOn) board.link(t.id, w);
  return board.tasks;
}
