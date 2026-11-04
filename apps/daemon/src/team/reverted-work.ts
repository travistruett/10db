import {
  LEFT_OUT_NOTICE_KEY,
  REVERT_COMMIT_LINE,
  REVERTED_NOTICE_KEY,
  ToolAccess,
  type Notice,
  type WorkstreamStep,
} from '@10db/contracts';
import type { Git } from '../git';

/**
 * What a run keeps once its batch shipped without it (Ship without it) and the builder retried it: its
 * commits are still reverted on the batch's branch, and nothing but a commit made after the revert
 * brings the work back. The notices carry the revert commit's id on a line of their own, and this
 * module is the one place that writes and reads it.
 */
const REVERT_LINE = REVERT_COMMIT_LINE;

/**
 * The key a commit tool op's stored result carries when the commit changed a file that held conflict
 * markers at its parent: 10db commits a base merge with its markers for a session to resolve, so such a
 * commit is that resolution, whichever session made it. The session's answer does not carry the key.
 * Whether a run brought reverted work back reads it: a resolution brings none back.
 */
const RESOLVED_MARKERS_KEY = 'resolvedMarkers';

/**
 * The key a commit tool op's stored result carries when it made no new commit (the opId was already on
 * the branch) and the sha is one the run's revert covers: the session was handed a commit the revert
 * undid, so no work came back. A retry reads it, and it needs no git to do so.
 */
const COVERED_BY_REVERT_KEY = 'coveredByRevert';

/**
 * A commit tool op's result as it is stored, marked when the commit resolved conflict markers, and
 * when it made no new commit and `revert` (the one the run was told of; null when none) covers its sha.
 */
export async function commitResultAsStored<T extends { readonly sha: string }>(
  git: Pick<Git, 'conflictMarkers' | 'filesChangedBetween' | 'hasCommit' | 'isAncestor'>,
  repo: string,
  result: T & { readonly alreadyCommitted?: boolean },
  revert: string | null = null,
): Promise<
  T & { readonly [RESOLVED_MARKERS_KEY]?: true; readonly [COVERED_BY_REVERT_KEY]?: true }
> {
  const parent = `${result.sha}^`;
  const changed = await git.filesChangedBetween(repo, parent, result.sha);
  const marked = await git.conflictMarkers(repo, changed, parent);
  const resolved =
    marked.length > 0 ? { ...result, [RESOLVED_MARKERS_KEY]: true as const } : result;
  // A named revert no longer on the branch covers nothing, as `revertedAway` reads it.
  const covered =
    result.alreadyCommitted === true &&
    revert !== null &&
    (await git.hasCommit(repo, revert)) &&
    (await git.isAncestor(repo, result.sha, revert));
  return covered ? { ...resolved, [COVERED_BY_REVERT_KEY]: true } : resolved;
}

/** Whether a stored commit result resolved conflict markers (`commitResultAsStored`). */
export function commitResolvedMarkers(result: unknown): boolean {
  return storedMark(result, RESOLVED_MARKERS_KEY);
}

/** Whether a stored commit result made no new commit, and its sha is one the run's revert covers. */
export function commitCoveredByRevert(result: unknown): boolean {
  return storedMark(result, COVERED_BY_REVERT_KEY);
}

function storedMark(result: unknown, key: string): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as Record<string, unknown>)[key] === true
  );
}

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

/**
 * What a session is told, in the builder's note slot, so it knows the run's commits are gone. A step
 * that can commit is asked to redo the work; a read-only step can't, so it is told only what happened,
 * and the implement step gets the full note when the run enters it (`actionEntering`).
 */
export function revertedWorkNote(revert: string, step: Pick<WorkstreamStep, 'tools'>): string {
  const undone = `Your earlier commits on this batch's branch were reverted: the builder chose Ship without it after this run failed, and 10db undid them in commit ${revert}. They are not in the branch's files now.`;
  const next =
    step.tools === ToolAccess.ReadOnly
      ? `This work still has to be done again, and the step that can commit is told so when it runs. The reverted commits are still in the branch's history, so \`git show ${revert}\` lists them and you can read what they changed.`
      : `Redo the work and commit it with the commit tool; the reverted commits are still in the branch's history, so \`git show ${revert}\` lists them and you can read what they changed. A run that commits nothing new is left out of the pull request as not done.`;
  return [undone, next, revertCommitLine(revert)].join('\n\n');
}
