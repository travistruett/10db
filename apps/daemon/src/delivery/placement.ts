import { WorkspaceMode, type TaskDto } from '@10db/contracts';

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
 * later task would build on work in a checkout it doesn't share. Returns the first such pair, or
 * none, for the start to refuse with a card naming both.
 */
export function crossPlacementDependency(
  tasks: readonly TaskDto[],
): { readonly task: TaskDto; readonly dep: TaskDto } | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const depId of task.dependsOn) {
      const dep = byId.get(depId);
      if (dep !== undefined && dep.workspaceMode !== task.workspaceMode) return { task, dep };
    }
  }
  return undefined;
}
