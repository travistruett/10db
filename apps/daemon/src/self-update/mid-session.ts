import { countMidSession, type DbReader } from '@10db/db';

/**
 * What a restart would cut off, as a count: the lanes, gates and batches in the database
 * (`countMidSession`), the delivery jobs queued or running, and the shaping conversations with a
 * turn under way. A queued ship, checkout return or cleanup is a job before it is any row, so the
 * database alone says nothing of it; a shape session is no workstream, and a quit mid-turn would
 * cut off the answer the builder is waiting on.
 *
 * A lane waiting on a card with a live session counts, unless `waitingOnCard` is false: it runs
 * nothing, and recovery parks it on its card again after a restart. A drain leaves it out, so one
 * unanswered card does not hold the install and every lane behind it until the builder answers.
 */
export function midSessionWork(
  db: DbReader,
  jobs: { pending(): number },
  shapes: { turnsInProgress(): number },
  opts: { readonly waitingOnCard?: boolean } = {},
): number {
  return countMidSession(db, opts) + jobs.pending() + shapes.turnsInProgress();
}
