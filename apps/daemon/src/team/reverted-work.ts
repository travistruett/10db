import { LEFT_OUT_NOTICE_KEY, REVERTED_NOTICE_KEY, type Notice } from '@10db/contracts';

/**
 * What a run keeps once its batch shipped without it (Ship without it) and the builder retried it: its
 * commits are still reverted on the batch's branch, and nothing but a commit made after the revert
 * brings the work back. The notices carry the revert commit's id on a line of their own, and this
 * module is the one place that writes and reads it.
 */
const REVERT_LINE = 'Revert commit: ';

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

/**
 * The revert a run's record names, and whether its session was told. A retry's note is the record of
 * a told run. A run that was left out and never retried has only its notice, which names the revert
 * the same way; a task started over in the same batch finds that revert there.
 */
export function revertOfRun(run: {
  readonly notice: Notice | null;
  readonly evidence: readonly { readonly kind: string; readonly summary: string }[];
}): { readonly revert: string; readonly told: boolean } | null {
  const noted = lastRevertTold(run.evidence);
  if (noted !== null) return { revert: noted, told: true };
  const key = run.notice?.key;
  const revert =
    key === LEFT_OUT_NOTICE_KEY || key === REVERTED_NOTICE_KEY ? revertCommitOf(run.notice) : null;
  return revert === null ? null : { revert, told: false };
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
