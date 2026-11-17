import { TaskStatus, WorkstreamState, type BatchDto, type TaskDto } from '@10db/contracts';

/**
 * Only a started task still waiting for a lane can be put first. A parked task never takes one, and a
 * pass's page runs when the builder writes to it in the UI Workbench.
 */
export function canRunNext(
  task: Pick<TaskDto, 'status' | 'boardColumnId'>,
  state: WorkstreamState | undefined,
  batch: Pick<BatchDto, 'passId'> | undefined,
): boolean {
  return (
    task.status === TaskStatus.Open &&
    task.boardColumnId === null &&
    state === WorkstreamState.Queued &&
    batch?.passId == null
  );
}
