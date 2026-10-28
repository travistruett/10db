import type { BatchId } from '@10db/contracts';

/** The tail of each batch's worktree work: what the next caller waits for. */
const tails = new Map<BatchId, Promise<unknown>>();

/**
 * Runs `fn` once every earlier call for the same batch has settled, so a ship's repair, a queued
 * reopen, an abandon and a removal never act on one worktree at once, whichever queue they run in.
 * Not reentrant: `fn` must not take the lock for the same batch.
 */
export async function withWorktreeLock<T>(batchId: BatchId, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(batchId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  tails.set(batchId, tail);
  try {
    return await run;
  } finally {
    if (tails.get(batchId) === tail) tails.delete(batchId);
  }
}
