import {
  BatchState,
  BoardStatus,
  TaskStatus,
  type BatchDto,
  type BatchId,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import { getBatch, getTask, latestDoneWorkstream, type DbReader } from '@10db/db';
import { PrState, type Gh, type GhCall } from '../github';

export interface BlockedTask {
  readonly task: TaskDto;
  readonly deps: readonly TaskDto[];
}

/**
 * Done, or still open though its failed run shipped anyway: the board puts the latter in Done
 * once its pull request has merged.
 */
function finished(task: TaskDto): boolean {
  return (
    task.status === TaskStatus.Done ||
    (task.status === TaskStatus.Open && task.boardStatus === BoardStatus.Done)
  );
}

/** Dependencies that are not done and not in the batch (batch delivery spec §5). */
export function unfinishedDependencies(
  db: DbReader,
  tasks: readonly TaskDto[],
  inBatch: ReadonlySet<TaskId>,
): BlockedTask[] {
  return tasks
    .map((task) => ({
      task,
      deps: task.dependsOn
        .filter((id) => !inBatch.has(id))
        .map((id) => getTask(db, id))
        .filter((dep) => !finished(dep)),
    }))
    .filter((b) => b.deps.length > 0);
}

export interface UnmergedDependency {
  readonly task: TaskDto;
  readonly dep: TaskDto;
  readonly reason: string;
}

/**
 * Done dependencies outside the batch whose code is not on origin/<base>: they finished in a batch
 * that was abandoned or whose pull request is not merged. A dependency done in a batch that closed
 * (no commits), or done in local delivery, counts as on the base.
 */
export async function unmergedDependencies(input: {
  readonly db: DbReader;
  readonly gh: Gh;
  readonly call: GhCall;
  readonly tasks: readonly TaskDto[];
  readonly inBatch: ReadonlySet<TaskId>;
  readonly batchId: BatchId;
}): Promise<UnmergedDependency[]> {
  const found: UnmergedDependency[] = [];
  for (const task of input.tasks) {
    for (const depId of task.dependsOn) {
      if (input.inBatch.has(depId)) continue;
      const done = latestDoneWorkstream(input.db, depId);
      if (!done?.batchId || done.batchId === input.batchId) continue;
      const reason = await notOnBase(getBatch(input.db, done.batchId), input.gh, input.call);
      if (reason !== null) found.push({ task, dep: getTask(input.db, depId), reason });
    }
  }
  return found;
}

async function notOnBase(batch: BatchDto, gh: Gh, call: GhCall): Promise<string | null> {
  switch (batch.state) {
    case BatchState.Closed:
      return null;
    case BatchState.Abandoned:
      return `its batch "${batch.title}" was abandoned, so its code is only on the local branch ${batch.branch ?? '(none)'}`;
    case BatchState.Shipped: {
      if (batch.prUrl === null || batch.repo === null)
        return `its batch "${batch.title}" has no pull request`;
      const pr = await gh.prView({ repo: batch.repo, ref: batch.prUrl }, call);
      if (pr === null) return `its pull request ${batch.prUrl} was not found`;
      return pr.state === PrState.Merged
        ? null
        : `its pull request ${pr.url} is ${pr.state.toLowerCase()}, not merged`;
    }
    case BatchState.Cutting:
    case BatchState.Open:
    case BatchState.Shipping:
    case BatchState.Failed:
      return `its batch "${batch.title}" has not shipped`;
  }
}
