import { BatchState, type BatchId, type CopyId } from '@10db/contracts';
import { getBatch, getLocalCopy, isLocalCopy, type DbReader } from '@10db/db';

export class CopyJournalMissingError extends Error {
  override readonly name = 'CopyJournalMissingError';
  readonly batchId: BatchId;
  constructor(batchId: BatchId, detail: string) {
    super(
      `The separate copy of batch ${batchId} has no usable journal (${detail}), so nothing runs in it.`,
    );
    this.batchId = batchId;
  }
}

/**
 * The copy id every command of a batch runs with, from pinned facts only: the journal row when the
 * batch has one, never the project's current delivery. A batch that was cut as a copy (a worktree, no
 * pull-request repo, past CUTTING) with no readable row throws, so its command doesn't run without
 * the id. Null for every other batch and for a caller with none.
 */
export function copyIdForBatch(db: DbReader, batchId: BatchId | null): CopyId | null {
  if (batchId === null) return null;
  if (isLocalCopy(db, batchId)) {
    try {
      const copy = getLocalCopy(db, batchId);
      if (copy !== null) return copy.copyId;
    } catch {
      throw new CopyJournalMissingError(batchId, 'its copy id is unreadable');
    }
  }
  const batch = getBatch(db, batchId);
  if (batch.worktreePath !== null && batch.repo === null && batch.state !== BatchState.Cutting)
    throw new CopyJournalMissingError(batchId, 'its journal row is missing');
  return null;
}
