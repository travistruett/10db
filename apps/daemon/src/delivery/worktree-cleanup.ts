import { lstatSync, readdirSync, realpathSync, rmdirSync } from 'node:fs';
import { sep } from 'node:path';
import { BatchState, type BatchId } from '@10db/contracts';
import { clearWorktreePath, deleteAppSetting, getBatch, getProject } from '@10db/db';
import { GitTrustError, WorktreeNotOursError } from '../git';
import { worktreeCards } from './cards';
import { raise, type DeliveryContext } from './context';
import { existsAsEntry } from './worktree-cut';

/** The app setting a worktree's pin is kept under. */
export const worktreePinKey = (batchId: BatchId): string => `checkout_pin.${batchId}`;

/**
 * States in which no workstream of the batch can run again, so its worktree may go: once the path is
 * cleared, `checkoutOf` answers the main checkout.
 */
const FINISHED: readonly BatchState[] = [
  BatchState.Shipped,
  BatchState.Closed,
  BatchState.Abandoned,
];

/** Removes an empty, real directory under the worktree root; false when anything else is there. */
function removedIfEmpty(ctx: DeliveryContext, path: string): boolean {
  try {
    if (!lstatSync(path).isDirectory()) return false;
    if (!realpathSync(path).startsWith(`${realpathSync(ctx.worktreeRoot)}${sep}`)) return false;
    if (readdirSync(path).length > 0) return false;
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * W12/W14 after SHIPPED or CLOSED (and ABANDONED once its worktree is known clean): remove the
 * worktree, delete a CLOSED batch's branch while it is still at its base, then drop the pin and clear
 * `worktree_path` in one transaction. The clear is last, so recovery re-runs every earlier step after
 * a crash. Safe to repeat; a no-op once cleared.
 */
export async function retireWorktree(ctx: DeliveryContext, batchId: BatchId): Promise<void> {
  const batch = getBatch(ctx.state.db, batchId);
  const path = batch.worktreePath;
  if (path === null || !FINISHED.includes(batch.state)) return;
  const main = getProject(ctx.state.db, batch.projectId).repoPath;
  try {
    await ctx.git.removeWorktree(main, path);
  } catch (error) {
    if (!(error instanceof WorktreeNotOursError)) throw error;
    // Something git doesn't list as 10db's: leave it, say so, and stop treating it as live.
    if (!removedIfEmpty(ctx, path))
      raise(ctx.inbox, batch.projectId, worktreeCards.leftBehind(batch, path));
  }
  if (batch.state === BatchState.Closed && batch.branch !== null && batch.baseSha !== null)
    await ctx.git.deleteBranchIfAt(main, batch.branch, batch.baseSha);
  ctx.state.write((w) => {
    deleteAppSetting(w, worktreePinKey(batchId));
    clearWorktreePath(w, batchId);
  });
  ctx.logger.info({ batchId, path, state: batch.state }, 'batch worktree removed');
}

/**
 * After ABANDONED: retire a clean or missing worktree; keep one with uncommitted changes, with its
 * path set, and raise a card naming it. One git won't trust is kept too (the trust card explains).
 */
export async function abandonWorktree(ctx: DeliveryContext, batchId: BatchId): Promise<void> {
  const batch = getBatch(ctx.state.db, batchId);
  const path = batch.worktreePath;
  if (path === null) return;
  if (existsAsEntry(path)) {
    let changed: string[];
    try {
      changed = await ctx.git.changedPaths(path);
    } catch (error) {
      if (error instanceof GitTrustError) {
        ctx.logger.warn({ batchId, path, err: error.message }, 'abandoned worktree kept');
        return;
      }
      throw error;
    }
    if (changed.length > 0) {
      raise(ctx.inbox, batch.projectId, worktreeCards.keptDirty(batch, path, changed));
      return;
    }
  }
  await retireWorktree(ctx, batchId);
}
