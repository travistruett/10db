import { BatchState, type BatchId } from '@10db/contracts';
import { clearWorktreePath, deleteAppSetting, getBatch, getProject } from '@10db/db';
import { existsAsEntry, GitTrustError, WorktreeNotOursError, worktreePinKey } from '../git';
import { worktreeCards } from './cards';
import { raise, type DeliveryContext } from './context';
import { removeIfEmptyDirectory } from './worktree-leftover';
import { withWorktreeLock } from './worktree-lock';

/**
 * States in which no workstream of the batch can run again, so its worktree may go: once the path is
 * cleared, `checkoutOf` answers the main checkout.
 */
const FINISHED: readonly BatchState[] = [
  BatchState.Shipped,
  BatchState.Closed,
  BatchState.Abandoned,
];

/** What `retireWorktree` did. */
export type Retirement =
  /** Removed (or found gone), the pin dropped and the path cleared. */
  | { readonly kind: 'retired' }
  /** Nothing to do: no path, or a batch whose work may still run. */
  | { readonly kind: 'nothing' }
  /** An ABANDONED batch's worktree with uncommitted changes: kept, its path still set. */
  | { readonly kind: 'kept'; readonly paths: readonly string[] }
  /** An ABANDONED batch's worktree git won't trust: kept unread (the trust card explains). */
  | { readonly kind: 'untrusted' };

/**
 * After SHIPPED, CLOSED or ABANDONED, when no workstream of the batch can run again: remove the
 * worktree, delete a CLOSED batch's branch while it is still at its base, then drop the pin and
 * clear `worktree_path` in one transaction. An ABANDONED batch's worktree is removed only when it
 * is clean, checked here so no caller can remove uncommitted work. The clear is last, so recovery
 * re-runs every earlier step after a crash. Safe to repeat; a no-op once cleared. Holds the batch's
 * worktree lock.
 */
export async function retireWorktree(ctx: DeliveryContext, batchId: BatchId): Promise<Retirement> {
  return withWorktreeLock(batchId, () => retire(ctx, batchId));
}

async function retire(ctx: DeliveryContext, batchId: BatchId): Promise<Retirement> {
  const batch = getBatch(ctx.state.db, batchId);
  const path = batch.worktreePath;
  if (path === null || !FINISHED.includes(batch.state)) return { kind: 'nothing' };
  if (batch.state === BatchState.Abandoned && existsAsEntry(path)) {
    try {
      const changed = await ctx.git.changedPaths(path);
      if (changed.length > 0) return { kind: 'kept', paths: changed };
    } catch (error) {
      if (!(error instanceof GitTrustError)) throw error;
      ctx.logger.warn({ batchId, path, err: error.message }, 'abandoned worktree kept');
      return { kind: 'untrusted' };
    }
  }
  const main = getProject(ctx.state.db, batch.projectId).repoPath;
  try {
    await ctx.git.removeWorktree(main, path);
  } catch (error) {
    if (!(error instanceof WorktreeNotOursError)) throw error;
    // Something git doesn't list as 10db's: leave it, say so, and stop treating it as live.
    if (!removeIfEmptyDirectory(ctx.worktreeRoot, path))
      raise(ctx.inbox, batch.projectId, worktreeCards.leftBehind(batch, path));
  }
  if (batch.state === BatchState.Closed && batch.branch !== null && batch.baseSha !== null)
    await ctx.git.deleteBranchIfAt(main, batch.branch, batch.baseSha);
  ctx.state.write((w) => {
    deleteAppSetting(w, worktreePinKey(batchId));
    clearWorktreePath(w, batchId);
  });
  ctx.logger.info({ batchId, path, state: batch.state }, 'batch worktree removed');
  return { kind: 'retired' };
}

/**
 * After ABANDONED: retire a clean or missing worktree; keep one with uncommitted changes, with its
 * path set, and raise a card naming it. One git won't trust is kept too (the trust card explains).
 */
export async function abandonWorktree(ctx: DeliveryContext, batchId: BatchId): Promise<void> {
  const outcome = await retireWorktree(ctx, batchId);
  if (outcome.kind !== 'kept') return;
  const batch = getBatch(ctx.state.db, batchId);
  if (batch.worktreePath === null) return;
  const main = getProject(ctx.state.db, batch.projectId).repoPath;
  raise(
    ctx.inbox,
    batch.projectId,
    worktreeCards.keptDirty(batch, main, batch.worktreePath, outcome.paths),
  );
}
