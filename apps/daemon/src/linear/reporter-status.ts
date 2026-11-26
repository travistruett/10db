import {
  LinearEventKind,
  LinearPostState,
  LinearStatusType,
  ToolCallStatus,
  type LinearPostDto,
  type LinearTeamStatus,
  type ToolCallView,
} from '@10db/contracts';
import { z } from 'zod';
import { linearCalls } from './reporter-reach';

// Which Linear status an update moves its issue to, picked from the team's own statuses by type and
// position, with the name only breaking a tie. Pure: it reads nothing, and it is the one place the
// default moves are decided: `report_linear_post` answers the reporter the move it picks, and the reporter's
// guard lets only that status be set.

type TeamStatus = LinearTeamStatus;

/** What a default move aims at, before the team's statuses say which status that is. */
export const StatusAim = {
  /** The team's first started-type status. */
  FirstStarted: 'first_started',
  /** A started-type status after the first one, one a review sits in. */
  ReviewLike: 'review_like',
} as const;
export type StatusAim = (typeof StatusAim)[keyof typeof StatusAim];

/** The aim an event has by default, or null when the event moves no status. */
export function statusAimOf(event: LinearEventKind): StatusAim | null {
  switch (event) {
    case LinearEventKind.RunStarted:
      return StatusAim.FirstStarted;
    case LinearEventKind.PrOpened:
    case LinearEventKind.Landed:
      return StatusAim.ReviewLike;
    case LinearEventKind.Waiting:
    case LinearEventKind.Verdict:
    case LinearEventKind.Ended:
    case LinearEventKind.PrMerged:
      return null;
  }
}

/** The default moves in words, the one wording the reporter's brief carries. */
export const STATUS_AIM_TEXT: Readonly<Record<StatusAim, string>> = {
  [StatusAim.FirstStarted]:
    "the team's first started-type status (the one whose name says progress; Linear lists no order), only when the issue is in a triage, backlog or unstarted type; no move when the team's names don't say which that is",
  [StatusAim.ReviewLike]:
    "the team's review-like started-type status (the one whose name says review), only when the issue is not already at or past it; no move when the team has no such status",
};

const BEFORE_STARTED: ReadonlySet<string> = new Set([
  LinearStatusType.Triage,
  LinearStatusType.Backlog,
  LinearStatusType.Unstarted,
]);

const REVIEW_NAME = /review/i;
const PROGRESS_NAME = /progress/i;

const isStarted = (s: TeamStatus): boolean => s.type === LinearStatusType.Started;
const sameStatus = (a: TeamStatus, b: TeamStatus): boolean => a.name === b.name;

/** Whether `a` sits before `b`; null when either shows no position, so their order is unknown. */
const sitsBefore = (a: TeamStatus, b: TeamStatus): boolean | null =>
  a.position === undefined || b.position === undefined ? null : a.position < b.position;

const byPosition = (a: TeamStatus, b: TeamStatus): number => (a.position ?? 0) - (b.position ?? 0);

/** Every status shows its position. Linear's MCP server shows none, in no fixed order. */
const positioned = (statuses: readonly TeamStatus[]): boolean =>
  statuses.every((s) => s.position !== undefined);

function firstStarted(statuses: readonly TeamStatus[]): TeamStatus | null {
  const started = statuses.filter(isStarted);
  if (started.length === 0) return null;
  // The lowest position. Statuses that share it, or a list with no positions, are a tie the name breaks: the
  // name that says progress wins, then the only one that doesn't say review. A tie the names leave open picks
  // nothing: any of them would be a guess.
  const lowest = positioned(started) ? Math.min(...started.map((s) => s.position ?? 0)) : null;
  const tied = lowest === null ? started : started.filter((s) => s.position === lowest);
  const progress = tied.find((s) => PROGRESS_NAME.test(s.name));
  if (progress !== undefined) return progress;
  const notReview = tied.filter((s) => !REVIEW_NAME.test(s.name));
  const only = notReview.length === 1 ? notReview[0] : tied.length === 1 ? tied[0] : undefined;
  return only ?? null;
}

function reviewLike(current: TeamStatus, statuses: readonly TeamStatus[]): TeamStatus | null {
  const first = firstStarted(statuses);
  if (first === null) return null;
  const started = statuses.filter(isStarted);
  const known = positioned(started);
  const candidates = started
    .filter((s) => !sameStatus(s, first) && (sitsBefore(first, s) ?? true))
    .sort(byPosition);
  // With no positions only the name can say which status a review sits in.
  const target =
    candidates.find((s) => REVIEW_NAME.test(s.name)) ?? (known ? candidates[0] : undefined);
  if (target === undefined) return null;
  // The review status is the team's, not the issue's: an issue already at or past it stays where it is.
  if (BEFORE_STARTED.has(current.type)) return target;
  if (!isStarted(current) || sameStatus(current, target)) return null;
  return sameStatus(current, first) || sitsBefore(current, target) === true ? target : null;
}

/** The status name 10db last set on the issue: the newest recorded row that set one, or null when none did. */
export function lastStatusSet(
  rows: readonly Pick<LinearPostDto, 'state' | 'statusSet' | 'recordedAt'>[],
): string | null {
  let newest: { name: string; at: string } | null = null;
  for (const row of rows) {
    if (row.state !== LinearPostState.Recorded || row.statusSet === null) continue;
    const at = row.recordedAt ?? '';
    if (newest === null || at >= newest.at) newest = { name: row.statusSet, at };
  }
  return newest?.name ?? null;
}

const SaveIssueArguments = z.object({ state: z.string() });

/**
 * The statuses Linear took in a run: the `state` of each `save_issue` on one of the run's Linear servers that
 * came back done. A call that failed, was refused or never returned set nothing, whatever the guard allowed.
 */
export function appliedStatuses(
  runCalls: readonly ToolCallView[],
  linearPrefixes: readonly string[],
): ReadonlySet<string> {
  const applied = new Set<string>();
  for (const call of linearCalls(runCalls, linearPrefixes)) {
    if (call.tool !== 'save_issue' || call.status !== ToolCallStatus.Done) continue;
    try {
      // A view's own preview of the call's arguments, as JSON; one cut short names no status.
      const parsed = SaveIssueArguments.safeParse(JSON.parse(call.argumentsPreview));
      if (parsed.success) applied.add(parsed.data.state);
    } catch {
      // Not JSON: the preview was cut, so the call shows no status.
    }
  }
  return applied;
}

/**
 * The status an update moves the issue to, or null to leave it. Never earlier in position or type than
 * the issue's current status, never to or from a completed, canceled or any other type past started, and
 * nothing when the builder moved the issue since 10db's last set (`lastSet` is the name 10db last set before
 * this run, null when it never has). A status with no position sits in an unknown order, so only its type and
 * name place it.
 *
 * `runPick` is the status this run already picked for another of its updates. A run reads the issue once, so
 * the `current` its later updates carry is from before that pick: the pick is where the issue is, or is about
 * to be, and the update is measured from it. So a run that owes a start and a landing ends at the review
 * status, and one that reports the landing first never goes back to the first started status.
 */
export function pickStatusMove(input: {
  readonly event: LinearEventKind;
  readonly current: TeamStatus;
  readonly statuses: readonly TeamStatus[];
  readonly lastSet: string | null;
  readonly runPick?: string | null;
}): TeamStatus | null {
  const { event, statuses, lastSet } = input;
  const picked = statuses.find((s) => s.name === (input.runPick ?? null));
  // A run that already picked a status found the issue where 10db left it; only its first pick asks.
  if (picked === undefined && lastSet !== null && lastSet !== input.current.name) return null;
  const current = picked ?? input.current;
  switch (statusAimOf(event)) {
    case StatusAim.FirstStarted: {
      if (!BEFORE_STARTED.has(current.type)) return null;
      return firstStarted(statuses);
    }
    case StatusAim.ReviewLike:
      return reviewLike(current, statuses);
    case null:
      return null;
  }
}
