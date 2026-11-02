import { BatchId, type InboxAnswer, type InboxItemDto } from '@10db/contracts';
import { getBatch } from '@10db/db';
import { z } from 'zod';
import { deleteAskedBranch } from './branch-cleanup';
import { BRANCH_CARD_DETAIL, BranchChoice } from './cards';
import type { DeliveryContext } from './context';
import { jobKey, JobQueue } from './jobs';

const BranchCardDetail = z.object({ batchId: BatchId });

/**
 * Acts on a branch card's answer before the inbox records it. Delete Branch queues the deletion in
 * the project's ship queue, behind any worktree removal, and the card closes at once: a branch git
 * won't delete raises a new card saying why. Keep, or any other label, changes nothing.
 */
export function createBranchCardAnswers(
  ctx: DeliveryContext,
): (item: InboxItemDto, answer: InboxAnswer) => void {
  return (item, answer) => {
    // The detail is JSON read back from the database: a boundary, so parse it.
    const card = BranchCardDetail.safeParse(item.detail?.[BRANCH_CARD_DETAIL]);
    if (!card.success || answer.choice !== BranchChoice.Delete) return;
    const batchId = card.data.batchId;
    const batch = getBatch(ctx.state.db, batchId);
    ctx.jobs.run(jobKey(batch, JobQueue.Ship), () => deleteAskedBranch(ctx, batchId));
  };
}
