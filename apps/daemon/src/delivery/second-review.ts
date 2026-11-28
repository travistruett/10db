import {
  ConflictError,
  isTerminal,
  latestPerTask,
  LEFT_OUT_NOTICE_KEY,
  WorkstreamFailure,
  WorkstreamState,
  type BatchId,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  deleteAppSetting,
  getAppSetting,
  getWorkstream,
  listWorkstreams,
  setAppSetting,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import type { StateStore } from '../events';
import type { Logger } from '../log';

// What reaches the builder spec §3, "Shipping work that failed review": a reviewer's rejection that used up its
// rounds is reviewed again, once the rest of the batch has settled and a later task may have fixed the finding.
// Ship Anyway is offered only when that second review rejects the work too.

const key = (id: WorkstreamId): string => `second_review.${id}`;

/** Whether 10db has already asked for the run's second review, which is the only one it ever asks for. */
export function secondReviewRequested(db: DbReader, id: WorkstreamId): boolean {
  return getAppSetting(db, key(id)) === true;
}

/** Records, in the write that sends the run back to its review, that the second review was asked for. */
function requestSecondReview(ctx: WriteContext, id: WorkstreamId): void {
  setAppSetting(ctx, key(id), true);
}

/** Forgets the record: the builder's own Retry starts the run's rounds over, so a later rejection is a first one. */
export function forgetSecondReview(ctx: WriteContext, id: WorkstreamId): void {
  deleteAppSetting(ctx, key(id));
}

/** Whether a run failed because a reviewer rejected its work with no round left. */
function rejectedByReview(run: Pick<WorkstreamDto, 'state' | 'failureKind'>): boolean {
  return (
    run.state === WorkstreamState.Failed && run.failureKind === WorkstreamFailure.RejectedAtLimit
  );
}

/**
 * Whether Ship Anyway may be offered for the run: work that did not fail review always may; work a reviewer
 * rejected only once the second review has run and rejected it again.
 */
export function shipAnywayOffered(
  run: Pick<WorkstreamDto, 'state' | 'failureKind'>,
  secondReviewDone: boolean,
): boolean {
  return !rejectedByReview(run) || secondReviewDone;
}

/**
 * The runs of the batch whose second review is due: rejected by a reviewer, not yet reviewed again, and every
 * other task of the batch has settled (done, failed or cancelled), so whatever a later task fixed is on the branch.
 */
export function secondReviewsDue<
  R extends Pick<WorkstreamDto, 'id' | 'taskId' | 'state' | 'failureKind'>,
>(runs: readonly R[], requested: (id: WorkstreamId) => boolean): R[] {
  const members = latestPerTask(runs);
  if (!members.every((m) => isTerminal(m.state))) return [];
  return members.filter((m) => rejectedByReview(m) && !requested(m.id));
}

/** The refusal of a Ship Anyway that would ship work whose second review has not rejected it yet. */
export function shipAnywayRefusal(
  db: DbReader,
  batchId: BatchId,
  title: string,
): ConflictError | null {
  // A run Ship without it reverted is not in the branch to ship, so there is nothing left to review.
  const waiting = latestPerTask(listWorkstreams(db, { batchId })).filter(
    (m) =>
      m.notice?.key !== LEFT_OUT_NOTICE_KEY &&
      !shipAnywayOffered(m, secondReviewRequested(db, m.id)),
  );
  if (waiting.length === 0) return null;
  return new ConflictError(
    `Batch "${title}": ${waiting.map((m) => m.taskTitle).join(', ')} failed review, and 10db reviews it again before Ship anyway is offered`,
  );
}

/**
 * Sends each due run back to its review, once. The record is written first, so a retry that is refused is not
 * tried again, and the builder's card keeps offering its other answers.
 */
export function runSecondReviews(
  deps: {
    readonly state: StateStore;
    readonly retryForReview: (id: WorkstreamId) => void;
    readonly log: Logger;
  },
  batchId: BatchId,
): void {
  const due = secondReviewsDue(listWorkstreams(deps.state.db, { batchId }), (id) =>
    secondReviewRequested(deps.state.db, id),
  );
  for (const run of due) {
    if (getWorkstream(deps.state.db, run.id).state !== WorkstreamState.Failed) continue;
    deps.state.write((ctx) => {
      requestSecondReview(ctx, run.id);
    });
    try {
      deps.retryForReview(run.id);
    } catch (error) {
      deps.log.warn({ err: error, workstreamId: run.id }, 'could not start the second review');
    }
  }
}
