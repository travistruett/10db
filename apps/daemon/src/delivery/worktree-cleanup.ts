import { BatchState, type BatchId } from '@10db/contracts';
import {
  clearWorktreePath,
  deleteAppSetting,
  getBatch,
  getProject,
  listWorkstreams,
} from '@10db/db';
import {
  existsAsEntry,
  GitTrustError,
  WorktreeNotOursError,
  worktreePinKey,
  type Git,
} from '../git';
import { looseWork } from './build-output';
import { keptWorktreeKey, worktreeCards } from './cards';
import { raise, withdraw, type DeliveryContext } from './context';
import { installedLockfileKey } from './installed-lockfile';
import { startRef } from './start-refs';
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
   * any finished batch's worktree with git-ignored files 10db didn't seed, or one git lists as 10db's
   * whose git dir 10db won't read through (no paths), which may hold either.
   */
  | {
      readonly kind: 'kept';
      readonly reason: 'changes' | 'ignored' | 'unreadable';
      readonly paths: readonly string[];
    }
  /** An ABANDONED batch's worktree git won't trust: kept unread (the trust card explains). */
  | { readonly kind: 'untrusted' };

/**
 * After SHIPPED, CLOSED or ABANDONED, when no workstream of the batch can run again: remove the
 * worktree, delete a CLOSED batch's branch while it is still at its base, then drop the pin and
 * clear `worktree_path` in one transaction. An ABANDONED batch's worktree is removed only when it
 * is clean, and any finished one only when it holds no git-ignored file outside the seeded
 * directories other than build output, such as a hand-made `.env`; both are checked here so no
 * caller can remove them, and a kept worktree raises a card naming what it holds. Removal
 * withdraws those cards. The clear is last, so recovery re-runs every earlier step after a crash.
 * Safe to repeat; a no-op once cleared. Holds the batch's worktree lock.
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
        const ignored = await unseededIgnoredFiles(ctx.git, main, path, project.worktreeSeed);
        raise(
          ctx.inbox,
          project.id,
          worktreeCards.keptDirty(batch, main, path, changed, ignored ?? []),
        );
        return { kind: 'kept', reason: 'changes', paths: changed };
      }
    } catch (error) {
      if (!(error instanceof GitTrustError)) throw error;
      ctx.logger.warn({ batchId, path, err: error.message }, 'abandoned worktree kept');
      return { kind: 'untrusted' };
    }
  }
  const ignored = await unseededIgnoredFiles(ctx.git, main, path, project.worktreeSeed);
  if (ignored === null) {
    raise(ctx.inbox, project.id, worktreeCards.keptIgnored(batch, main, path, null));
    return { kind: 'kept', reason: 'unreadable', paths: [] };
  }
  const loose = looseWork(ignored);
  if (loose.length > 0) {
    raise(ctx.inbox, project.id, worktreeCards.keptIgnored(batch, main, path, loose));
    return { kind: 'kept', reason: 'ignored', paths: loose };
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
  // The tasks' starts on the merged base mean nothing once their worktree is gone; one git won't
  // delete is left for the startup sweep.
  for (const ws of listWorkstreams(ctx.state.db, { batchId }))
    await ctx.git.deleteKeptRef(main, startRef(ws.id)).catch((error: unknown) => {
      ctx.logger.warn(
        {
          batchId,
          workstreamId: ws.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'task start not dropped',
      );
    });
  ctx.state.write((w) => {
    deleteAppSetting(w, worktreePinKey(batchId));
    deleteAppSetting(w, installedLockfileKey(batchId));
    clearWorktreePath(w, batchId);
  });
  withdraw(ctx.state, ctx.inbox, project.id, [
    keptWorktreeKey.batchChanges(batchId),
    keptWorktreeKey.batchIgnored(batchId),
  ]);
  ctx.logger.info({ batchId, path, state: batch.state }, 'batch worktree removed');
  return { kind: 'retired' };
}

/** The file Finder writes into every folder it shows, which nobody needs kept. */
const FINDER_FILE = '.DS_Store';

/**
 * The git-ignored files of the 10db worktree of `main` at `path` that lie in no directory named in
 * the project's seed, which 10db copied in, other than Finder's: what its removal command deletes
 * besides wholly ignored directories. `looseWork` drops the build output among them. None when
 * nothing is at `path`, or when git doesn't list it as 10db's (removal then refuses it too). Null
 * when git lists it as 10db's but 10db won't read its git dir, which counts as holding files:
 * removal would still take them.
 */
export async function unseededIgnoredFiles(
  git: Git,
  main: string,
  path: string,
  seed: readonly string[],
): Promise<string[] | null> {
  if (!existsAsEntry(path)) return [];
  try {
    const files = await git.worktreeIgnoredFiles(main, path);
    return files.filter((file) => {
      const parts = file.split('/');
      return parts.at(-1) !== FINDER_FILE && !parts.some((part) => seed.includes(part));
    });
  } catch (error) {
    if (!(error instanceof WorktreeNotOursError)) throw error;
    return error.unreadable ? null : [];
  }
}
