import { ConflictError, WorkspaceMode, type TaskDto } from '@10db/contracts';

/** Where a placement runs, in the words the desktop uses. */
export function placementWords(mode: WorkspaceMode): string {
  switch (mode) {
    case WorkspaceMode.Shared:
      return 'Your folder';
    case WorkspaceMode.Worktree:
      return 'a separate copy';
  }
}

/**
 * A dependency between two tasks of one start that run in different places can't be honoured: the
 * later task would build on work in a checkout it doesn't share. Refused in plain words, naming both
 * tasks and where each runs, before anything is written.
 */
export function refuseCrossPlacementDependency(tasks: readonly TaskDto[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const depId of task.dependsOn) {
      const dep = byId.get(depId);
      if (dep === undefined || dep.workspaceMode === task.workspaceMode) continue;
      throw new ConflictError(
        `${task.title} runs in ${placementWords(task.workspaceMode)} but needs ${dep.title}, which runs in ${placementWords(dep.workspaceMode)}. ` +
          'Tasks that depend on each other must run in the same place: change where one of them runs, then start them again',
      );
    }
  }
}
