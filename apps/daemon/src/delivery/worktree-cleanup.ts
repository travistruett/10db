import { BatchState, type BatchId } from '@10db/contracts';
import { clearWorktreePath, deleteAppSetting, getBatch, getProject } from '@10db/db';
import {
  existsAsEntry,
  GitTrustError,
  WorktreeNotOursError,
  worktreePinKey,
  type Git,
} from '../git';
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
  /**
   * Kept, its path still set, with a card: an ABANDONED batch's worktree with uncommitted changes,
   * or any finished batch's worktree with git-ignored files 10db didn't seed.
   */
  | {
      readonly kind: 'kept';
      readonly reason: 'changes' | 'ignored';
      readonly paths: readonly string[];
    }
  /** An ABANDONED batch's worktree git won't trust: kept unread (the trust card explains). */
  | { readonly kind: 'untrusted' };

/**
 * After SHIPPED, CLOSED or ABANDONED, when no workstream of the batch can run again: remove the
 * worktree, delete a CLOSED batch's branch while it is still at its base, then drop the pin and
 * clear `worktree_path` in one transaction. An ABANDONED batch's worktree is removed only when it
 * is clean, and any finished one only when it holds no git-ignored file outside the seeded
 * directories, such as a hand-made `.env`; both are checked here so no caller can remove them, and
 * a kept worktree raises a card naming what it holds. The clear is last, so recovery re-runs every
 * earlier step after a crash. Safe to repeat; a no-op once cleared. Holds the batch's worktree lock.
 */
export async function retireWorktree(ctx: DeliveryContext, batchId: BatchId): Promise<Retirement> {
  return withWorktreeLock(batchId, () => retire(ctx, batchId));
}

async function retire(ctx: DeliveryContext, batchId: BatchId): Promise<Retirement> {
  const batch = getBatch(ctx.state.db, batchId);
  const path = batch.worktreePath;
  if (path === null || !FINISHED.includes(batch.state)) return { kind: 'nothing' };
  const project = getProject(ctx.state.db, batch.projectId);
  const main = project.repoPath;
  if (batch.state === BatchState.Abandoned && existsAsEntry(path)) {
    try {
      const changed = await ctx.git.changedPaths(path);
      if (changed.length > 0) {
        raise(ctx.inbox, project.id, worktreeCards.keptDirty(batch, main, path, changed));
        return { kind: 'kept', reason: 'changes', paths: changed };
      }
    } catch (error) {
      if (!(error instanceof GitTrustError)) throw error;
      ctx.logger.warn({ batchId, path, err: error.message }, 'abandoned worktree kept');
      return { kind: 'untrusted' };
    }
  }
  const ignored = await unseededIgnoredFiles(ctx.git, main, path, project.worktreeSeed);
  if (ignored.length > 0) {
    raise(ctx.inbox, project.id, worktreeCards.keptIgnored(batch, main, path, ignored));
    return { kind: 'kept', reason: 'ignored', paths: ignored };
  }
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
 * The git-ignored files of the 10db worktree of `main` at `path` that lie in no directory named in
 * the project's seed, which 10db copied in: what a builder or a lane put there and may still need.
 * None when nothing is at `path`, or when git doesn't list it as 10db's (removal then says so).
 */
export async function unseededIgnoredFiles(
  git: Git,
  main: string,
  path: string,
  seed: readonly string[],
): Promise<string[]> {
  if (!existsAsEntry(path)) return [];
  try {
    const files = await git.worktreeIgnoredFiles(main, path);
    return files.filter((file) => !file.split('/').some((part) => seed.includes(part)));
  } catch (error) {
    if (error instanceof WorktreeNotOursError) return [];
    throw error;
  }
}
