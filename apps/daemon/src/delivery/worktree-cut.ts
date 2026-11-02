import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  BatchState,
  CiStopped,
  InvalidError,
  type BatchId,
  type StepPlanDto,
  type TaskId,
} from '@10db/contracts';
import {
  deleteCuttingBatch,
  findUnfinishedBatch,
  getBatch,
  getProject,
  getTask,
  patchBatch,
  sharedLaneRan,
  transitionBatch,
} from '@10db/db';
import { existsAsEntry, WORKTREE_LOCK_PREFIX } from '../git';
import { githubRepoOf } from '../github';
import { batchBranchName } from './branch-name';
import { forTasks, startCards, worktreeCards, type Card } from './cards';
import { stopCiFixing } from './ci-stop';
import { ghCall, networkCall, raise, showNotice, type DeliveryContext } from './context';
import { unmergedDependencies } from './deps';
import { recordInstall } from './installed-lockfile';
import { landingWarnings, missingLandingBranch, type SameStart } from './landing';
import { seedNotices } from './notices';
import { resolveStartCards } from './stale-cards';
import { raiseInstallHostCards } from './worktree-dependencies';
import { unbuiltAllowedPackages } from './worktree-scripts';
import { seedDirs, seedWorktree } from './worktree-seed';

/** What a start hands its background job: the plans resolved in the request, by task. */
export type Plans = ReadonlyMap<TaskId, StepPlanDto>;

/** The tasks a cut is for, which is all a cut reads of their plans: a repeated cut has no plans to hand. */
export type CutTasks = ReadonlyMap<TaskId, unknown>;

/** The lock reason on a batch's worktree: the marker the startup sweep looks for. */
export const worktreeLockReason = (id: BatchId): string => `${WORKTREE_LOCK_PREFIX}${id}`;

/**
 * Cutting a worktree (worktree mode spec §5): the checks in order, then the branch and a locked
 * worktree on it, then the seed of ignored directories, then the install that brings the seed in line
 * with the worktree's lockfile, then OPEN. A refusal removes what this cut made, deletes the CUTTING row
 * with its workstreams cancelled, and raises a card naming the tasks. A shutdown leaves the row for
 * startup recovery, which cuts the same row again (`recoverBatches`). The main checkout's branch, index and files are never read or written here.
 */
export async function cutWorktree(
  ctx: DeliveryContext,
  batchId: BatchId,
  plans: CutTasks,
  signal: AbortSignal,
  sameStart?: SameStart,
): Promise<void> {
  const db = ctx.state.db;
  const batch = getBatch(db, batchId);
  const project = getProject(db, batch.projectId);
  const main = project.repoPath;
  const path = batch.worktreePath;
  if (path === null) throw new InvalidError(`Batch "${batch.title}" has no worktree path`);
  // A CI fix batch is cut on the pull request's own branch, at the head CI failed on.
  const fix =
    batch.ciFixOf !== null && batch.ciFixHead !== null && batch.branch !== null
      ? { branch: batch.branch, head: batch.ciFixHead }
      : null;
  if (batch.ciFixOf !== null && fix === null)
    throw new InvalidError(`Fix batch "${batch.title}" has no branch or failing head to cut on`);
  const branch = fix?.branch ?? batchBranchName(batch.title, batch.id);
  const made: { worktree: boolean; branch: boolean; base: string | null } = {
    worktree: false,
    branch: false,
    base: null,
  };
  const log = (error: unknown): void => {
    ctx.logger.warn(
      { err: error instanceof Error ? error.message : String(error), batchId, path },
      'could not undo a refused worktree cut',
    );
  };
  // An object, so the catch-all reads what the steps set, not a narrowed `false`.
  const progress = { refused: false, opened: false };
  const refuse = async (card: Card): Promise<void> => {
    progress.refused = true;
    if (made.worktree) await ctx.git.removeWorktree(main, path).catch(log);
    if (made.branch && made.base)
      await ctx.git.deleteBranchIfAt(main, branch, made.base).catch(log);
    ctx.state.write((w) => {
      deleteCuttingBatch(w, batchId, card.title);
      // The row was the guard against making the same fix again, so the root stops fixing.
      if (batch.ciFixOf !== null) stopCiFixing(w, batch.ciFixOf, CiStopped.NoCut, card.title);
    });
    // A CI fix batch's start can't be repeated: the pull request's CI-stop card has the Retry.
    const request = batch.ciFixOf === null ? { title: batch.title } : null;
    raise(ctx.inbox, project.id, forTasks(card, plans.keys(), request));
  };
  // A function, so the checks after an await are not narrowed away by the one before it.
  const stopped = (): boolean => signal.aborted;
  if (stopped()) return;
  try {
    if ((await ctx.git.remoteUrl(main, 'origin')) === null) {
      await refuse(startCards.noOrigin(project));
      return;
    }
    // The repository gh is told about comes from origin's pinned push URL; one added or changed
    // since the pin is refused with a card that offers it for trust.
    const repo = githubRepoOf(await ctx.git.pinnedPushUrl(main));
    if (repo === null) {
      await refuse(startCards.repoUnknown(project));
      return;
    }
    try {
      const missing = await missingLandingBranch(ctx, project, batch, signal);
      if (missing) {
        await refuse(missing);
        return;
      }
      await ctx.git.fetch(main, batch.baseBranch, networkCall(ctx, signal));
    } catch (error) {
      if (!stopped()) await refuse(startCards.fetchFailed(batch.baseBranch, error));
      return;
    }
    // Not a refusal: a notice on the batch's tasks names a landing branch that is behind the base
    // or that nothing else uses.
    for (const notice of await landingWarnings(
      ctx,
      project,
      batch,
      plans.keys(),
      signal,
      sameStart,
    )) {
      if (stopped()) break;
      try {
        showNotice(ctx.state, batchId, notice);
      } catch (error) {
        ctx.logger.warn({ batchId, err: error }, 'landing notice not written');
      }
    }
    const call = ghCall(ctx, signal);
    try {
      await ctx.gh.authStatus(call);
    } catch (error) {
      if (!stopped()) await refuse(startCards.ghUnavailable(error));
      return;
    }
    const tasks = [...plans.keys()].map((id) => getTask(db, id));
    const unmerged = await unmergedDependencies({
      db,
      gh: ctx.gh,
      call,
      tasks,
      inBatch: new Set(plans.keys()),
      batchId,
    });
    if (stopped()) return;
    if (unmerged.length > 0) {
      await refuse(startCards.unmergedDependencies(unmerged));
      return;
    }
    const base = `refs/remotes/origin/${batch.baseBranch}`;
    const filters = await ctx.git.filtersIn(main, base);
    if (filters.length > 0) {
      await refuse(startCards.usesFilters(project, filters));
      return;
    }
    if (existsAsEntry(path)) {
      await refuse(worktreeCards.pathExists(batch, path));
      return;
    }
    if (stopped()) return;
    if (fix) {
      // The pull request's branch as origin has it, then the local branch fast-forwarded to the head
      // CI failed on. Nothing here is ever reset or forced, and a refusal leaves the branch as it was.
      try {
        await ctx.git.fetch(main, fix.branch, networkCall(ctx, signal));
      } catch (error) {
        if (!stopped()) await refuse(startCards.fetchFailed(fix.branch, error));
        return;
      }
      try {
        if (!(await ctx.git.hasCommit(main, fix.head)))
          throw new InvalidError(
            `origin's ${fix.branch} does not have commit ${fix.head}; the branch was rewritten`,
          );
        await ctx.git.fastForwardBranch(main, fix.branch, fix.head);
      } catch (error) {
        if (!stopped()) await refuse(startCards.notStarted(error));
        return;
      }
      if (stopped()) return;
    }
    let baseSha: string;
    try {
      baseSha = await ctx.git.addWorktree({
        repo: main,
        path,
        branch,
        // The fix batch's branch exists: the batch it fixes made it, or the fast-forward above did.
        startPoint: fix ? null : base,
        lockReason: worktreeLockReason(batchId),
      });
    } catch (error) {
      // addWorktree leaves nothing behind when it throws.
      if (!stopped()) await refuse(startCards.notStarted(error));
      return;
    }
    made.worktree = true;
    // Never a fix batch's: its branch is the pull request's and outlives a refused cut.
    made.branch = fix === null;
    made.base = baseSha;
    // A shared lane writes the main checkout's ignored directories, `node_modules` included, and a
    // clone would carry that into this copy's gate. So nothing is cloned while a shared batch is
    // unfinished (CUTTING, OPEN, SHIPPING or FAILED), nor once any shared lane has run in the project,
    // since its writes outlive its batch. In a pnpm project the install then builds `node_modules`
    // from the copy's own lockfile, and every seed directory left unmade is named in a notice on the
    // batch's tasks (task placement spec §7, option b).
    const sharedLanes = (): boolean =>
      findUnfinishedBatch(db, project.id) !== undefined || sharedLaneRan(db, project.id);
    let seed = !sharedLanes();
    let dirs: string[];
    try {
      dirs = seedDirs(await ctx.git.ignoredDirectories(main), project.worktreeSeed);
    } catch (error) {
      if (!stopped()) await refuse(worktreeCards.seedFailed(batch, error));
      return;
    }
    if (seed) {
      try {
        const seeded = await seedWorktree({ from: main, to: path, dirs, signal });
        ctx.logger.info(
          { batchId, path, files: seeded.files, links: seeded.links, skipped: seeded.skipped },
          'worktree seeded',
        );
        // The clone holds no lock the shared cut takes: a shared batch that started meanwhile may
        // have launched a lane that wrote what the clone read. Asked again, the answer is final:
        // a lane launches only after its batch has been cut, and the batch stays visible from its
        // insert until it ends, after which the lane's session does.
        if (sharedLanes()) {
          await Promise.all(
            dirs.map((dir) => rm(join(path, dir), { recursive: true, force: true })),
          );
          seed = false;
        }
      } catch (error) {
        if (!stopped()) await refuse(worktreeCards.seedFailed(batch, error));
        return;
      }
    }
    if (!seed) {
      ctx.logger.info(
        { batchId, path, dirs },
        'worktree not seeded: a shared lane may have written the main checkout; a pnpm install builds node_modules, and nothing else is made',
      );
    }
    if (stopped()) return;
    const installed = await ctx.dependencies.refresh({
      batch,
      project,
      path,
      signal,
      seeded: seed,
    });
    await recordInstall(ctx, batchId, path, installed);
    switch (installed.kind) {
      case 'aborted':
        return;
      case 'failed':
        await refuse(worktreeCards.installFailed(batch, installed));
        await raiseInstallHostCards(ctx, project.id, installed);
        return;
      case 'installed':
        ctx.logger.info(
          { batchId, path, logPath: installed.logPath, durationMs: installed.durationMs },
          'worktree dependencies installed',
        );
        break;
      case 'skipped':
        break;
    }
    if (stopped()) return;
    if (!seed) {
      // The install makes every `node_modules` (a workspace's nested ones too), and nothing else.
      const unmade = dirs.filter(
        (dir) => installed.kind !== 'installed' || basename(dir) !== 'node_modules',
      );
      if (unmade.length > 0) {
        try {
          showNotice(ctx.state, batchId, seedNotices.skipped(unmade));
        } catch (error) {
          ctx.logger.warn({ batchId, err: error }, 'seed notice not written');
        }
      }
    }
    if (!seed && installed.kind === 'installed') {
      // The install ran no install script, and no seed carried built output: a package the project
      // allows to build (a native addon, a generated client) is installed but not built.
      const unbuilt = unbuiltAllowedPackages(path);
      if (unbuilt.length > 0) {
        try {
          showNotice(ctx.state, batchId, seedNotices.scriptsSkipped(unbuilt));
        } catch (error) {
          ctx.logger.warn({ batchId, err: error }, 'install scripts notice not written');
        }
      }
    }
    ctx.state.write((w) => {
      patchBatch(w, batchId, { branch, baseSha, repo });
      transitionBatch(w, batchId, { to: BatchState.Open, reason: 'worktree cut' });
    });
    progress.opened = true;
    ctx.logger.info(
      { batchId, projectId: project.id, branch, baseSha, repo, path },
      'batch worktree cut',
    );
    resolveStartCards(db, ctx.inbox, project.id, plans.keys());
    ctx.onWorkQueued();
  } catch (error) {
    // An OPEN batch keeps its worktree, and a refusal that threw doesn't run twice: the job's log
    // records either error.
    if (progress.refused || progress.opened) throw error;
    if (!stopped()) await refuse(startCards.notStarted(error));
  }
}
