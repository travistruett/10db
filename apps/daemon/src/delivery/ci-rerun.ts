import type { RequiredCheckJobDto } from '@10db/contracts';
import { FailedRerunOutcome, type FailedRerunRecord } from './notices';

/**
 * How long a head's runs get to start after a push or a rerun. GitHub lists the old jobs of a run
 * for a while after its rerun, and a workflow starts within seconds, so this leaves room for a busy
 * queue before 10db takes a rerun for one that never took.
 */
export const CHECKS_START_MS = 10 * 60_000;

/** What the watch does about a head's failing `Change` checks before it fixes them or raises the card. */
export type CiRerunStep =
  /** Nothing to rerun or wait on: the failure goes on as it would with no rerun. */
  | { readonly kind: 'none' }
  /** Run these Actions runs' failed jobs again, once for the head. */
  | { readonly kind: 'rerun'; readonly runs: readonly string[] }
  /** These checks wait on a run: no fix starts and the card leaves them out. */
  | { readonly kind: 'hold'; readonly names: readonly string[] }
  /** A rerun check failed again: the failure is the change's. */
  | { readonly kind: 'failedAgain' }
  /** The rerun checks passed (not cancelled, not unlisted): they flaked on the head. */
  | { readonly kind: 'flaked'; readonly names: readonly string[] };

/**
 * Decides, for one head of an open pull request, whether its failing required checks are run again
 * once before a fix or the card. `record`: the head's stored rerun, if any. `change`: the failing
 * checks the base passes that are Actions jobs. A head is rerun at most once: any record but one
 * still settling says to go on as today.
 *
 * - No record: nothing of the change fails, nothing; a job of the same run still going, hold (GitHub
 *   refuses to rerun a run in progress); else rerun each run.
 * - A rerun check fails with a job id the rerun did not see: it failed again.
 * - A rerun check is pending: hold.
 * - Only the old jobs fail: hold for `CHECKS_START_MS` after the rerun, then it failed again (the
 *   rerun never took).
 * - A rerun check is cancelled: hold. It never passed, and the cancelled-check flows run it again or
 *   raise their own card.
 * - GitHub lists no checks (`listed` false, as it may right after a rerun): hold for
 *   `CHECKS_START_MS`, then nothing, with the record kept for the read that lists them.
 * - The checks are listed and no rerun check fails, runs or is cancelled: it passed, so it flaked.
 */
export function ciRerunStep(input: {
  readonly record: FailedRerunRecord | null;
  readonly change: readonly RequiredCheckJobDto[];
  readonly failing: readonly RequiredCheckJobDto[];
  readonly pending: readonly RequiredCheckJobDto[];
  readonly cancelled: readonly RequiredCheckJobDto[];
  /** Whether GitHub listed any required check for the head. */
  readonly listed: boolean;
  readonly now: number;
}): CiRerunStep {
  const { record, change, failing, pending, cancelled, listed, now } = input;
  if (record === null) {
    if (change.length === 0) return { kind: 'none' };
    const runs = [...new Set(change.flatMap((job) => (job.runId === null ? [] : [job.runId])))];
    if (pending.some((job) => job.runId !== null && runs.includes(job.runId)))
      return { kind: 'hold', names: [...new Set(change.map((job) => job.name))] };
    return { kind: 'rerun', runs };
  }
  if (record.outcome !== FailedRerunOutcome.Rerun) return { kind: 'none' };
  const named = (job: RequiredCheckJobDto): boolean => record.names.includes(job.name);
  const failed = failing.filter(named);
  if (failed.some((job) => job.jobId !== null && !record.jobs.includes(job.jobId)))
    return { kind: 'failedAgain' };
  if (pending.some(named) || cancelled.some(named)) return { kind: 'hold', names: record.names };
  const starting = now - record.at < CHECKS_START_MS;
  if (failed.length > 0)
    return starting ? { kind: 'hold', names: record.names } : { kind: 'failedAgain' };
  if (!listed) return starting ? { kind: 'hold', names: record.names } : { kind: 'none' };
  return { kind: 'flaked', names: record.names };
}
