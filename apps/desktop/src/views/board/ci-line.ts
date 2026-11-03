import {
  BatchState,
  PullRequestMergeBlocked,
  PullRequestState,
  RequiredChecksState,
  type BatchDto,
  type BatchId,
  type RequiredCheckJobDto,
  type WorkstreamDto,
} from '@10db/contracts';
import type { MantineColor } from '@mantine/core';

/** Where a CI line sends the builder: a job's page, else the pull request's checks. */
export interface CiLink {
  readonly url: string;
  readonly label: string;
}

/** The pull request line of a pull request that has required checks (CI-decides spec §5). */
export interface CiLine {
  readonly line: string;
  readonly color: MantineColor;
  /** Null when the pull request is not an https github.com address, which the app never links. */
  readonly link: CiLink | null;
}

const OPEN_PREFIX = 'Pull request open · ';

/**
 * A CI line as the drawer's status line says it, after the state it follows: "CI running" for "Pull
 * request open · CI running". The status line already says where the task stands and carries the
 * pull request link, so the pull request needs no second mention.
 */
export function ciStatus(line: string): string {
  return line.startsWith(OPEN_PREFIX) ? line.slice(OPEN_PREFIX.length) : line;
}

/** An https github.com address, the only kind the app opens; null for anything else. */
function githubUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' ? url : null;
  } catch {
    return null;
  }
}

/** The batch states in which a CI fix is still being made. */
const FIX_RUNNING: ReadonlySet<BatchState> = new Set([
  BatchState.Cutting,
  BatchState.Open,
  BatchState.Shipping,
]);

/**
 * The batches with each CI fix batch titled by its fix task, as the line names it (CI-decides spec
 * §5). A fix batch starts with its task's title, but the task can be renamed; the workstream's
 * `taskTitle` is the task's current one. A person can add a task to a fix batch that failed to ship,
 * so the batch can have several workstreams; the CI fix task is the one the watch made, which is the
 * batch's oldest workstream (the first listed when two share a `createdAt`). A fix batch with no
 * workstream keeps its own title. Give `ciLine` the result, so its "fixing in" names the task.
 */
export function withFixTaskTitles(
  batches: readonly BatchDto[],
  workstreams: readonly WorkstreamDto[],
): BatchDto[] {
  const oldest = new Map<BatchId, WorkstreamDto>();
  for (const ws of workstreams) {
    if (ws.batchId === null) continue;
    const seen = oldest.get(ws.batchId);
    if (seen === undefined || ws.createdAt < seen.createdAt) oldest.set(ws.batchId, ws);
  }
  return batches.map((b) => {
    const title = b.ciFixOf === null ? undefined : oldest.get(b.id)?.taskTitle;
    return title === undefined ? b : { ...b, title };
  });
}

/** The pull request's checks page, or null unless the pull request is an https github.com address. */
function checksLink(prUrl: string): CiLink | null {
  const url = githubUrl(prUrl);
  return url === null ? null : { url: `${url}/checks`, label: 'CI checks' };
}

function jobLink(jobs: readonly RequiredCheckJobDto[], prUrl: string): CiLink | null {
  const url = jobs.map((j) => githubUrl(j.link)).find((u) => u !== null);
  return url ? { url, label: 'CI job' } : checksLink(prUrl);
}

/**
 * Whether the required checks of a shipped pull request passed or failed, for the card's indicator;
 * null while they run, when a conflict or the merge queue is what the pull request waits on, or when
 * the pull request has no required checks. It reads the same data as `ciLine`.
 */
export function ciResult(
  batch: BatchDto | undefined,
  batches: readonly BatchDto[],
): 'passed' | 'failed' | null {
  const line = ciLine(batch, batches);
  if (line === null || batch === undefined) return null;
  if (line.color === 'green') return 'passed';
  if (line.color !== 'red') return null;
  const root =
    batch.ciFixOf === null ? batch : (batches.find((b) => b.id === batch.ciFixOf) ?? batch);
  // Red is also a conflict or a base that moved on, which is no CI result.
  return root.prMergeBlocked === null && root.prRequired?.state === RequiredChecksState.Failing
    ? 'failed'
    : null;
}

/**
 * What the pull request's required checks say of a batch's tasks, or null when today's line stands:
 * no required checks, a pull request that is closed or unreadable, or a batch that has not shipped.
 * A CI fix batch shares its root's pull request, and the required checks are stored on the root
 * only, so `batches` is searched for the root and for the fixes made for it. "Fixing in" names the
 * fix batch's title, which is the fix task's when `batches` went through `withFixTaskTitles`.
 */
export function ciLine(batch: BatchDto | undefined, batches: readonly BatchDto[]): CiLine | null {
  if (batch?.state !== BatchState.Shipped || !batch.prUrl) return null;
  const root =
    batch.ciFixOf === null ? batch : (batches.find((b) => b.id === batch.ciFixOf) ?? batch);
  const required = root.prRequired;
  const checks = checksLink(batch.prUrl);
  // In the merge queue the pull request waits its turn, whatever its checks say: the queue's own
  // group run is what is left, and 10db pushes nothing meanwhile. Open only: a merged pull request
  // has left the queue, and the watch clears the mark on the next read.
  if (
    batch.pr?.state === PullRequestState.Open &&
    root.prMergeBlocked === PullRequestMergeBlocked.Queued
  )
    return {
      line: 'Pull request open · queued to merge',
      color: 'blue',
      link: githubUrl(batch.prUrl) ? { url: batch.prUrl, label: 'Pull request' } : null,
    };
  if (required === null || required.state === RequiredChecksState.None) return null;
  if (batch.pr?.state === PullRequestState.Merged)
    return { line: 'Merged · CI passed', color: 'green', link: checks };
  if (batch.pr?.state !== PullRequestState.Open) return null;
  const base = batch.baseBranch;
  if (root.prMergeBlocked !== null) {
    const how =
      root.prMergeBlocked === PullRequestMergeBlocked.Conflicts ? 'conflicts with' : 'behind';
    // `queued` returned above, so what is left here is a conflict or a base that moved on.
    return {
      line: `Pull request open · ${how} ${base}`,
      color: 'red',
      link: githubUrl(batch.prUrl) ? { url: batch.prUrl, label: 'Pull request' } : null,
    };
  }
  switch (required.state) {
    case RequiredChecksState.Pending:
      return {
        line: 'Pull request open · CI running',
        color: 'blue',
        link: jobLink(required.pending, batch.prUrl),
      };
    case RequiredChecksState.Cancelled: {
      const named = required.cancelled[0] ? `: ${required.cancelled[0].name}` : '';
      return {
        line: `Pull request open · CI cancelled${named}`,
        color: 'orange',
        link: jobLink(required.cancelled, batch.prUrl),
      };
    }
    case RequiredChecksState.Passing:
      return { line: 'Pull request open · CI passed', color: 'green', link: checks };
    case RequiredChecksState.Failing: {
      const failed = required.failing[0];
      const named = failed ? `: ${failed.name}` : '';
      const fixes = batches.filter((b) => b.ciFixOf === root.id);
      const running = fixes.find((b) => FIX_RUNNING.has(b.state));
      let tail = '';
      if (running) tail = ` · fixing in "${running.title}"`;
      else if (root.ciStopped !== null)
        tail = ` · stopped after ${String(fixes.length)} ${fixes.length === 1 ? 'fix' : 'fixes'}`;
      return {
        line: `Pull request open · CI failed${named}${tail}`,
        color: 'red',
        link: jobLink(required.failing, batch.prUrl),
      };
    }
  }
}
