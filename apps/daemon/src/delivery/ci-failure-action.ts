import {
  CiStopped,
  UNFINISHED_BATCH_STATES,
  type BatchDto,
  type RequiredChecksDto,
} from '@10db/contracts';

/** The most CI fixes made for one pull request; the next failure stops instead. */
export const maxCiFixes = 2;

/** What to do about a pull request whose required checks fail. */
type CiFailureAction =
  | { readonly kind: 'wait' }
  | { readonly kind: 'fix' }
  | { readonly kind: 'stop'; readonly reason: CiStopped };

/**
 * Decides, from stored rows alone, what happens when the root batch's pull request is open with
 * failing required checks on `head`: `fixes` are the fix batches made for the root, in any state.
 * It is the one place that says when a fix starts.
 *
 * - Nothing to fix yet (the checks do not fail, or GitHub gave no head): wait.
 * - A stop the root already holds stays: a refused fix cut deleted the batch that guards the head.
 * - A fix still running: wait, whatever head it fixes.
 * - A finished fix for this head: it changed nothing or did not fix it, so stop.
 * - The limit of fixes: stop.
 * - No failing check is an Actions job: there is no log to read, so stop.
 */
export function ciFailureAction(
  root: BatchDto,
  required: RequiredChecksDto,
  fixes: readonly BatchDto[],
  head: string | null,
): CiFailureAction {
  if (required.state !== 'failing' || head === null) return { kind: 'wait' };
  if (root.ciStopped !== null) return { kind: 'stop', reason: root.ciStopped };
  if (fixes.some((fix) => UNFINISHED_BATCH_STATES.includes(fix.state))) return { kind: 'wait' };
  if (fixes.some((fix) => fix.ciFixHead === head))
    return { kind: 'stop', reason: CiStopped.NoChange };
  if (fixes.length >= maxCiFixes) return { kind: 'stop', reason: CiStopped.Limit };
  if (!required.failing.some((job) => job.jobId !== null))
    return { kind: 'stop', reason: CiStopped.NoLog };
  return { kind: 'fix' };
}
