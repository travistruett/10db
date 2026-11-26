import { existsSync } from 'node:fs';
import {
  UNFINISHED_BATCH_STATES,
  type WatchpointHitsDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getBatch,
  getWorkstreamRow,
  listEvidence,
  type DbReader,
  type WorkstreamRow,
} from '@10db/db';
import { agentNotesOf, newestWatchpointRow, reviewerNotesOf, withNotes } from '../watchpoints';
import { checkoutOf } from './checkout';

/**
 * Whether the whole diff can still be read from a checkout, as `workstreamChanges` reads it: the run has a
 * base, its worktree has not been retired with its finished batch, and the checkout is still there.
 */
function diffStillReadable(db: DbReader, row: WorkstreamRow): boolean {
  if (row.baseHead === null) return false;
  if (row.batchId !== null) {
    const batch = getBatch(db, row.batchId);
    if (batch.worktreePath === null && !UNFINISHED_BATCH_STATES.includes(batch.state)) return false;
  }
  return existsSync(checkoutOf(db, row));
}

/**
 * The newest watchpoint reading of a run with the notes written about each file: the agent's reason from
 * its commits and the reviewer's check from its Review and QA steps. A run with no reading has no hits.
 */
export function watchpointHitsOf(db: DbReader, id: WorkstreamId): WatchpointHitsDto {
  const row = getWorkstreamRow(db, id);
  const canOpenDiff = diffStillReadable(db, row);
  const reading = newestWatchpointRow(listEvidence(db, id));
  if (reading === null) return { at: null, head: '', skipped: null, hits: [], canOpenDiff };
  return {
    at: reading.createdAt,
    head: reading.detail.head,
    skipped: reading.detail.skipped,
    hits: withNotes(reading.detail, {
      agent: agentNotesOf(db, id),
      reviewer: reviewerNotesOf(row.steps),
    }),
    canOpenDiff,
  };
}
