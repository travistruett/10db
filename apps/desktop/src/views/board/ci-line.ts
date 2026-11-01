import {
  BatchState,
  PullRequestMergeBlocked,
  PullRequestState,
  RequiredChecksState,
  type BatchDto,
  type RequiredCheckJobDto,
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
  readonly link: CiLink;
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
  BatchState.Failed,
  BatchState.Shipping,
]);

function jobLink(jobs: readonly RequiredCheckJobDto[], prUrl: string): CiLink {
  const url = jobs.map((j) => githubUrl(j.link)).find((u) => u !== null);
  return url ? { url, label: 'CI job' } : { url: `${prUrl}/checks`, label: 'CI checks' };
}

/**
 * What the pull request's required checks say of a batch's tasks, or null when today's line stands:
 * no required checks, a pull request that is closed or unreadable, or a batch that has not shipped.
 * A CI fix batch shares its root's pull request, and the required checks are stored on the root
 * only, so `batches` is searched for the root and for the fixes made for it.
 */
export function ciLine(batch: BatchDto | undefined, batches: readonly BatchDto[]): CiLine | null {
  if (batch?.state !== BatchState.Shipped || !batch.prUrl) return null;
  const root =
    batch.ciFixOf === null ? batch : (batches.find((b) => b.id === batch.ciFixOf) ?? batch);
  const required = root.prRequired;
  if (required === null || required.state === RequiredChecksState.None) return null;
  const checks: CiLink = { url: `${batch.prUrl}/checks`, label: 'CI checks' };
  if (batch.pr?.state === PullRequestState.Merged)
    return { line: 'Merged · CI passed', color: 'green', link: checks };
  if (batch.pr?.state !== PullRequestState.Open) return null;
  const base = batch.baseBranch;
  if (root.prMergeBlocked !== null) {
    const how =
      root.prMergeBlocked === PullRequestMergeBlocked.Conflicts ? 'conflicts with' : 'behind';
    return {
      line: `Pull request open · ${how} ${base}`,
      color: 'red',
      link: { url: githubUrl(batch.prUrl) ?? batch.prUrl, label: 'Pull request' },
    };
  }
  switch (required.state) {
    case RequiredChecksState.Pending:
      return {
        line: 'Pull request open · CI running',
        color: 'blue',
        link: jobLink(required.pending, batch.prUrl),
      };
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
