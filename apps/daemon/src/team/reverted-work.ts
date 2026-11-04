import {
  LEFT_OUT_NOTICE_KEY,
  REVERT_COMMIT_LINE,
  REVERTED_NOTICE_KEY,
  type Notice,
} from '@10db/contracts';

/**
 * What a run keeps once its batch shipped without it (Ship without it) and the builder retried it: its
 * commits are still reverted on the batch's branch, and nothing but a commit made after the revert
 * brings the work back. The notices carry the revert commit's id on a line of their own, and this
 * module is the one place that writes and reads it.
 */
const REVERT_LINE = REVERT_COMMIT_LINE;

/** The line a notice's body carries to name the revert commit. */
export function revertCommitLine(sha: string): string {
  return `${REVERT_LINE}${sha}`;
}

/** The full id of the revert commit a text names on its revert line; null when it names none. */
function revertCommitIn(text: string): string | null {
  const line = text.split('\n').find((l) => l.startsWith(REVERT_LINE));
  const sha = line?.slice(REVERT_LINE.length).trim() ?? '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** The full id of the revert commit a notice names; null when it names none. */
export function revertCommitOf(notice: Notice | null): string | null {
  return notice ? revertCommitIn(notice.body) : null;
}

/**
 * The revert commit the last retry of a run told its session about: the builder notes among the
 * run's evidence, oldest first. The notice shares one slot with the run's waits, so a wait for a claim
 * can replace it; the note is what the pull request relies on.
 */
export function lastRevertTold(
  evidence: readonly { readonly kind: string; readonly summary: string }[],
): string | null {
  let found: string | null = null;
  for (const row of evidence)
    if (row.kind === 'builder') found = revertCommitIn(row.summary) ?? found;
  return found;
}

/** When the last retry of a run told its session of a revert; null when none did. */
export function lastRevertNoteAt(
  evidence: readonly {
    readonly kind: string;
    readonly summary: string;
    readonly createdAt: string;
  }[],
): string | null {
  let found: string | null = null;
  for (const row of evidence)
    if (row.kind === 'builder' && revertCommitIn(row.summary) !== null) found = row.createdAt;
  return found;
}

/**
 * The latest revert a run's record names, and whether its session was ever told of one. A retry's note
 * is the record of a told run, and a run that was left out and never retried has only its notice, which
 * names the revert the same way; a task started over in the same batch finds that revert there.
 *
 * A `left-out` notice that names a revert is newer than any note: a retry swaps that notice for
 * `reverted-work` in the write that adds the note, so a run still holding it was left out after its last
 * note, and its commits made after that note are in this revert. The run still counts as told: a commit
 * it makes after this revert was made knowing the work had been undone before.
 */
export function revertOfRun(run: {
  readonly notice: Notice | null;
  readonly evidence: readonly { readonly kind: string; readonly summary: string }[];
}): { readonly revert: string; readonly told: boolean } | null {
  const noted = lastRevertTold(run.evidence);
  const leftOut = run.notice?.key === LEFT_OUT_NOTICE_KEY ? revertCommitOf(run.notice) : null;
  const carried = run.notice?.key === REVERTED_NOTICE_KEY ? revertCommitOf(run.notice) : null;
  const revert = leftOut ?? noted ?? carried;
  return revert === null ? null : { revert, told: noted !== null };
}

/** The notice a retried run keeps while its commits stay reverted. */
export function revertedWorkNotice(revert: string): Notice {
  return {
    key: REVERTED_NOTICE_KEY,
    tone: 'warning',
    line: 'Its earlier commits were reverted: only new commits are in the pull request',
    body: `You chose Ship without it for this run, so 10db reverted its commits on the batch's branch, then you retried it. The revert is still on the branch. The pull request has this task's work only if the run commits again, and 10db lists the task as not done there when it does not.\n\n${revertCommitLine(revert)}`,
  };
}

/** What the retried run's session is told, in the builder's note slot, so it knows its commits are gone. */
export function revertedWorkNote(revert: string): string {
  return [
    `Your earlier commits on this batch's branch were reverted: the builder chose Ship without it after this run failed, and 10db undid them in commit ${revert}. They are not in the branch's files now.`,
    `Redo the work and commit it with the commit tool; the reverted commits are still in the branch's history, so \`git show ${revert}\` lists them and you can read what they changed. A run that commits nothing new is left out of the pull request as not done.`,
    revertCommitLine(revert),
  ].join('\n\n');
}
