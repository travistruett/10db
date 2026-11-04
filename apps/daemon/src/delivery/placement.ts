import { ConflictError, WorkspaceMode, type BatchDto, type TaskDto } from '@10db/contracts';
import { startCards, type Card } from './cards';

/** Where an unfinished batch works: a copy has a worktree path, the shared batch never does. */
export function batchPlacement(batch: BatchDto): WorkspaceMode {
  return batch.worktreePath !== null ? WorkspaceMode.Worktree : WorkspaceMode.Shared;
}

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
 * tasks and where each runs, before anything is written. `raise` puts the start-refused card naming
 * the two tasks in the inbox; the card's text is also the error's message.
 */
export function refuseCrossPlacementDependency(
  tasks: readonly TaskDto[],
  raise: (card: Card, taskIds: readonly [TaskDto['id'], TaskDto['id']]) => void,
): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const depId of task.dependsOn) {
      const dep = byId.get(depId);
      if (dep === undefined || dep.workspaceMode === task.workspaceMode) continue;
      const card = startCards.crossPlacementDependency(
        task,
        placementWords(task.workspaceMode),
        dep,
        placementWords(dep.workspaceMode),
      );
      raise(card, [task.id, dep.id]);
      throw new ConflictError(`${card.title}. ${card.body}`);
    }
  }
}
