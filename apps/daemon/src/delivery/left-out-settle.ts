import { BatchState, type BatchDto, type WorkstreamDto, type WorkstreamId } from '@10db/contracts';
import { findOpenByFoldKey, type DbReader, type WriteContext } from '@10db/db';
import { BATCH_CARD_DETAIL, BatchCardDetail } from './batch-card';
import { raiseIn, withdrawIn } from './context';
import { LEFT_OUT_KEPT_DETAIL, LeftOutKept, leftOutCards, leftOutFoldKey } from './cards';

/**
 * The revert commit a stopped Ship without it left on the batch's branch without writing its notices:
 * the batch's open left-out card holds it, because the write that would have recorded it failed. The
 * answered run and the tasks whose commits it covers come with it. Null when no such card is open,
 * or when it names no revert (a card of a stop before any revert).
 */
export function keptRevertOf(
  db: DbReader,
  batch: Pick<BatchDto, 'id' | 'projectId'>,
): KeptRevert | null {
  const open = findOpenByFoldKey(db, batch.projectId, leftOutFoldKey(batch.id));
  if (open === undefined) return null;
  // The detail is JSON read back from the database: a boundary, so parse it.
  const card = BatchCardDetail.safeParse(open.detail?.[BATCH_CARD_DETAIL]);
  if (card.success && card.data.revert !== undefined)
    return {
      revert: card.data.revert,
      workstreamId: card.data.workstreamId,
      titles: card.data.titles ?? [],
    };
  const kept = LeftOutKept.safeParse(open.detail?.[LEFT_OUT_KEPT_DETAIL]);
  return kept.success
    ? { revert: kept.data.revert, workstreamId: kept.data.workstreamId, titles: kept.data.titles }
    : null;
}

/** What `keptRevertOf` finds. */
export interface KeptRevert {
  readonly revert: string;
  /** The run the stopped answer was given on. */
  readonly workstreamId: WorkstreamId;
  /** The tasks whose commits the revert covers. */
  readonly titles: readonly string[];
}

/** Whether the revert covers the commits of `run`: the run answered on, or one of the tasks it names. */
export function coversRun(kept: KeptRevert, run: Pick<WorkstreamDto, 'id' | 'taskTitle'>): boolean {
  return kept.workstreamId === run.id || kept.titles.includes(run.taskTitle);
}

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
