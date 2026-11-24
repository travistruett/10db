import type { BatchId } from '@10db/contracts';
import { CopyStep } from '@10db/contracts';
import { patchLocalCopy } from '@10db/db';
import type { DeliveryContext } from './context';
import { retireWorktree } from './worktree-cleanup';

// TODO(local-copy): card 6 replaces this with the pinned teardown run from `teardown_sha`, and the
// worktree, branch and teardown ref going only after it succeeds.
export async function retireCopy(
  ctx: DeliveryContext,
  batchId: BatchId,
  signal: AbortSignal,
): Promise<'retired' | 'failed'> {
  if (signal.aborted) return 'failed';
  try {
    await retireWorktree(ctx, batchId);
  } catch (error) {
    ctx.logger.warn(
      { batchId, err: error instanceof Error ? error.message : String(error) },
      'copy worktree not removed',
    );
    return 'failed';
  }
  ctx.state.write((w) => patchLocalCopy(w, batchId, { step: CopyStep.Retired }));
  return 'retired';
}
