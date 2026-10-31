import { existsSync } from 'node:fs';
import {
  BRANCH_PREFIX,
  BatchState,
  Delivery,
  PullRequestState,
  type BatchId,
} from '@10db/contracts';
import { hasAnsweredByFoldKey, listBatches, listProjects } from '@10db/db';
import { PrState } from '../github';
import { removeBranch, settleBranch } from './branch-cleanup';
import { branchCardKey, branchCards, detailOf } from './cards';
import { ghCall, networkCall, raise, withdraw, type DeliveryContext } from './context';
import { ghDown } from './pr-watch';

/**
 * Deletes the local branch of every shipped task whose pull request merged, in each pull request
 * project. The branch goes only when GitHub says what the pull request's head was and the local
 * tip is that commit or one behind it, so a branch holding a commit the pull request never
 * carried stays. A branch checked out in the main checkout or a worktree stays too, and the next
 * run tries again. A gh failure ends the run: every later read would fail the same way. Any other
 * failure is about one branch: it is logged and the branches after it are still swept. It never
 * rejects, and git is only asked when some merged task still has its branch.
 */
export async function removeMergedBranches(
  ctx: DeliveryContext,
  signal: AbortSignal,
): Promise<void> {
  for (const project of listProjects(ctx.state.db)) {
    if (project.delivery !== Delivery.PullRequest || !existsSync(project.repoPath)) continue;
    const merged = listBatches(ctx.state.db, {
      projectId: project.id,
      states: [BatchState.Shipped],
    }).filter(
      (b) => b.pr?.state === PullRequestState.Merged && b.branch?.startsWith(BRANCH_PREFIX),
    );
    if (merged.length === 0) continue;
    try {
      const local = new Set(
        (await ctx.git.localBranches(project.repoPath, BRANCH_PREFIX)).map((b) => b.name),
      );
      for (const batch of merged) {
        const { branch, repo, prUrl } = batch;
        if (branch === null || repo === null || prUrl === null || !local.has(branch)) continue;
        if (signal.aborted) return;
        try {
          await sweepOne(ctx, project.repoPath, { id: batch.id, branch, repo, prUrl }, signal);
        } catch (error) {
          if (stopped(signal)) return;
          // gh being down fails every later read the same way: end the run, as before.
          if (ghDown(error)) throw error;
          // Anything else is about this branch alone, and must not hold back the ones after it: the
          // oldest merged branch would otherwise block every other for ever.
          ctx.logger.warn(
            { batchId: batch.id, branch, err: detailOf(error) },
            'merged branch not swept',
          );
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      ctx.logger.warn({ projectId: project.id, err: detailOf(error) }, 'merged branches not swept');
    }
  }
}

/** Whether the daemon stopped; a function, so a check after an await is not read as the one before. */
const stopped = (signal: AbortSignal): boolean => signal.aborted;

/**
 * Deletes one merged task's branch if the pull request's head, as GitHub reports it now, carries
 * everything the branch holds. A head this repository lacks (a commit GitHub made, such as a branch
 * update) is fetched first; when it can't be had, the branch stays, since nothing says what the
 * branch holds beyond it.
 */
async function sweepOne(
  ctx: DeliveryContext,
  repoPath: string,
  batch: { id: BatchId; branch: string; repo: string; prUrl: string },
  signal: AbortSignal,
): Promise<void> {
  const { branch } = batch;
  const read = await ctx.gh.prStatus({ repo: batch.repo, ref: batch.prUrl }, ghCall(ctx, signal));
  const head = read?.state === PrState.Merged ? read.headSha : null;
  if (head === null) return;
  const memo: { known?: Promise<boolean> } = {};
  const headHere = (): Promise<boolean> => (memo.known ??= haveCommit(ctx, repoPath, head, signal));
  const removal = await removeBranch(
    ctx.git,
    repoPath,
    branch,
    async (tip) => tip === head || ((await headHere()) && ctx.git.isAncestor(repoPath, tip, head)),
  );
  ctx.logger.info({ batchId: batch.id, branch, removal: removal.kind }, 'merged branch swept');
}

/** Whether `repoPath` holds commit `sha`, fetching it from origin once if it does not. */
async function haveCommit(
  ctx: DeliveryContext,
  repoPath: string,
  sha: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (await ctx.git.hasCommit(repoPath, sha)) return true;
  try {
    await ctx.git.fetchCommit(repoPath, sha, networkCall(ctx, signal));
  } catch (error) {
    if (signal.aborted) throw error;
    ctx.logger.warn({ repoPath, sha, err: detailOf(error) }, 'pull request head not fetched');
    return false;
  }
  return ctx.git.hasCommit(repoPath, sha);
}

/**
 * Settles, at startup, the branch of every ABANDONED batch whose worktree is gone and whose branch
 * is still local: one abandoned before 10db cleaned branches, or in a shared checkout whose settle
 * failed. Like the end of the batch, it deletes a branch still at its base and offers one holding
 * commits on a card. A batch whose card the builder answered (Keep, or a Delete Branch git refused)
 * is left, so Keep holds across restarts; a worktree still kept is left to its own card. Git is
 * asked once per project unless some batch's branch is still local. It never rejects.
 */
export async function settleAbandonedBranches(ctx: DeliveryContext): Promise<void> {
  for (const project of listProjects(ctx.state.db)) {
    if (!existsSync(project.repoPath)) continue;
    const abandoned = listBatches(ctx.state.db, {
      projectId: project.id,
      states: [BatchState.Abandoned],
    }).filter(
      (b) =>
        b.worktreePath === null &&
        b.branch?.startsWith(BRANCH_PREFIX) &&
        !hasAnsweredByFoldKey(ctx.state.db, project.id, branchCardKey.offer(b.id)),
    );
    if (abandoned.length === 0) continue;
    try {
      const local = new Set(
        (await ctx.git.localBranches(project.repoPath, BRANCH_PREFIX)).map((b) => b.name),
      );
      for (const batch of abandoned)
        if (batch.branch !== null && local.has(batch.branch)) await settleBranch(ctx, batch.id);
    } catch (error) {
      ctx.logger.warn(
        { projectId: project.id, err: detailOf(error) },
        'abandoned branches not settled',
      );
    }
  }
}

/**
 * Lists, in one card per project, the local `10db/` branches no batch names: 10db has no record of
 * making them, so it never deletes them. The card is withdrawn once none is left. It never rejects.
 */
export async function listStrayBranches(ctx: DeliveryContext): Promise<void> {
  for (const project of listProjects(ctx.state.db)) {
    if (project.delivery !== Delivery.PullRequest || !existsSync(project.repoPath)) continue;
    try {
      const named = new Set(
        listBatches(ctx.state.db, { projectId: project.id }).map((batch) => batch.branch),
      );
      const stray = (await ctx.git.localBranches(project.repoPath, BRANCH_PREFIX))
        .map((b) => b.name)
        .filter((name) => !named.has(name));
      if (stray.length > 0) raise(ctx.inbox, project.id, branchCards.withoutBatch(stray));
      else withdraw(ctx.state, ctx.inbox, project.id, [branchCardKey.withoutBatch]);
    } catch (error) {
      ctx.logger.warn({ projectId: project.id, err: detailOf(error) }, 'stray branches not listed');
    }
  }
}
