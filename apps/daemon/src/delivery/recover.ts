import { BatchFailure, BatchState, type BatchDto, type BatchId } from '@10db/contracts';
import {
  deleteAppSetting,
  deleteCuttingBatch,
  getBatch,
  getBatchRow,
  getProject,
  listBatches,
  listCheckoutReturns,
  listLiveWorktrees,
  patchBatch,
  transitionBatch,
} from '@10db/db';
import type { StateStore } from '../events';
import { existsAsEntry, WorktreeNotOursError, worktreePinKey, type Git } from '../git';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { batchCheckout } from './checkout';
import { forTasks, startCards, worktreeCards, wrongBranchCard, type Card } from './cards';
import { cuttingTasks, forgetCuttingTasks } from './cutting-tasks';
import { returnCheckout } from './checkout-return';
import { raise, type DeliveryContext } from './context';
import type { Shipper } from './ship';
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
 * before the scheduler: a CUTTING row's worktree is removed and the row deleted (a branch the crash
 * left stays, and the next cut uses a new name); an orphaned shipping gate is killed; an unfinished
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
  readonly logger: Logger;
  /** The delivery context worktree cleanup runs in, and this daemon's worktree root. */
  readonly worktrees?: { readonly ctx: DeliveryContext; readonly root: string };
}): Promise<BatchRecoveryReport> {
  const db = deps.state.db;
  const report: BatchRecoveryReport = {
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

  // 1. CUTTING rows: what git lists at the worktree path goes; an unlisted directory only when empty.
  for (const batch of listBatches(db, { states: [BatchState.Cutting] })) {
    const left = deps.worktrees ? await removeCutWorktree(deps.worktrees.root, batch) : null;
    // Read before the delete, which detaches the batch's workstreams.
    const taskIds = cuttingTasks(db, batch.id);
    deps.state.write((w) => {
      deleteCuttingBatch(w, batch.id, 'the daemon restarted while cutting the branch');
      deleteAppSetting(w, worktreePinKey(batch.id));
      forgetCuttingTasks(w, batch.id);
    });
    // The API answered 202 for its tasks; say they didn't start (a later start of them closes the
    // card), or what was left at the path, which only moving it settles.
    raise(
      deps.inbox,
      batch.projectId,
      left === null
        ? forTasks(startCards.cutInterrupted(batch), taskIds)
        : worktreeCards.leftBehind(batch, left),
    );
    report.deleted.push(batch.id);
  }

  // 2. Orphaned shipping gates.
  for (const batch of listBatches(db, { states: [BatchState.Shipping] })) {
    const row = getBatchRow(db, batch.id);
    if (row.gatePid === null || row.gatePidStart === null) continue;
    await deps.processes.terminate({ pid: row.gatePid, startedAt: row.gatePidStart, group: true });
    deps.state.write((w) => patchBatch(w, batch.id, { gatePid: null, gatePidStart: null }));
  }

  // 3. OPEN and SHIPPING batches, each in its checkout. A FAILED one stays as it is: its card
  // offers Retry, which makes a worktree whole again.
  for (const batch of listBatches(db, { states: [BatchState.Open, BatchState.Shipping] })) {
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
      deps.state.write((w) =>
        transitionBatch(w, batch.id, {
          to: BatchState.Failed,
          patch: { failure: BatchFailure.WrongBranch },
          reason,
        }),
      );
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

  // 7. OPEN batches whose work all settled ship.
  deps.shipper.checkOpenBatches();
  deps.logger.info({ ...report }, 'batch recovery complete');
  return report;
}
