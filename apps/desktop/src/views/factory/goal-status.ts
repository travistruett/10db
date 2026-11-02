import {
  GoalStatus,
  type GoalDigestDto,
  type GoalStatus as Status,
  type GoalSummaryDto,
  type UngroupedDigestDto,
} from '@10db/contracts';
import { GOAL_STATUS_LOOK } from '../board/goal-status';

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
  G.NotStarted,
];

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** The open cards on a goal's tasks. */
export function openCards(digest: GoalDigestDto): number {
  return digest.waitingOn.recent.length + digest.waitingOn.earlier.length;
}

/** "6 of 11 tasks done", the progress bar's label. */
export function progressLine(digest: GoalDigestDto): string {
  const { done, total } = digest.progress;
  return `${String(done)} of ${plural(total, 'task')} done`;
}

/** A goal's one-line verdict, as the collapsed row says it. */
export function verdictLine(digest: GoalDigestDto): string {
  const label = GOAL_STATUS_LOOK[digest.status].label;
  const total = digest.progress.total;
  switch (digest.status) {
    case G.Failed:
    case G.Running:
    case G.Paused:
    case G.Done:
      return `${label} · ${progressLine(digest)}`;
    case G.WaitingOnYou:
    case G.WaitingOnSomeone:
      return `${label} · ${plural(openCards(digest), 'card')} · ${progressLine(digest)}`;
    case G.Queued:
      return `${label} · ${progressLine(digest)} · waiting for a lane`;
    case G.Shipping:
      return `${label} · ${progressLine(digest)} · ${plural(digest.openPullRequests, 'pull request')} open`;
    case G.NotStarted:
      return `${label} · ${plural(total, 'task')} · Start Ready Tasks on the Board`;
  }
}

/** The Not in a goal row's line: "2 running · 1 failed", the statuses it holds. */
export function ungroupedLine(ungrouped: UngroupedDigestDto): string {
  const parts = [
    ungrouped.running > 0 ? `${String(ungrouped.running)} running` : null,
    ungrouped.failed > 0 ? `${String(ungrouped.failed)} failed` : null,
  ].filter((part) => part !== null);
  return parts.join(' · ');
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
