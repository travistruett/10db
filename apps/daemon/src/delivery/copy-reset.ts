import type { BatchId } from '@10db/contracts';
import { isLocalCopy, resetLocalCopy, type WriteContext } from '@10db/db';

/**
 * A batch leaving SHIPPING for FAILED or OPEN takes its separate copy's journal back to `open`; one that
 * is not a copy has none. The journal itself keeps a landing that may have written the builder's folder.
 */
export function resetCopyJournal(w: WriteContext, batchId: BatchId): void {
  if (isLocalCopy(w.tx, batchId)) resetLocalCopy(w, batchId);
}
