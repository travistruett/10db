import { PassState, type PassDto, type PassId } from '@10db/contracts';
import {
  findOpenPass,
  getPass,
  getTaskKeptWork,
  lastTakeOut,
  listHolds,
  listPassTasks,
  listProjects,
  listUnfinishedAbandons,
  listUnfinishedTakeOuts,
  openHolds,
} from '@10db/db';
import { abandonPass } from './abandon';
import { passFolderOn } from './folder';
import { passBranch } from './kept-work';
import { putBackKeptWork } from './put-back';
import { keepHold } from './shared-chain';
import { holdRef } from './shared-hold';
import { takeOut, TakeOutWithin, type TakeOutDeps } from './take-out';

// Workbench spec §12: at start-up, after the runs' own recovery, each open pass goes on from its rows.

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Puts back the saved work of each task the pass holds that still records some, as when the daemon
 * stopped inside the put-back the pass's opening runs; a task being taken out of this pass is left to
 * its take-out.
 */
async function putBackAgain(deps: TakeOutDeps, passId: PassId, repo: string): Promise<void> {
  const db = deps.state.db;
  for (const task of listPassTasks(db, passId)) {
    if (getTaskKeptWork(db, task.id) === null || lastTakeOut(db, task.id)?.passId === passId)
      continue;
    try {
      await putBackKeptWork(deps, { repo, taskId: task.id });
    } catch (error) {
      deps.logger.warn(
        { passId, taskId: task.id, err: errorText(error) },
        'saved work not put back',
      );
    }
  }
}

/**
 * The pass's shared holds after a stop (spec §12): each hold's record is at its ref again, remade
 * from its row where the stop lost it, and, while the folder is on the pass's branch, each hold a
 * turn left open is kept on the chain and released, so no area is held with no turn running and the
 * resumed turn asks for it again.
 */
async function settleHolds(deps: TakeOutDeps, pass: PassDto, repo: string): Promise<void> {
  const prefix = `refs/10db/passes/${pass.id}/holds/`;
  const refs = new Set(await deps.git.keptRefs(repo, prefix));
  for (const hold of listHolds(deps.state.db, pass.id)) {
    const ref = holdRef(pass.id, hold.claimId);
    if (!refs.has(ref) && (await deps.git.hasCommit(repo, hold.recordSha)))
      await deps.git.keepRef(repo, ref, hold.recordSha);
  }
  // While the folder is off the pass's branch its files are not the hold's: the hold stays open,
  // and the next turn's end or start-up on the branch keeps it.
  if ((await deps.git.currentBranch(repo)) !== passBranch(deps.state.db, pass)) return;
  for (const hold of openHolds(deps.state.db, pass.id))
    await keepHold(deps, { claimId: hold.claimId });
}

/**
 * Start-up, after `recoverOnStartup`: each pass's shared holds are settled (`settleHolds`); each open
 * pass whose folder is off its branch gets its one card
 * (never a repoint), one on it puts back saved work a restart cut short, and each take-out the builder asked for that a stop cut short goes on as a job.
 * An Abandon that has not finished goes on as a job from its recorded step, its take-outs inside it;
 * a close's go on with it. Nothing here waits for those jobs.
 */
export async function resumePassWork(deps: TakeOutDeps): Promise<void> {
  const db = deps.state.db;
  for (const project of listProjects(db)) {
    const pass = findOpenPass(db, project.id);
    if (pass === undefined) continue;
    try {
      await settleHolds(deps, pass, project.repoPath);
    } catch (error) {
      deps.logger.warn(
        { projectId: project.id, passId: pass.id, err: errorText(error) },
        'shared holds not kept at start-up',
      );
    }
    if (pass.state !== PassState.Open) continue;
    try {
      if (await passFolderOn(deps, pass.id)) await putBackAgain(deps, pass.id, project.repoPath);
    } catch (error) {
      deps.logger.warn(
        { projectId: project.id, passId: pass.id, err: errorText(error) },
        'pass folder not read at start-up',
      );
    }
  }
  // An Abandon goes on from its own recorded step, its take-outs inside it.
  for (const pass of listUnfinishedAbandons(db))
    abandonPass(deps, pass.id).catch((error: unknown) => {
      deps.logger.warn(
        { passId: pass.id, err: errorText(error) },
        'abandon not finished at start-up',
      );
    });
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
