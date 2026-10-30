import {
  BatchState,
  InvalidError,
  type BatchId,
  type StepPlanDto,
  type TaskId,
} from '@10db/contracts';
import {
  deleteCuttingBatch,
  getBatch,
  getProject,
  getTask,
  patchBatch,
  transitionBatch,
} from '@10db/db';
import { existsAsEntry, WORKTREE_LOCK_PREFIX } from '../git';
import { githubRepoOf } from '../github';
import { batchBranchName } from './branch-name';
import { forTasks, startCards, worktreeCards, type Card } from './cards';
import { ghCall, networkCall, raise, type DeliveryContext } from './context';
import { unmergedDependencies } from './deps';
import { recordInstall } from './installed-lockfile';
import { raiseInstallHostCards } from './worktree-dependencies';
import { seedDirs, seedWorktree } from './worktree-seed';

/** What a start hands its background job: the plans resolved in the request, by task. */
export type Plans = ReadonlyMap<TaskId, StepPlanDto>;

/** The lock reason on a batch's worktree: the marker the startup sweep looks for. */
export const worktreeLockReason = (id: BatchId): string => `${WORKTREE_LOCK_PREFIX}${id}`;

/**
 * Cutting a worktree (worktree mode spec §5): the checks in order, then the branch and a locked
 * worktree on it, then the seed of ignored directories, then the install that brings the seed in line
 * with the worktree's lockfile, then OPEN. A refusal removes what this cut made, deletes the CUTTING row
 * with its workstreams cancelled, and raises a card naming the tasks. A shutdown leaves the row for
 * startup recovery. The main checkout's branch, index and files are never read or written here.
 */
export async function cutWorktree(
  ctx: DeliveryContext,
  batchId: BatchId,
  plans: Plans,
  signal: AbortSignal,
): Promise<void> {
  const db = ctx.state.db;
  const batch = getBatch(db, batchId);
  const project = getProject(db, batch.projectId);
  const main = project.repoPath;
  const path = batch.worktreePath;
  if (path === null) throw new InvalidError(`Batch "${batch.title}" has no worktree path`);
  const branch = batchBranchName(batch.title, batch.id);
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
    });
    raise(ctx.inbox, project.id, forTasks(card, plans.keys()));
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
      await ctx.git.fetch(main, batch.baseBranch, networkCall(ctx, signal));
    } catch (error) {
      if (!stopped()) await refuse(startCards.fetchFailed(batch.baseBranch, error));
      return;
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
    let baseSha: string;
    try {
      baseSha = await ctx.git.addWorktree({
        repo: main,
        path,
        branch,
        startPoint: base,
        lockReason: worktreeLockReason(batchId),
      });
    } catch (error) {
      // addWorktree leaves nothing behind when it throws.
      if (!stopped()) await refuse(startCards.notStarted(error));
      return;
    }
    made.worktree = true;
    made.branch = true;
    made.base = baseSha;
    try {
      const seeded = await seedWorktree({
        from: main,
        to: path,
        dirs: seedDirs(await ctx.git.ignoredDirectories(main), project.worktreeSeed),
        signal,
      });
      ctx.logger.info(
        { batchId, path, files: seeded.files, links: seeded.links, skipped: seeded.skipped },
        'worktree seeded',
      );
    } catch (error) {
      if (!stopped()) await refuse(worktreeCards.seedFailed(batch, error));
      return;
    }
    if (stopped()) return;
    const installed = await ctx.dependencies.refresh({ batch, project, path, signal });
    await recordInstall(ctx, batchId, path, installed);
    switch (installed.kind) {
      case 'aborted':
        return;
      case 'failed':
        await refuse(worktreeCards.installFailed(batch, installed));
        raiseInstallHostCards(ctx, project.id, installed);
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
    ctx.state.write((w) => {
      patchBatch(w, batchId, { branch, baseSha, repo });
      transitionBatch(w, batchId, { to: BatchState.Open, reason: 'worktree cut' });
    });
    progress.opened = true;
    ctx.logger.info(
      { batchId, projectId: project.id, branch, baseSha, repo, path },
      'batch worktree cut',
    );
    ctx.onWorkQueued();
  } catch (error) {
    // An OPEN batch keeps its worktree, and a refusal that threw doesn't run twice: the job's log
    // records either error.
    if (progress.refused || progress.opened) throw error;
    if (!stopped()) await refuse(startCards.notStarted(error));
  }
}
