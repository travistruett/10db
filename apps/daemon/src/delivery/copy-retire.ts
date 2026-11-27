import {
  BatchState,
  BuilderOwns,
  CopyStep,
  type BatchId,
  Urgency,
  type BatchDto,
  type LocalCopyDto,
} from '@10db/contracts';
import { getBatch, getLocalCopy, getProject, patchLocalCopy } from '@10db/db';
import { BY_ANSWER, CardTier, decidedByBuilder } from '../inbox';
import { worktreeOffer, type Card } from './cards';
import { projectAtCheckout } from './checkout';
import { withdraw, raise, type DeliveryContext } from './context';
import { teardownRef } from './copy-refs';
import { removeScratch, SCRATCH_PREFIX } from './scratch-gate';
import { retireWorktree } from './worktree-cleanup';
import { worktreeLockReason } from './worktree-cut';
import { madeWorktreeRoot, worktreePathFor } from './worktree-path';

/** The ref that keeps a copy's teardown commit reachable (see `copy-refs.ts`). */
export { teardownRef };

const teardownFoldKey = (batchId: BatchId): string => `copy-teardown:${batchId}`;

/** Read through a call so a stop that came during a run isn't narrowed away. */
const stopped = (signal: AbortSignal): boolean => signal.aborted;

/** The card for a teardown that did not succeed: what went wrong, and a Retry that runs `retireCopy` again. */
function teardownFailed(batch: BatchDto, what: string): Card {
  return {
    tier: CardTier.Ask,
    urgency: Urgency.Normal,
    closesWhen: BY_ANSWER,
    decision: decidedByBuilder(BuilderOwns.OutOfMoves),
    title: `The copy of "${batch.title}" was not cleaned up: its teardown did not finish`,
    body: `10db kept the copy's worktree until the command that drops the copy's databases succeeds. The command must be safe to run again.\n\n${what}`,
    foldKey: teardownFoldKey(batch.id),
    refresh: true,
    ...worktreeOffer({ kind: 'teardown', batchId: batch.id }, { batchId: batch.id }),
  };
}

/**
 * Retires a finished local copy: its pinned teardown command runs in a scratch worktree of the commit
 * it was pinned at (never in the copy), and only when it exits 0 do the copy's worktree, branch and
 * teardown ref go and the journal reach `retired`. A copy that never reached OPEN has no `teardown_sha`:
 * no lane ran, so no database exists and nothing is torn down. Any failure but a stop raises one card
 * with what went wrong and a Retry that calls `retireCopy` again, and the step stays `retiring`. Safe
 * to repeat; the command must be idempotent.
 */
export async function retireCopy(
  ctx: DeliveryContext,
  batchId: BatchId,
  signal: AbortSignal,
): Promise<'retired' | 'failed'> {
  if (signal.aborted) return 'failed';
  const batch = getBatch(ctx.state.db, batchId);
  try {
    return await retire(ctx, batch, signal);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    ctx.logger.warn({ batchId, err: why }, 'copy not retired');
    if (!stopped(signal)) raise(ctx.inbox, batch.projectId, teardownFailed(batch, why));
    return 'failed';
  }
}

async function retire(
  ctx: DeliveryContext,
  batch: BatchDto,
  signal: AbortSignal,
): Promise<'retired' | 'failed'> {
  const batchId = batch.id;
  const copy = getLocalCopy(ctx.state.db, batchId);
  if (copy !== null && copy.step !== CopyStep.Retired) {
    if (copy.step !== CopyStep.Retiring)
      ctx.state.write((w) => patchLocalCopy(w, batchId, { step: CopyStep.Retiring }));
    if (!(await tearDown(ctx, batch, copy, signal))) return 'failed';
  }
  const outcome = await retireWorktree(ctx, batchId);
  if (outcome.kind === 'kept' || outcome.kind === 'untrusted') return 'failed';
  await dropBranchAndRef(ctx, batchId);
  if (copy !== null) ctx.state.write((w) => patchLocalCopy(w, batchId, { step: CopyStep.Retired }));
  return 'retired';
}

/**
 * The teardown ref goes, and a landed copy's branch with it when it lies inside the base (a closed or
 * abandoned batch's branch is settled by `retireWorktree`). Both are dropped on a best effort: a
 * leftover is logged and the retirement still counts.
 */
export async function finishCopyRetirement(ctx: DeliveryContext, batchId: BatchId): Promise<void> {
  await dropBranchAndRef(ctx, batchId);
  ctx.state.write((w) => patchLocalCopy(w, batchId, { step: CopyStep.Retired }));
}

async function dropBranchAndRef(ctx: DeliveryContext, batchId: BatchId): Promise<void> {
  const batch = getBatch(ctx.state.db, batchId);
  const repo = getProject(ctx.state.db, batch.projectId).repoPath;
  try {
    await ctx.git.deleteKeptRef(repo, teardownRef(batchId));
    if (batch.state === BatchState.Shipped && batch.branch !== null) {
      const tip = await ctx.git.branchTip(repo, batch.branch);
      if (
        tip !== null &&
        (await ctx.git.branchInUse(repo, batch.branch)) === null &&
        (await ctx.git.isAncestor(repo, tip, `refs/heads/${batch.baseBranch}`))
      )
        await ctx.git.deleteBranchIfAt(repo, batch.branch, tip);
    }
  } catch (error) {
    ctx.logger.warn(
      { batchId, err: error instanceof Error ? error.message : String(error) },
      'copy branch or teardown ref not dropped',
    );
  }
}

/** Runs the pinned teardown; true when it exited 0 or there is nothing to run. Throws what stopped it. */
async function tearDown(
  ctx: DeliveryContext,
  batch: BatchDto,
  copy: LocalCopyDto,
  signal: AbortSignal,
): Promise<boolean> {
  if (copy.teardownSha === null || copy.teardownCommand.trim() === '') return true;
  const project = getProject(ctx.state.db, batch.projectId);
  const main = project.repoPath;
  const branch = `${SCRATCH_PREFIX}teardown-${batch.id.slice(-6)}`;
  const path = worktreePathFor(madeWorktreeRoot(ctx.worktreeRoot), project, branch);
  try {
    await removeScratch(ctx, main, branch, path);
    await ctx.git.addWorktree({
      repo: main,
      path,
      branch,
      startPoint: copy.teardownSha,
      lockReason: worktreeLockReason(batch.id),
    });
    const result = await ctx.copyTeardown.run({
      project: projectAtCheckout(project, path),
      batchId: batch.id,
      copyId: copy.copyId,
      command: copy.teardownCommand,
      signal,
    });
    if (result.aborted) return false;
    if (result.exitCode === 0 && !result.timedOut) {
      withdraw(ctx.state, ctx.inbox, batch.projectId, [teardownFoldKey(batch.id)]);
      return true;
    }
    raise(
      ctx.inbox,
      batch.projectId,
      teardownFailed(batch, `Log: ${result.logPath}\n\n${result.tail}`),
    );
    return false;
  } finally {
    await removeScratch(ctx, main, branch, path).catch((error: unknown) => {
      ctx.logger.warn(
        { batchId: batch.id, path, err: error instanceof Error ? error.message : String(error) },
        'copy teardown worktree not removed',
      );
    });
  }
}
