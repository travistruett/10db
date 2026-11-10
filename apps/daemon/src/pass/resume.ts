import { PassState } from '@10db/contracts';
import { findOpenPass, getPass, listProjects, listUnfinishedTakeOuts } from '@10db/db';
import { passFolderOn } from './folder';
import { takeOut, TakeOutWithin, type TakeOutDeps } from './take-out';

// Workbench spec §12: at start-up, after the runs' own recovery, each open pass goes on from its rows.

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Start-up, after `recoverOnStartup`: each open pass whose folder is off its branch gets its one card
 * (never a repoint), and each take-out the builder asked for that a stop cut short goes on as a job.
 * The take-outs of an Abandon or a close go on with it. Nothing here waits for those jobs.
 */
export async function resumePassWork(deps: TakeOutDeps): Promise<void> {
  const db = deps.state.db;
  for (const project of listProjects(db)) {
    const pass = findOpenPass(db, project.id);
    if (pass?.state !== PassState.Open) continue;
    try {
      await passFolderOn(deps, pass.id);
    } catch (error) {
      deps.logger.warn(
        { projectId: project.id, passId: pass.id, err: errorText(error) },
        'pass folder not read at start-up',
      );
    }
  }
  for (const row of listUnfinishedTakeOuts(db)) {
    if (getPass(db, row.passId).state !== PassState.Open) continue;
    takeOut(deps, { taskId: row.taskId, within: TakeOutWithin.Alone }).catch((error: unknown) => {
      deps.logger.warn(
        { passId: row.passId, taskId: row.taskId, err: errorText(error) },
        'take-out not finished at start-up',
      );
    });
  }
}
