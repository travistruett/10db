import { BatchState, type BatchDto } from '@10db/contracts';
import { findOpenByFoldKey, type WriteContext } from '@10db/db';
import { raiseIn, withdrawIn } from './context';
import { LEFT_OUT_KEPT_DETAIL, LeftOutKept, leftOutCards, leftOutFoldKey } from './cards';

/**
 * Brings the batch's open left-out card in line with the batch's state after it moved, inside the
 * caller's write. A left-out card is raised for the state the batch was in then and nothing updates
 * it, so each move that changes what the builder can do about it comes here:
 * - abandoned: nothing will ship and Ship without it is refused, so every left-out card goes;
 * - open or failed: a revert-kept card that waited on a ship (it offered no answer) now offers
 *   Ship without it, as one raised in that state does. Other cards already offer it.
 * A dismissed card stays dismissed.
 */
export function settleLeftOutCards(write: WriteContext, batch: BatchDto): void {
  if (batch.state === BatchState.Abandoned) {
    withdrawIn(write, batch.projectId, [leftOutFoldKey(batch.id)]);
    return;
  }
  if (batch.state !== BatchState.Open && batch.state !== BatchState.Failed) return;
  const open = findOpenByFoldKey(write.tx, batch.projectId, leftOutFoldKey(batch.id));
  if (open === undefined) return;
  // The detail is JSON read back from the database: a boundary, so parse it.
  const kept = LeftOutKept.safeParse(open.detail?.[LEFT_OUT_KEPT_DETAIL]);
  if (!kept.success) return;
  const { revert, why, ...attempt } = kept.data;
  raiseIn(
    write,
    batch.projectId,
    leftOutCards.revertKept(batch, attempt, revert, why, batch.state),
  );
}
