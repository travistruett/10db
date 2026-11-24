import { CopyStep, type BatchId, Urgency, type BatchDto, type LocalCopyDto } from '@10db/contracts';
import { getBatch, getLocalCopy, getProject, patchLocalCopy } from '@10db/db';
import { BY_ANSWER, CardTier } from '../inbox';
import { worktreeOffer, type Card } from './cards';
import { projectAtCheckout } from './checkout';
import { withdraw, raise, type DeliveryContext } from './context';
import { copyIdForBatch } from './copy-id';
import { teardownRef } from './copy-refs';
import { removeScratch, SCRATCH_PREFIX } from './scratch-gate';
import { retireWorktree } from './worktree-cleanup';
import { worktreeLockReason } from './worktree-cut';
import { madeWorktreeRoot, worktreePathFor } from './worktree-path';

/** The ref that keeps a copy's teardown commit reachable (see `copy-refs.ts`). */
export { teardownRef };

const teardownFoldKey = (batchId: BatchId): string => `copy-teardown:${batchId}`;

/** The card for a teardown that did not succeed: its log, and a Retry that runs `retireCopy` again. */
function teardownFailed(batch: BatchDto, logPath: string, tail: string): Card {
  return {
    tier: CardTier.Ask,
    urgency: Urgency.Normal,
    closesWhen: BY_ANSWER,
    title: `The copy of "${batch.title}" was not cleaned up: its teardown command failed`,
    body: `The command that drops the copy's databases did not finish cleanly, so 10db kept the copy's worktree. The command must be safe to run again.\n\nLog: ${logPath}\n\n${tail}`,
    foldKey: teardownFoldKey(batch.id),
    refresh: true,
    ...worktreeOffer({ kind: 'teardown', batchId: batch.id }, { batchId: batch.id }),
  };
}

/**
 * Retires a finished local copy: its pinned teardown command runs in a scratch worktree of the commit
 * it was pinned at (never in the copy), and only when it exits 0 do the copy's worktree, branch and
 * teardown ref go and the journal reach `retired`. A copy that never reached OPEN has no `teardown_sha`:
 * no lane ran, so no database exists and nothing is torn down. A failed teardown raises one card with
 * the log and a Retry, and the step stays `retiring`. Safe to repeat; the command must be idempotent.
 */
export async function retireCopy(
  ctx: DeliveryContext,
  batchId: BatchId,
  signal: AbortSignal,
): Promise<'retired' | 'failed'> {
  if (signal.aborted) return 'failed';
  const copy = getLocalCopy(ctx.state.db, batchId);
  if (copy !== null && copy.step !== CopyStep.Retired) {
    if (copy.step !== CopyStep.Retiring)
      ctx.state.write((w) => patchLocalCopy(w, batchId, { step: CopyStep.Retiring }));
    if (!(await tearDown(ctx, getBatch(ctx.state.db, batchId), copy, signal))) return 'failed';
  }
  try {
    const outcome = await retireWorktree(ctx, batchId);
    if (outcome.kind === 'kept' || outcome.kind === 'untrusted') return 'failed';
    const batch = getBatch(ctx.state.db, batchId);
    await ctx.git
      .deleteKeptRef(getProject(ctx.state.db, batch.projectId).repoPath, teardownRef(batchId))
      .catch((error: unknown) => {
        ctx.logger.warn(
          { batchId, err: error instanceof Error ? error.message : String(error) },
          'copy teardown ref not dropped',
        );
      });
  } catch (error) {
    ctx.logger.warn(
      { batchId, err: error instanceof Error ? error.message : String(error) },
      'copy worktree not removed',
    );
    return 'failed';
  }
  if (copy !== null) ctx.state.write((w) => patchLocalCopy(w, batchId, { step: CopyStep.Retired }));
  return 'retired';
}

/** Runs the pinned teardown; true when it exited 0 or there is nothing to run. */
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
  } catch (error) {
    ctx.logger.warn(
      { batchId: batch.id, err: error instanceof Error ? error.message : String(error) },
      'copy teardown worktree not made',
    );
    return false;
  }
  try {
    const result = await ctx.copyTeardown.run({
      project: projectAtCheckout(project, path),
      batchId: batch.id,
      copyId: copyIdForBatch(ctx.state.db, batch.id),
      command: copy.teardownCommand,
      signal,
    });
    if (result.aborted) return false;
    if (result.exitCode === 0 && !result.timedOut) {
      withdraw(ctx.state, ctx.inbox, batch.projectId, [teardownFoldKey(batch.id)]);
      return true;
    }
    raise(ctx.inbox, batch.projectId, teardownFailed(batch, result.logPath, result.tail));
    return false;
  } catch (error) {
    ctx.logger.warn(
      { batchId: batch.id, err: error instanceof Error ? error.message : String(error) },
      'copy teardown did not run',
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
