import type { BatchId } from '@10db/contracts';
import { deleteAppSetting, getAppSetting, setAppSetting, type DbReader } from '@10db/db';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import type { Git } from '../git';
import type { Logger } from '../log';
import { showNotice } from './context';
import { checkInstall } from './install-health';
import { installNotices, seedNotices, type UnbuiltWhy } from './notices';
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
  readonly clock: Clock;
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

/** Leaves the `install-repaired` notice; a notice that can't be written is logged, not a stop. */
export function noticeRepaired(
  ctx: Pick<InstallContext, 'state' | 'logger' | 'clock'>,
  batchId: BatchId,
  unresolved: string,
): void {
  try {
    showNotice(ctx.state, batchId, installNotices.repaired(unresolved, ctx.clock.now()));
  } catch (error) {
    ctx.logger.warn({ batchId, err: error }, 'install notice not written');
  }
}

/** What `refresh`'s own start over repaired in the copy a failed install left broken; null when it repaired nothing. */
function repairedBy(
  outcome: DependencyRefresh,
  path: string,
  goesOnAfterFailure: boolean,
): string | null {
  if (outcome.kind !== 'installed' && outcome.kind !== 'failed') return null;
  if (outcome.kind === 'failed' && !goesOnAfterFailure) return null;
  if (outcome.leftBroken === undefined) return null;
  return checkInstall(path).kind === 'whole' ? outcome.leftBroken : null;
}

/**
 * Records what an install of the worktree at `path` leaves its packages matching: the lockfile at its
 * HEAD after a passing install, and nothing after any other outcome, so the next gate installs again.
 * Two things every caller gets told to the builder here. An install that started over took any built
 * output with the `node_modules` it removed, and ran no install script. And a start over of `refresh`'s
 * own that brought back what a failed install left broken is a repair, whether it exited zero or, for
 * the one caller that goes on then (`goesOnAfterFailure`), not; every other caller stops on that failure,
 * so nothing was repaired for it (`decisions/2026-11-03-a-broken-install-repairs-itself-once.md`).
 */
export async function recordInstall(
  ctx: InstallContext,
  batchId: BatchId,
  path: string,
  outcome: DependencyRefresh,
  { goesOnAfterFailure = false }: { readonly goesOnAfterFailure?: boolean } = {},
): Promise<void> {
  const blob =
    outcome.kind === 'installed' ? await ctx.git.blobAt(path, 'HEAD', PNPM_LOCKFILE) : null;
  ctx.state.write((w) => {
    if (blob === null) deleteAppSetting(w, installedLockfileKey(batchId));
    else setAppSetting(w, installedLockfileKey(batchId), blob);
  });
  if (outcome.kind === 'installed' && outcome.startedOver)
    noticeUnbuilt(ctx, batchId, path, 'started_over');
  const repaired = repairedBy(outcome, path, goesOnAfterFailure);
  if (repaired !== null) noticeRepaired(ctx, batchId, repaired);
}
