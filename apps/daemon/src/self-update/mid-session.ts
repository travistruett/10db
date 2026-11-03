import { countMidSession, type DbReader } from '@10db/db';

/**
 * What a restart would cut off, as a count: the lanes, gates and batches in the database
 * (`countMidSession`), and the delivery jobs queued or running. A queued ship, checkout return or
 * cleanup is a job before it is any row, so the database alone says nothing of it.
 */
export function midSessionWork(db: DbReader, jobs: { pending(): number }): number {
  return countMidSession(db) + jobs.pending();
}
