import { WorkPlace } from '@10db/contracts';
import { TabState, tabWords, type TabDetail } from './tab-state';

/** Where a session works, which the row's icon says. */
export const RowIcon = {
  Reading: 'reading',
  Here: 'here',
  Branch: 'branch',
  Terminal: 'terminal',
} as const;
export type RowIcon = (typeof RowIcon)[keyof typeof RowIcon];

/** The mark at a row's right; each has a shape of its own, so none is told by colour alone. */
export const RowMark = {
  Working: 'working',
  NeedsYou: 'needs_you',
  Error: 'error',
  Paused: 'paused',
  PullRequest: 'pull_request',
  Merged: 'merged',
  /** The session's Plan has rows waiting for Accept. */
  PlanWaiting: 'plan_waiting',
} as const;
export type RowMark = (typeof RowMark)[keyof typeof RowMark];

export interface RowStateInput {
  /** What the session's conversation and open cards say (`tabState`). */
  readonly tab: TabState;
  /** Null while the session is only reading. */
  readonly place: WorkPlace | null;
  /** The pull request's state, known only for the session on screen. */
  readonly pullRequest: 'open' | 'merged' | null;
  /** How many of the session's Plan's rows wait for Accept. */
  readonly planWaiting?: number;
}

export interface RowState {
  readonly icon: RowIcon;
  readonly mark: RowMark | null;
  /** The title is in weight 600: a reply the builder has not seen. */
  readonly bold: boolean;
  /** The title is dimmed: the session is in the builder's terminal. */
  readonly dim: boolean;
  /** What a screen reader says after the title; empty when the row shows nothing. */
  readonly spoken: string;
}

function iconOf({ tab, place }: RowStateInput): RowIcon {
  if (tab === TabState.InTerminal) return RowIcon.Terminal;
  switch (place) {
    case null:
    case WorkPlace.Choosing:
      return RowIcon.Reading;
    case WorkPlace.Here:
      return RowIcon.Here;
    case WorkPlace.Moving:
    case WorkPlace.Branch:
      return RowIcon.Branch;
  }
}

/**
 * What a panel row shows: where the session works, and the first mark that holds. A card to answer, a
 * choice of where to work or an error comes before a spinner, since the builder is needed and the spinner
 * would hide it; then a turn or a move, an open pull request, a merged one, a Plan waiting for Accept
 * (which keeps an unseen reply's bold title) and an unseen reply.
 */
export function rowState(input: RowStateInput, detail: TabDetail = {}): RowState {
  const { tab, place, pullRequest, planWaiting = 0 } = input;
  const icon = iconOf(input);
  const words = tabWords(tab, detail);
  const base = { icon, bold: false, dim: tab === TabState.InTerminal };
  if (place === WorkPlace.Choosing && tab !== TabState.Error)
    return { ...base, mark: RowMark.NeedsYou, spoken: 'needs you: choose where it works' };
  if (tab === TabState.NeedsYou) return { ...base, mark: RowMark.NeedsYou, spoken: words.spoken };
  if (tab === TabState.Error) return { ...base, mark: RowMark.Error, spoken: words.spoken };
  if (tab === TabState.Paused) return { ...base, mark: RowMark.Paused, spoken: words.spoken };
  if (place === WorkPlace.Moving)
    return { ...base, mark: RowMark.Working, spoken: 'moving to a new branch' };
  if (tab === TabState.Working) return { ...base, mark: RowMark.Working, spoken: words.spoken };
  if (pullRequest === 'open')
    return { ...base, mark: RowMark.PullRequest, spoken: 'pull request open' };
  if (pullRequest === 'merged') return { ...base, mark: RowMark.Merged, spoken: 'merged' };
  if (planWaiting > 0) {
    const waiting = `plan: ${String(planWaiting)} ${planWaiting === 1 ? 'row waits' : 'rows wait'} for Accept`;
    return {
      ...base,
      mark: RowMark.PlanWaiting,
      bold: tab === TabState.NewReply,
      spoken: tab === TabState.NewReply ? `${words.spoken}, ${waiting}` : waiting,
    };
  }
  if (tab === TabState.NewReply) return { ...base, mark: null, bold: true, spoken: words.spoken };
  return { ...base, mark: null, spoken: words.spoken };
}
