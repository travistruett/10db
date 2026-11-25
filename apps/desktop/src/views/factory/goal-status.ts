import {
  GoalStatus,
  type GoalDigestDto,
  type GoalStatus as Status,
  type GoalSummaryDto,
} from '@10db/contracts';
import { GOAL_STATUS_LOOK } from '../board/goal-status';
import { elapsedWords } from '../board/task-state';
import { joinNames } from '../inbox/route-line';

const G = GoalStatus;

/** The list's order (§8): the statuses that need the builder first, then what is moving, then what waits. */
const ORDER: readonly Status[] = [
  G.Failed,
  G.WaitingOnYou,
  G.WaitingOnSomeone,
  G.Paused,
  G.Running,
  G.Queued,
  G.Shipping,
  G.Idle,
  G.NotStarted,
];

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** The open cards on a goal's tasks. */
export function openCards(digest: GoalDigestDto): number {
  return digest.waitingOn.recent.length + digest.waitingOn.earlier.length;
}

/** "6 of 11 tasks merged · 2 in review", the progress bar's label. A task in review is not merged. */
export function progressLine(digest: GoalDigestDto): string {
  const { merged, inReview, total } = digest.progress;
  const line = `${String(merged)} of ${plural(total, 'task')} merged`;
  return inReview > 0 ? `${line} · ${String(inReview)} in review` : line;
}

/** Who a goal waiting on someone else waits on, by name, or the status's own label when no name is known. */
function waitingOn(digest: GoalDigestDto, label: string): string {
  const names = [...new Set(digest.waitingOnSomeone.flatMap((c) => c.names))];
  return names.length > 0 ? `Waiting on ${joinNames(names)}` : label;
}

/** The status a goal row shows: "Waiting on Mark Ellis", "Running", "Not started". */
export function goalStatusWord(digest: GoalDigestDto): string {
  const label = GOAL_STATUS_LOOK[digest.status].label;
  if (digest.status === G.WaitingOnSomeone) return waitingOn(digest, label);
  return label.charAt(0) + label.slice(1).toLowerCase();
}

/**
 * The mechanics behind a goal's status, one piece each, in the verdict's order: its progress, its open
 * cards or questions and how long they have waited, a lane it waits for, its open pull requests.
 */
export function goalDetails(digest: GoalDigestDto): string[] {
  switch (digest.status) {
    case G.Failed:
    case G.Idle:
    case G.Running:
    case G.Paused:
    case G.Done:
      return [progressLine(digest)];
    case G.WaitingOnYou:
      return [plural(openCards(digest), 'card'), progressLine(digest)];
    case G.WaitingOnSomeone: {
      const since = digest.waitingOnSomeone.map((c) => c.at).sort()[0];
      const questions = plural(digest.waitingOnSomeone.length, 'question');
      return [
        since === undefined ? questions : `${questions} · ${elapsedWords(since)}`,
        progressLine(digest),
      ];
    }
    case G.Queued:
      return [progressLine(digest), 'waiting for a lane'];
    case G.Shipping:
      return [progressLine(digest), `${plural(digest.openPullRequests, 'pull request')} open`];
    case G.NotStarted:
      return [plural(digest.progress.total, 'task')];
  }
}

/** A goal's one-line verdict: its status and every detail, as the row's accessible name says it. */
export function verdictLine(digest: GoalDigestDto): string {
  const label = GOAL_STATUS_LOOK[digest.status].label;
  const head = digest.status === G.WaitingOnSomeone ? waitingOn(digest, label) : label;
  return [head, ...goalDetails(digest)].join(' · ');
}

export interface GoalGroups {
  /** Goals that are not done, in status order; the most recently changed first within a status. */
  readonly open: readonly GoalSummaryDto[];
  readonly done: readonly GoalSummaryDto[];
}

/** Splits the list into the open goals, in the spec's order, and the done ones. */
export function groupGoals(goals: readonly GoalSummaryDto[]): GoalGroups {
  const byRecent = (a: GoalSummaryDto, b: GoalSummaryDto): number =>
    b.goal.updatedAt.localeCompare(a.goal.updatedAt);
  const rank = (g: GoalSummaryDto): number => ORDER.indexOf(g.digest.status);
  return {
    open: goals
      .filter((g) => g.digest.status !== G.Done)
      .sort((a, b) => rank(a) - rank(b) || byRecent(a, b)),
    done: goals.filter((g) => g.digest.status === G.Done).sort(byRecent),
  };
}
