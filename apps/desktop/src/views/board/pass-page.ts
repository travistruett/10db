import type { BatchDto, TaskDto, WorkstreamDto } from '@10db/contracts';

/** A task's latest run and the batch it ships in, as the Board shows them. */
export interface BoardRun {
  readonly workstream: WorkstreamDto | undefined;
  readonly batch: BatchDto | undefined;
}

/**
 * A task's run as the Board shows it. A task taken out of a Workbench pass keeps its last run in the
 * pass's batch, which is no longer its: the Board shows it as a task with no run, so its card shares
 * no branch and its drawer offers nothing of the pass's.
 */
export function boardRun(
  task: Pick<TaskDto, 'passId'>,
  workstream: WorkstreamDto | undefined,
  batch: BatchDto | undefined,
): BoardRun {
  if (batch?.passId != null && batch.passId !== task.passId)
    return { workstream: undefined, batch: undefined };
  return { workstream, batch };
}
