import type { BatchId } from '@10db/contracts';
import { deleteAppSetting, getAppSetting, setAppSetting, type DbReader } from '@10db/db';
import type { StateStore } from '../events';
import type { Git } from '../git';
import type { Logger } from '../log';
import { showNotice } from './context';
import { seedNotices, type UnbuiltWhy } from './notices';
import { PNPM_LOCKFILE, type DependencyRefresh } from './worktree-dependencies';
import { unbuiltAllowedPackages } from './worktree-scripts';

/** The app setting that holds the lockfile blob a batch's worktree packages were last installed from. */
export const installedLockfileKey = (batchId: BatchId): string => `worktree_lockfile.${batchId}`;

/** The lockfile blob the batch's worktree last installed from; null when none is on record. */
export function installedLockfile(db: DbReader, batchId: BatchId): string | null {
  const value = getAppSetting(db, installedLockfileKey(batchId));
  return typeof value === 'string' ? value : null;
}

interface InstallContext {
  readonly state: StateStore;
  readonly git: Git;
  readonly logger: Logger;
}

/** Tells the builder which packages the project allows to build the copy at `path` holds unbuilt. */
export function noticeUnbuilt(
  ctx: Pick<InstallContext, 'state' | 'logger'>,
  batchId: BatchId,
  path: string,
  why: UnbuiltWhy,
): void {
  const unbuilt = unbuiltAllowedPackages(path);
  if (unbuilt.names.length === 0) return;
  try {
    showNotice(
      ctx.state,
      batchId,
      seedNotices.scriptsSkipped(unbuilt.names, why, unbuilt.legacyPnpmMajor),
    );
  } catch (error) {
    ctx.logger.warn({ batchId, err: error }, 'install scripts notice not written');
  }
}

/**
 * Records what an install of the worktree at `path` leaves its packages matching: the lockfile at its
 * HEAD after a passing install, and nothing after any other outcome, so the next gate installs again.
 * An install that started over took any built output with the `node_modules` it removed, and ran no
 * install script: every caller gets that told to the builder here.
 */
export async function recordInstall(
  ctx: InstallContext,
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
  if (outcome.kind === 'installed' && outcome.startedOver)
    noticeUnbuilt(ctx, batchId, path, 'started_over');
}
