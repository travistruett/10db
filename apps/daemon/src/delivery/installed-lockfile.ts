import type { BatchId } from '@10db/contracts';
import { deleteAppSetting, getAppSetting, setAppSetting, type DbReader } from '@10db/db';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { PNPM_LOCKFILE, type DependencyRefresh } from './worktree-dependencies';

/** The app setting that holds the lockfile blob a batch's worktree packages were last installed from. */
export const installedLockfileKey = (batchId: BatchId): string => `worktree_lockfile.${batchId}`;

/** The lockfile blob the batch's worktree last installed from; null when none is on record. */
export function installedLockfile(db: DbReader, batchId: BatchId): string | null {
  const value = getAppSetting(db, installedLockfileKey(batchId));
  return typeof value === 'string' ? value : null;
}

/**
 * Records what an install of the worktree at `path` leaves its packages matching: the lockfile at its
 * HEAD after a passing install, and nothing after any other outcome, so the next gate installs again.
 */
export async function recordInstall(
  ctx: { readonly state: StateStore; readonly git: Git },
  batchId: BatchId,
  path: string,
  outcome: DependencyRefresh,
): Promise<void> {
  const blob =
    outcome.kind === 'installed' ? await ctx.git.blobAt(path, 'HEAD', PNPM_LOCKFILE) : null;
  ctx.state.write((w) => {
    if (blob === null) deleteAppSetting(w, installedLockfileKey(batchId));
    else setAppSetting(w, installedLockfileKey(batchId), blob);
  });
}
