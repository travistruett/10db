import { LinearEventKind } from '@10db/contracts';

// Which Linear status an update moves its issue to, picked from the team's own statuses by type and
// position, with the name only breaking a tie. Pure: it reads nothing, and it is the one place the
// default moves are decided, so the brief's wording and any daemon-side write follow the same rule.

/** The type Linear gives every workflow status of a team. */
export const LinearStatusType = {
  Triage: 'triage',
  Backlog: 'backlog',
  Unstarted: 'unstarted',
  Started: 'started',
  Completed: 'completed',
  Canceled: 'canceled',
} as const;
export type LinearStatusType = (typeof LinearStatusType)[keyof typeof LinearStatusType];

/** One of a team's statuses, as `list_issue_statuses` shows it. */
export interface TeamStatus {
  readonly name: string;
  readonly type: LinearStatusType;
  readonly position: number;
}

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
    "the team's first started-type status (lowest position among the type started), only when the issue is in a triage, backlog or unstarted type",
  [StatusAim.ReviewLike]:
    "the team's review-like started-type status: the started-type status positioned after the team's first started status (the earliest whose name says review when several qualify), only when it sits after the issue's current status; no move when the team has no such status",
};

const BEFORE_STARTED: ReadonlySet<LinearStatusType> = new Set([
  LinearStatusType.Triage,
  LinearStatusType.Backlog,
  LinearStatusType.Unstarted,
]);

const REVIEW_NAME = /review/i;
const PROGRESS_NAME = /progress/i;

const byPosition = (a: TeamStatus, b: TeamStatus): number => a.position - b.position;

function firstStarted(statuses: readonly TeamStatus[]): TeamStatus | null {
  const started = statuses.filter((s) => s.type === LinearStatusType.Started).sort(byPosition);
  const first = started[0];
  if (first === undefined) return null;
  // Equal positions are a tie: the name that says progress wins.
  return (
    started.filter((s) => s.position === first.position).find((s) => PROGRESS_NAME.test(s.name)) ??
    first
  );
}

function reviewLike(current: TeamStatus, statuses: readonly TeamStatus[]): TeamStatus | null {
  const first = firstStarted(statuses);
  if (first === null) return null;
  const candidates = statuses
    .filter(
      (s) => s.type === LinearStatusType.Started && s !== first && s.position > first.position,
    )
    .sort(byPosition);
  const target = candidates.find((s) => REVIEW_NAME.test(s.name)) ?? candidates[0] ?? null;
  // The review status is the team's, not the issue's: an issue already at or past it stays where it is.
  return target !== null && target.position > current.position ? target : null;
}

/**
 * The status an update moves the issue to, or null to leave it. Never earlier in position or type than
 * the issue's current status, never a completed or canceled type, and nothing when the builder moved the
 * issue since 10db's last set (`lastSet` is the name 10db last set, null when it never has).
 */
export function pickStatusMove(input: {
  readonly event: LinearEventKind;
  readonly current: TeamStatus;
  readonly statuses: readonly TeamStatus[];
  readonly lastSet: string | null;
}): TeamStatus | null {
  const { event, current, statuses, lastSet } = input;
  if (lastSet !== null && lastSet !== current.name) return null;
  switch (statusAimOf(event)) {
    case StatusAim.FirstStarted: {
      if (!BEFORE_STARTED.has(current.type)) return null;
      return firstStarted(statuses);
    }
    case StatusAim.ReviewLike: {
      if (current.type === LinearStatusType.Completed || current.type === LinearStatusType.Canceled)
        return null;
      return reviewLike(current, statuses);
    }
    case null:
      return null;
  }
}
