import { TaskStatus, WorkstreamState, type TaskDto, type WorkstreamDto } from '@10db/contracts';

/**
 * A task with nothing left in it: open, in no pass, with no saved work, its run cancelled. The Board
 * offers Remove for it as for a held one; the daemon checks every run of it, not only the latest, and
 * says why when it refuses.
 */
export function isSpent(
  task: Pick<TaskDto, 'status' | 'passId' | 'keptWork'>,
  workstream: Pick<WorkstreamDto, 'state'> | undefined,
): boolean {
  return (
    task.status === TaskStatus.Open &&
    task.passId == null &&
    task.keptWork !== true &&
    workstream?.state === WorkstreamState.Cancelled
  );
}
