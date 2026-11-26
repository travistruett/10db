import {
  Delivery,
  EvidenceKind,
  ExternalKind,
  PullRequestState,
  reviewRounds,
  StepRole,
  Verdict,
  WorkstreamState,
  type ProjectDto,
  type TaskDto,
  type WorkstreamDto,
} from '@10db/contracts';
import {
  getBatch,
  getWorkstreamRow,
  listWorkstreamCommitShas,
  listWorkstreams,
  newestEvidenceOfKind,
  type DbReader,
} from '@10db/db';

/** The tracker issue a task was made from, as a post links it. */
export interface PostLink {
  /** The issue's readable key, such as `AMP-84`. */
  readonly id: string;
  readonly url: string;
}

/** Where a finished task's work went: a pull request, or a branch it was committed to. */
export type TaskPostLanding =
  | { readonly kind: 'pull_request'; readonly url: string; readonly merged: boolean }
  | { readonly kind: 'branch'; readonly branch: string };

/** What a Slack post says about a finished task beyond its name: only facts 10db already recorded. */
export interface TaskPostFacts {
  readonly link: PostLink | null;
  readonly landing: TaskPostLanding | null;
  /** How many runs of the task got as far as a session. */
  readonly runs: number;
  /** True when the finishing run's code review approved in its latest round; false with none. */
  readonly reviewApproved: boolean;
  /** The finishing run's checks (the project's gate); null when none ran. */
  readonly checks: 'passed' | 'failed' | null;
  /**
   * The short id of the finishing run's last commit, for a run that committed on the branch it landed on. A lane
   * run's commits land as another commit, which 10db does not keep, so it has none.
   */
  readonly commit: string | null;
}

const SHA = /^[0-9a-f]{7,40}$/;

/** The task's Linear issue, when it was made from one. */
export function postLinkOf(task: TaskDto): PostLink | null {
  const external = task.external;
  // Linear is the only tracker a task links today; another kind is left out, not mislabeled.
  return external?.kind === ExternalKind.Linear ? { id: external.id, url: external.url } : null;
}

/** No facts beyond the task's own link: what a post says when its facts could not be read. */
export const noFacts = (task: TaskDto): TaskPostFacts => ({
  link: postLinkOf(task),
  landing: null,
  runs: 0,
  reviewApproved: false,
  checks: null,
  commit: null,
});

/** True when each code review step's newest round approved; false with no code review. */
function approved(run: WorkstreamDto): boolean {
  const newestByStep = new Map<number, string | null>();
  // Newest first, so the first round of a step is its latest. Plan review and QA are not the code review.
  for (const round of reviewRounds(run.steps))
    if (round.role === StepRole.Review && !newestByStep.has(round.stepIndex))
      newestByStep.set(round.stepIndex, round.result.verdict);
  return newestByStep.size > 0 && [...newestByStep.values()].every((v) => v === Verdict.Approve);
}

/** Reads what a post about the finished task says: its issue, where it landed, its runs, review, checks and commit. */
export function taskPostFacts(db: DbReader, project: ProjectDto, task: TaskDto): TaskPostFacts {
  const runs = listWorkstreams(db, { taskId: task.id });
  const last = runs.findLast((w) => w.state === WorkstreamState.Done) ?? runs.at(-1);
  if (last === undefined) return noFacts(task);

  // Only the finishing run's batch speaks for where the work went: an earlier run's pull request is not this one's.
  const batch = last.batchId === null ? null : getBatch(db, last.batchId);
  const prState = batch?.pr?.state ?? null;
  const pr =
    batch?.prUrl == null || prState === PullRequestState.Closed
      ? null
      : { url: batch.prUrl, merged: prState === PullRequestState.Merged };
  const row = getWorkstreamRow(db, last.id);
  const commits = listWorkstreamCommitShas(db, last.id);
  // A local copy lands on its batch's base; a run in Your folder on the branch it pinned at its start. A run that
  // committed nothing landed nothing.
  const branch =
    project.delivery === Delivery.Local && batch?.prUrl == null && commits.length > 0
      ? (batch?.baseBranch ?? row.branch ?? null)
      : null;
  const landing: TaskPostLanding | null =
    pr !== null
      ? { kind: 'pull_request', ...pr }
      : branch !== null
        ? { kind: 'branch', branch }
        : null;

  const gate = newestEvidenceOfKind(db, last.id, EvidenceKind.Gate);
  const gateExit = gate?.exitCode ?? batch?.gateExitCode ?? null;
  const sha = branch !== null && row.laneBranch === null ? commits.at(-1) : undefined;
  return {
    link: postLinkOf(task),
    landing,
    runs: runs.filter((w) => w.sessionCount > 0).length,
    reviewApproved: approved(last),
    checks: gateExit === null ? null : gateExit === 0 ? 'passed' : 'failed',
    commit: sha !== undefined && SHA.test(sha) ? sha.slice(0, 7) : null,
  };
}
