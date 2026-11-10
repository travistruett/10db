import {
  Delivery,
  PassNoticeKind,
  passHoldsTasks,
  PullRequestChecks,
  PullRequestState,
  type BatchDto,
  type PassId,
  type PullRequestStatusDto,
} from '@10db/contracts';
import {
  clearPassNotice,
  forgetPassPullRequest,
  getPass,
  getPassProgress,
  getProject,
  recordPullRequestStatus,
  setPassNotice,
  type DbReader,
  type WriteContext,
} from '@10db/db';

// Workbench spec §5.5, D19, D22: what the pull request watch does with a pass's pull request while
// the pass holds its tasks, and always on a `local` project, where a fix would need a copy the
// project does not allow. It reads merged and closed only: failing checks are one header notice
// offered with Send to Agent, and no fix, catch-up, merge, rerun or card follows.

/** The header notice that names the failing checks of a pass's pull request. */
export const PASS_CHECKS_NOTICE = 'checks';
/** The header notice that says a pass's pull request closed without merging. */
export const PASS_PR_CLOSED_NOTICE = 'pr-closed';

/**
 * Whether the pass's own branch of the watch reads this batch's pull request: a pass's batch while
 * the pass holds its tasks, and on a `local` project always. After the close on a pull request
 * project the batch is shipped and the built watch applies.
 */
export function watchedAsPass(db: DbReader, batch: BatchDto): PassId | null {
  if (batch.passId == null) return null;
  const pass = getPass(db, batch.passId);
  if (passHoldsTasks(pass.state)) return pass.id;
  return getProject(db, batch.projectId).delivery === Delivery.PullRequest ? null : pass.id;
}

/**
 * Stores what the watch read of a pass's pull request, in the caller's write. One closed unmerged
 * while the pass is open is forgotten, so Open Pull Request opens another; after the close it is
 * kept, as the record of a `local` project's pass. Either way the header says so.
 */
export function recordPassPullRequest(
  write: WriteContext,
  batch: BatchDto,
  passId: PassId,
  next: PullRequestStatusDto,
): void {
  const pass = getPass(write.tx, passId);
  const url = batch.prUrl ?? '';
  if (next.state === PullRequestState.Closed) {
    const open = passHoldsTasks(pass.state);
    if (open) forgetPassPullRequest(write, passId);
    else recordPullRequestStatus(write, batch.id, next);
    clearPassNotice(write, passId, PASS_CHECKS_NOTICE);
    setPassNotice(write, passId, {
      id: PASS_PR_CLOSED_NOTICE,
      kind: PassNoticeKind.PrClosed,
      text: open
        ? `The pull request ${url} closed without merging. Open Pull Request opens another.`
        : `The pull request ${url} closed without merging.`,
      sendable: false,
      cardId: null,
      at: write.now,
    });
    return;
  }
  recordPullRequestStatus(write, batch.id, next);
  if (next.state === PullRequestState.Open && next.checks === PullRequestChecks.Failing) {
    const names = next.failingChecks.map((c) => c.name);
    const text = `The pull request's checks fail: ${names.length > 0 ? names.join(', ') : 'a required check'}.`;
    const shown = getPassProgress(write.tx, passId).notices.find(
      (n) => n.id === PASS_CHECKS_NOTICE,
    );
    // The same checks failing again say nothing new.
    if (shown?.text === text) return;
    setPassNotice(write, passId, {
      id: PASS_CHECKS_NOTICE,
      kind: PassNoticeKind.Checks,
      text,
      sendable: true,
      cardId: null,
      at: write.now,
    });
    return;
  }
  // Right after a push GitHub can list no checks until the new runs appear: only a pass or a merge
  // says the failing checks are gone.
  if (next.checks === PullRequestChecks.Passing || next.state === PullRequestState.Merged)
    clearPassNotice(write, passId, PASS_CHECKS_NOTICE);
}
