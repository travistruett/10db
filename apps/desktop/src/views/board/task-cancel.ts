import { TaskStatus, WorkstreamState, type TaskDto, type WorkstreamDto } from '@10db/contracts';
import { canCancel } from '../factory/workstream-state';

/**
 * Whether the card menu and the drawer offer Cancel: an open task whose latest run can still stop.
 * A held run is left to Start and Remove, which say what becomes of its worktree.
 */
export function canCancelRun(
  task: Pick<TaskDto, 'status'>,
  workstream: Pick<WorkstreamDto, 'state'> | undefined,
): boolean {
  if (!workstream || task.status !== TaskStatus.Open) return false;
  return workstream.state !== WorkstreamState.Held && canCancel(workstream.state);
}
