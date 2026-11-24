import type { BatchId, CopyId } from '@10db/contracts';
import { ZodError } from 'zod';
import { getLocalCopy, type DbReader } from '@10db/db';

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
 * The copy id every command of a batch runs with: the journal row's, from pinned facts only, never the
 * project's current delivery. A row whose id doesn't parse throws, so its command doesn't run without
 * the id. Null for a batch with no row (the row is written in the start's own transaction) and for a caller
 * with no batch. A batch's shape says nothing: a pull-request batch cut before `repo` was recorded
 * has a worktree and no repo too.
 */
export function copyIdForBatch(db: DbReader, batchId: BatchId | null): CopyId | null {
  if (batchId === null) return null;
  try {
    return getLocalCopy(db, batchId)?.copyId ?? null;
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    throw new CopyJournalMissingError(batchId, 'its copy id is unreadable');
  }
}
