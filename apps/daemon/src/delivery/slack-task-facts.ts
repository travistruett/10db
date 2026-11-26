import {
  Delivery,
  EvidenceKind,
  ExternalKind,
  PullRequestState,
  reviewRounds,
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
  /** How many runs the task took. */
  readonly runs: number;
  /** True when the finishing run's reviewers each approved in their latest round; false with no review. */
  readonly reviewApproved: boolean;
  /** The finishing run's checks (the project's gate); null when none ran. */
  readonly checks: 'passed' | 'failed' | null;
  /** The short id of the finishing run's last commit, for a task committed straight to a branch. */
  readonly commit: string | null;
}

const SHA = /^[0-9a-f]{7,40}$/;

/** The task's Linear issue, when it was made from one. */
export function postLinkOf(task: TaskDto): PostLink | null {
  const external = task.external;
  // Linear is the only tracker a task links today; another kind is left out, not mislabeled.
  return external?.kind === ExternalKind.Linear ? { id: external.id, url: external.url } : null;
}

/** True when each review role's newest round approved; false with no review at all. */
function approved(run: WorkstreamDto): boolean {
  const newestByStep = new Map<number, string | null>();
  // Newest first, so the first round of a step is its latest.
  for (const round of reviewRounds(run.steps))
    if (!newestByStep.has(round.stepIndex)) newestByStep.set(round.stepIndex, round.result.verdict);
  return newestByStep.size > 0 && [...newestByStep.values()].every((v) => v === Verdict.Approve);
}

/** Reads what a post about the finished task says: its issue, where it landed, its runs, review, checks and commit. */
export function taskPostFacts(db: DbReader, project: ProjectDto, task: TaskDto): TaskPostFacts {
  const runs = listWorkstreams(db, { projectId: task.projectId }).filter(
    (w) => w.taskId === task.id,
  );
  const last = runs.findLast((w) => w.state === WorkstreamState.Done) ?? runs.at(-1);
  const link = postLinkOf(task);
  if (last === undefined)
    return { link, landing: null, runs: 0, reviewApproved: false, checks: null, commit: null };

  // The task's pull request is the newest batch of its runs that has one.
  let pr: { url: string; merged: boolean } | null = null;
  for (const run of runs) {
    if (run.batchId === null) continue;
    const batch = getBatch(db, run.batchId);
    if (batch.prUrl !== null)
      pr = { url: batch.prUrl, merged: batch.pr?.state === PullRequestState.Merged };
  }
  const batch = last.batchId === null ? null : getBatch(db, last.batchId);
  const local = project.delivery === Delivery.Local;
  // A local copy lands on its batch's base; a run in Your folder commits on the branch pinned at its start.
  const branch = local ? (batch?.baseBranch ?? getWorkstreamRow(db, last.id).branch ?? null) : null;
  const landing: TaskPostLanding | null =
    pr !== null
      ? { kind: 'pull_request', ...pr }
      : branch !== null
        ? { kind: 'branch', branch }
        : null;

  const gate = newestEvidenceOfKind(db, last.id, EvidenceKind.Gate);
  const gateExit = gate?.exitCode ?? batch?.gateExitCode ?? null;
  const sha = local && pr === null ? listWorkstreamCommitShas(db, last.id).at(-1) : undefined;
  return {
    link,
    landing,
    runs: runs.length,
    reviewApproved: approved(last),
    checks: gateExit === null ? null : gateExit === 0 ? 'passed' : 'failed',
    commit: sha !== undefined && SHA.test(sha) ? sha.slice(0, 7) : null,
  };
}
