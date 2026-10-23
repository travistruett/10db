import { BoardStatus, TaskStatus, type TaskDto, type TaskId } from '@10db/contracts';

export type PickerTask = Pick<
  TaskDto,
  | 'id'
  | 'title'
  | 'areas'
  | 'dependsOn'
  | 'status'
  | 'boardStatus'
  | 'boardOrder'
  | 'workstreamId'
  | 'boardColumnId'
>;

export interface PickInput {
  readonly tasks: readonly PickerTask[];
  /** Claim names held by active work (queued included), each with the title of its task. */
  readonly held: ReadonlyMap<string, string>;
  /** The project's hazard names, so a conflict names a hazard as one. */
  readonly hazards: ReadonlySet<string>;
  /** Tasks whose plan can't start, with why. */
  readonly ruledOut: ReadonlyMap<TaskId, string>;
  readonly size: number;
}

export interface PickResult {
  readonly taskId: TaskId;
  readonly proposed: boolean;
  readonly resumed: boolean;
  readonly unblocks: number;
  readonly conflict: string | null;
}

/** For each task, the longest chain of open tasks that depend on it, directly or through others. */
function unblockChains(tasks: readonly PickerTask[]): Map<TaskId, number> {
  const dependents = new Map<TaskId, TaskId[]>();
  for (const task of tasks) {
    if (task.status !== TaskStatus.Open) continue;
    for (const dep of task.dependsOn)
      dependents.set(dep, [...(dependents.get(dep) ?? []), task.id]);
  }
  const memo = new Map<TaskId, number>();
  const visiting = new Set<TaskId>();
  const chain = (id: TaskId): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    // Dependencies must exist when a task is created, so no cycle can form; this only stops a loop.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const length = Math.max(0, ...(dependents.get(id) ?? []).map((d) => 1 + chain(d)));
    visiting.delete(id);
    memo.set(id, length);
    return length;
  };
  for (const task of tasks) chain(task.id);
  return memo;
}

interface Taken {
  readonly title: string;
  readonly picked: boolean;
}

function clash(
  task: PickerTask,
  taken: ReadonlyMap<string, Taken>,
  hazards: ReadonlySet<string>,
): string | null {
  for (const name of task.areas) {
    const holder = taken.get(name);
    if (!holder) continue;
    const what = `${hazards.has(name) ? 'Hazard' : 'Area'} ${name}`;
    return holder.picked
      ? `${what} is shared with ${holder.title}, picked before it`
      : `${what} is held by ${holder.title}, which is already running or queued`;
  }
  return null;
}

/**
 * Spec §5.2.1: Ready tasks, resumed work first, then the longest chain of work each unblocks, then the
 * builder's board order. A task whose claims collide with active work or an earlier pick, or whose
 * plan can't start, is left out with the reason; the first `size` of the rest are proposed.
 */
export function pickCandidates({ tasks, held, hazards, ruledOut, size }: PickInput): PickResult[] {
  const chains = unblockChains(tasks);
  const ready = tasks
    // A task parked in a human column is never picked.
    .filter((t) => t.boardStatus === BoardStatus.Ready && t.boardColumnId === null)
    .map((task) => ({
      task,
      resumed: task.workstreamId !== null,
      unblocks: chains.get(task.id) ?? 0,
    }))
    .sort(
      (a, b) =>
        Number(b.resumed) - Number(a.resumed) ||
        b.unblocks - a.unblocks ||
        a.task.boardOrder - b.task.boardOrder,
    );
  const taken = new Map<string, Taken>(
    [...held].map(([name, title]) => [name, { title, picked: false }]),
  );
  let proposedCount = 0;
  return ready.map(({ task, resumed, unblocks }) => {
    const conflict = ruledOut.get(task.id) ?? clash(task, taken, hazards);
    const proposed = conflict === null && proposedCount < size;
    if (proposed) {
      proposedCount += 1;
      for (const name of task.areas) taken.set(name, { title: task.title, picked: true });
    }
    return { taskId: task.id, proposed, resumed, unblocks, conflict };
  });
}
