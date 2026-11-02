import {
  ACTIVE_STATES,
  TaskStatus,
  WorkspaceMode,
  type TaskDto,
  type WorkstreamState,
} from '@10db/contracts';

/** What the builder reads for where a task runs. */
export function placementLabel(mode: WorkspaceMode): string {
  switch (mode) {
    case WorkspaceMode.Shared:
      return 'Your folder';
    case WorkspaceMode.Worktree:
      return 'Separate copy';
  }
}

/**
 * Whether the task's placement is still open: the task is open and its latest run is not active.
 * That is when Start could start it, except for the card's column, so a parked task keeps its
 * placement too. Past that the stored value says nothing true about where the task runs, so
 * neither the badge nor the control is shown.
 */
export function placementOpen(task: TaskDto, latest: WorkstreamState | undefined): boolean {
  return (
    task.status === TaskStatus.Open && (latest === undefined || !ACTIVE_STATES.includes(latest))
  );
}
