import { BatchFailure, BatchState, CiStopped, type BatchDto, type BatchId } from '@10db/contracts';
import {
  deleteAppSetting,
  deleteCuttingBatch,
  getBatch,
  getBatchRow,
  getProject,
  listBatches,
  listCheckoutReturns,
  listLiveWorktrees,
  listWorkstreams,
  patchBatch,
  transitionBatch,
} from '@10db/db';
import type { StateStore } from '../events';
import { existsAsEntry, WorktreeNotOursError, worktreePinKey, type Git } from '../git';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { batchBranchName } from './branch-name';
import { listStrayBranches, settleAbandonedBranches } from './branch-sweep';
import { batchCheckout } from './checkout';
import { stopCiFixing } from './ci-stop';
import { forTasks, startCards, worktreeCards, wrongBranchCard, type Card } from './cards';
import { cuttingTasks, forgetCuttingTasks } from './cutting-tasks';
import { forgetStartSiblings } from './start-siblings';
import { returnCheckout } from './checkout-return';
import { raise, type DeliveryContext } from './context';
import { settleLeftOutCards } from './left-out-settle';
import { recoverUnopenedPasses } from './pass-recover';
import { removeScratchLeftovers } from './scratch-gate';
import type { Shipper } from './ship';
import type { BatchStarter } from './start';
import { retireWorktree } from './worktree-cleanup';
import { removeIfEmptyDirectory } from './worktree-leftover';
import { sweepWorktrees } from './worktree-sweep';

/** Kills a recorded process (group) only while its start time still matches (recovery/processes.ts). */
export interface GateTerminator {
  terminate(target: {
    readonly pid: number;
    readonly startedAt: string;
    readonly group?: boolean;
  }): Promise<unknown>;
}

export interface BatchRecoveryReport {
  /** CUTTING batches the restart interrupted, queued to be cut again as they are. */
  readonly recut: BatchId[];
  readonly deleted: BatchId[];
  readonly failed: BatchId[];
  readonly resumed: BatchId[];
  /** Finished batches whose worktree recovery removed and whose path it cleared. */
  readonly retired: BatchId[];
  /** Worktrees the sweep removed because no batch names them. */
  readonly swept: string[];
  /** Finished shared batches whose checkout recovery switched back. */
  readonly switchedBack: BatchId[];
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Batch delivery spec §5 and §6 and worktree mode spec §7 at startup, after workstream recovery and
 * before the scheduler: a CUTTING row's worktree is removed and the row cut again as it is, its
 * tasks keeping their workstreams; when something the cut left needs a person (a directory with
 * files at the worktree path, a branch holding commits, a shared checkout already switched) the row
 * is deleted instead, with a card; an orphaned shipping gate is killed; an unfinished
 * batch whose checkout is missing or off its branch fails; a SHIPPING batch re-runs from step 0; a
 * finished shared batch's checkout is switched back as its end would have done; a finished batch's
 * worktree goes; the sweep removes worktrees no batch names; an OPEN batch whose work all settled
 * ships. Without `worktrees`, worktree removal and the sweep are skipped.
 */
export async function recoverBatches(deps: {
  readonly state: StateStore;
  readonly git: Git;
  readonly inbox: InboxService;
  readonly processes: GateTerminator;
  readonly shipper: Shipper;
  /** Cuts again a CUTTING batch the restart interrupted. */
  readonly starter: Pick<BatchStarter, 'recut'>;
  readonly logger: Logger;
  /** The delivery context worktree cleanup runs in, and this daemon's worktree root. */
  readonly worktrees?: { readonly ctx: DeliveryContext; readonly root: string };
}): Promise<BatchRecoveryReport> {
  const db = deps.state.db;
  const report: BatchRecoveryReport = {
    recut: [],
    deleted: [],
    failed: [],
    resumed: [],
    retired: [],
    swept: [],
    switchedBack: [],
  };

  /**
   * Removes a CUTTING row's worktree: what git lists at its path, or an unlisted empty directory.
   * Resolves with a path left in place (unlisted, with something in it), else null. A removal git
   * refuses for any other reason leaves the entry to a later start's sweep, since the row goes.
   */
  async function removeCutWorktree(root: string, batch: BatchDto): Promise<string | null> {
    const path = batch.worktreePath;
    if (path === null) return null;
    try {
      await deps.git.removeWorktree(getProject(db, batch.projectId).repoPath, path);
    } catch (error) {
      if (error instanceof WorktreeNotOursError)
        return removeIfEmptyDirectory(root, path) ? null : path;
      deps.logger.warn({ batchId: batch.id, path, err: message(error) }, 'cut worktree kept');
    }
    return null;
  }

  /**
   * Whether a CUTTING row can be cut again as it is: its workstreams are still on it, and what the
   * interrupted cut left in git is gone or can be removed without losing anything. A cut made
   * mid-way on a branch the checkout is on, or on a branch that holds commits, is left to a person.
   * A fix batch's branch is the pull request's, so nothing of it is touched.
   */
  async function cuttableAgain(batch: BatchDto): Promise<boolean> {
    if (listWorkstreams(db, { batchId: batch.id }).length === 0) return false;
    if (batch.ciFixOf !== null) return true;
    const repo = getProject(db, batch.projectId).repoPath;
    const branch = batchBranchName(batch.title, batch.id);
    try {
      // A shared cut that switched the checkout lost where it came from, which the cut again needs.
      if (batch.worktreePath === null && (await deps.git.currentBranch(repo)) === branch)
        return false;
      const tip = await deps.git.branchTip(repo, branch);
      if (tip === null) return true;
      if ((await deps.git.branchInUse(repo, branch)) !== null) return false;
      // Only a branch with nothing of its own on it goes: the cut made it and never opened the batch.
      if (!(await deps.git.isAncestor(repo, tip, `refs/remotes/origin/${batch.baseBranch}`)))
        return false;
      return await deps.git.deleteBranchIfAt(repo, branch, tip);
    } catch (error) {
      deps.logger.warn({ batchId: batch.id, err: message(error) }, 'cut left in git not cleared');
      return false;
    }
  }

  // 0. A pass the daemon stopped opening after its branch was made and before its row was written.
  await recoverUnopenedPasses(deps);

  // 1. CUTTING rows: what git lists at the worktree path goes; an unlisted directory only when empty.
  // A row the restart interrupted is then cut again, as it is, so its tasks keep their place in line.
  // One that can't be (something is left that only a person can settle, or an earlier daemon's row
  // with no workstreams) is deleted with a card saying its tasks did not start.
  for (const batch of listBatches(db, { states: [BatchState.Cutting] })) {
    const left = deps.worktrees ? await removeCutWorktree(deps.worktrees.root, batch) : null;
    if (left === null && (await cuttableAgain(batch))) {
      deps.starter.recut(batch.id);
      report.recut.push(batch.id);
      continue;
    }
    // Read before the delete, which detaches the batch's workstreams.
    const taskIds = cuttingTasks(db, batch.id);
    const reason = 'the daemon restarted while cutting the branch';
    const card =
      left === null ? startCards.cutInterrupted(batch) : worktreeCards.leftBehind(batch, left);
    deps.state.write((w) => {
      deleteCuttingBatch(w, batch.id, reason);
      deleteAppSetting(w, worktreePinKey(batch.id));
      forgetCuttingTasks(w, batch.id);
      forgetStartSiblings(w, batch.id);
      // The row was the guard against making the same fix again, so the root stops fixing; the
      // pull request's CI-stop card has the Retry.
      if (batch.ciFixOf !== null) stopCiFixing(w, batch.ciFixOf, CiStopped.NoCut, card.title);
    });
    // The API answered 202 for its tasks; say they didn't start (a later start of them closes the
    // card), or what was left at the path, which only moving it settles. A fix batch's start can't
    // be repeated: a plain start would make a second fix for the pull request.
    raise(
      deps.inbox,
      batch.projectId,
      left === null
        ? forTasks(card, taskIds, batch.ciFixOf === null ? { title: batch.title } : null)
        : card,
    );
    report.deleted.push(batch.id);
  }

  // 2. Orphaned shipping gates, and the gate a Workbench pass runs on its pushed tip while it is open
  // (or failed, after a close's gate failed).
  for (const batch of listBatches(db, {
    states: [BatchState.Shipping, BatchState.Open, BatchState.Failed],
  })) {
    if (batch.state !== BatchState.Shipping && batch.passId == null) continue;
    const row = getBatchRow(db, batch.id);
    if (row.gatePid === null || row.gatePidStart === null) continue;
    await deps.processes.terminate({ pid: row.gatePid, startedAt: row.gatePidStart, group: true });
    deps.state.write((w) => patchBatch(w, batch.id, { gatePid: null, gatePidStart: null }));
  }

  // 3. OPEN and SHIPPING batches, each in its checkout. A FAILED one stays as it is: its card
  // offers Retry, which makes a worktree whole again. A pass's batch is its pass's to recover: the
  // folder may be off its branch by the builder's own switch, and its ship is the pass's close.
  for (const batch of listBatches(db, { states: [BatchState.Open, BatchState.Shipping] })) {
    if (batch.passId != null) continue;
    const checkout = batchCheckout(db, batch);
    let card: Card | null = null;
    if (batch.worktreePath !== null && !existsAsEntry(batch.worktreePath)) {
      card = worktreeCards.missing(batch, batch.worktreePath, 'failed');
    } else {
      // A checkout git won't read or trust counts as off the branch; the trust card says why.
      const current = await deps.git.currentBranch(checkout).catch(() => null);
      if (current !== batch.branch) card = wrongBranchCard(batch, current, checkout, 'failed');
    }
    if (card !== null) {
      const reason = card.title;
      deps.state.write((w) => {
        settleLeftOutCards(
          w,
          transitionBatch(w, batch.id, {
            to: BatchState.Failed,
            patch: { failure: BatchFailure.WrongBranch },
            reason,
          }),
        );
      });
      raise(deps.inbox, batch.projectId, card);
      report.failed.push(batch.id);
      continue;
    }
    if (batch.state === BatchState.Shipping) {
      deps.shipper.resume(batch.id);
      report.resumed.push(batch.id);
    }
  }

  // 4. Finished shared batches whose checkout was never switched back: the daemon stopped between
  // recording the end and the switch.
  for (const batch of listCheckoutReturns(db))
    if ((await returnCheckout(deps, batch.id)) === 'switched') report.switchedBack.push(batch.id);

  if (deps.worktrees) {
    // 5. Finished batches whose path is still set: the removal and clear a crash cut short. A dirty
    // ABANDONED worktree, or a finished one holding git-ignored files 10db didn't seed, is kept, with
    // its card.
    for (const batch of listLiveWorktrees(db)) {
      try {
        if (
          batch.state === BatchState.Shipped ||
          batch.state === BatchState.Closed ||
          batch.state === BatchState.Abandoned
        )
          await retireWorktree(deps.worktrees.ctx, batch.id);
        else continue;
      } catch (error) {
        deps.logger.warn(
          { batchId: batch.id, path: batch.worktreePath, err: message(error) },
          'batch worktree not removed',
        );
        continue;
      }
      if (getBatch(db, batch.id).worktreePath === null) report.retired.push(batch.id);
    }

    // 6. The sweep, after every removal above, so it only finds what no batch names.
    report.swept.push(
      ...(await sweepWorktrees({
        state: deps.state,
        git: deps.git,
        inbox: deps.inbox,
        root: deps.worktrees.root,
        logger: deps.logger,
      })),
    );
  }

  // 6a. The scratch gate branches of passes, whose worktrees the sweep just removed.
  if (deps.worktrees) await removeScratchLeftovers(deps.worktrees.ctx);

  // 6b. Abandoned batches whose worktree is gone but whose branch was never settled get their branch
  // deleted or offered, after step 5 retired what it could. Then one card for the 10db branches no
  // batch names. The branches of merged pull requests go in the pull request watch's first round,
  // which reads gh.
  if (deps.worktrees) {
    await settleAbandonedBranches(deps.worktrees.ctx);
    await listStrayBranches(deps.worktrees.ctx);
  }

  // 7. OPEN batches whose work all settled ship.
  deps.shipper.checkOpenBatches();
  deps.logger.info({ ...report }, 'batch recovery complete');
  return report;
}
