import { TaskStatus, WorkstreamState, type TaskDto } from '@10db/contracts';

/** Only a started task still waiting for a lane can be put first; a parked task never takes one. */
export function canRunNext(
  task: Pick<TaskDto, 'status' | 'boardColumnId'>,
  state: WorkstreamState | undefined,
): boolean {
  return (
    task.status === TaskStatus.Open &&
    task.boardColumnId === null &&
    state === WorkstreamState.Queued
  );
}
