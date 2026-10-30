import {
  isTerminal,
  TaskStatus,
  WorkstreamState,
  type TaskDto,
  type WorkstreamDto,
} from '@10db/contracts';

/** What a started task's menu and drawer offer for Hold: the action, or why it is held back. */
export type HoldOption =
  { readonly kind: 'hold' } | { readonly kind: 'refused'; readonly reason: string };

/** A run set aside before it ran: it keeps its batch and worktree and takes no lane. */
export function isHeld(workstream: Pick<WorkstreamDto, 'state'> | undefined): boolean {
  return workstream?.state === WorkstreamState.Held;
}

/**
 * Whether a task can be held. Only a queued run that has not run can: once a lane, a session, a
 * retry or a recovery is behind it, the daemon refuses, and the menu says so (it mirrors
 * `holdTask`). Null when there is nothing to hold: no run, a finished or held one, a removed task.
 */
export function holdOption(
  task: Pick<TaskDto, 'title' | 'status'>,
  workstream: WorkstreamDto | undefined,
): HoldOption | null {
  if (!workstream || task.status !== TaskStatus.Open) return null;
  if (isTerminal(workstream.state) || isHeld(workstream)) return null;
  if (workstream.state !== WorkstreamState.Queued)
    return { kind: 'refused', reason: `${task.title} is running: cancel it in Factory first.` };
  if (workstream.sessionCount > 0 || workstream.attempt > 0 || workstream.recoveryAttempts > 0)
    return {
      kind: 'refused',
      reason: `${task.title} has already run: cancel it in Factory first.`,
    };
  return { kind: 'hold' };
}
