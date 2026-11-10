import { ConflictError, type TaskId } from '@10db/contracts';
import { getProject, getTask, passHoldingTask, setTaskKeptWork } from '@10db/db';
import { jobKey, JobQueue } from '../delivery';
import { keptRef, type PassWorkDeps } from './kept-work';

// Workbench spec §5.4: work a take-out saved stays with the task until a pass puts it back, it lands,
// or the builder discards it from the Board.

/**
 * Discards the task's saved Workbench work, in the project's delivery queue so no put-back reads it
 * meanwhile: the task forgets it first, then its kept ref is deleted, so a stop between the two leaves
 * only a ref nothing reads. Refused while a pass holds the task; a task with none is left as it is.
 */
export function discardKeptWork(deps: PassWorkDeps, taskId: TaskId): Promise<void> {
  const task = getTask(deps.state.db, taskId);
  const project = getProject(deps.state.db, task.projectId);
  return new Promise<void>((resolve, reject) => {
    deps.jobs.run(jobKey({ projectId: project.id, worktreePath: null }, JobQueue.Cut), async () => {
      try {
        deps.state.write((ctx) => {
          const now = getTask(ctx.tx, taskId);
          const pass = passHoldingTask(ctx.tx, now);
          if (pass)
            throw new ConflictError(
              `${now.title} is in pass "${pass.name}"; its work is the pass's until it is taken out`,
            );
          if (now.keptWork === true) setTaskKeptWork(ctx, taskId, null);
        });
        await deps.git.deleteKeptRef(project.repoPath, keptRef(taskId));
        deps.logger.info({ projectId: project.id, taskId }, 'saved work discarded');
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
