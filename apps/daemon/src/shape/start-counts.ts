import type { ShapeStartCountsDto, WorkspaceMode } from '@10db/contracts';

// What Accept and Start does with the accepted tasks, as one rule. The confirm calls it with the
// draft's keys and the start with the made tasks' ids, so the confirm says what the start will do.

export interface StartCountTask {
  readonly key: string;
  readonly title: string;
  /** Where it will run, from its placement (or `proposePlacement` before Accept). */
  readonly place: WorkspaceMode;
  /** Keys of other tasks in this start it waits on. */
  readonly waitsOnStart: readonly string[];
  /** Titles of unfinished tasks outside this start it waits on. */
  readonly waitsOutside: readonly string[];
}

/** The most tasks one start takes (`BatchStartInput`'s cap). */
export const START_CAP = 50;

/** Orders tasks after the tasks they wait on, keeping the given order otherwise. */
function inDependencyOrder(tasks: readonly StartCountTask[]): StartCountTask[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const ordered: StartCountTask[] = [];
  const seen = new Set<string>();
  const visit = (task: StartCountTask): void => {
    if (seen.has(task.key)) return;
    seen.add(task.key);
    for (const key of task.waitsOnStart) {
      const dep = byKey.get(key);
      if (dep !== undefined) visit(dep);
    }
    ordered.push(task);
  };
  for (const task of tasks) visit(task);
  return ordered;
}

export function startCounts(input: {
  readonly tasks: readonly StartCountTask[];
  /** Draft keys the lane simulation starts at hour 0. */
  readonly startsAtOnce: ReadonlySet<string>;
  readonly local: boolean;
  readonly cap: number;
}): ShapeStartCountsDto & {
  readonly startKeys: readonly string[];
  readonly leftKeys: readonly { readonly key: string; readonly why: string }[];
} {
  const starting = new Map<string, StartCountTask>();
  const leftKeys: { key: string; why: string }[] = [];
  const stay: { title: string; why: string }[] = [];
  const leave = (task: StartCountTask, why: string): void => {
    leftKeys.push({ key: task.key, why });
    stay.push({ title: task.title, why });
  };
  const byKey = new Map(input.tasks.map((t) => [t.key, t]));
  for (const task of inDependencyOrder(input.tasks)) {
    if (task.waitsOutside.length > 0) {
      leave(task, `waits for ${task.waitsOutside.join(', ')}`);
      continue;
    }
    let why: string | null = null;
    for (const key of task.waitsOnStart) {
      const dep = byKey.get(key);
      if (dep === undefined) continue;
      if (!starting.has(key) || input.local) why = `waits for ${dep.title}`;
      else if (dep.place !== task.place)
        why = `waits for ${dep.title}, which runs in another place`;
      if (why !== null) break;
    }
    if (why === null && starting.size >= input.cap)
      why = `a start takes at most ${String(input.cap)}`;
    if (why === null) starting.set(task.key, task);
    else leave(task, why);
  }
  const started = [...starting.values()];
  const forOthers = started.filter((t) => t.waitsOnStart.length > 0).length;
  const now = started.filter(
    (t) => t.waitsOnStart.length === 0 && input.startsAtOnce.has(t.key),
  ).length;
  return {
    now,
    forLane: started.length - forOthers - now,
    forOthers,
    stay,
    startKeys: started.map((t) => t.key),
    leftKeys,
  };
}
