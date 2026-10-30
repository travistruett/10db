import { WorkstreamState as S, type WorkstreamState } from './states';

/** Allowed workstream transitions (spec §5.1). Anything not listed is forbidden. */
export const WORKSTREAM_TRANSITIONS: Readonly<Record<WorkstreamState, readonly WorkstreamState[]>> =
  {
    [S.Queued]: [S.Starting, S.Held, S.Cancelled],
    [S.Held]: [S.Queued, S.Cancelled],
    [S.Starting]: [S.Running, S.Verifying, S.Recovering, S.PausedLimit, S.Failed, S.Cancelled],
    [S.Running]: [
      S.HandingOff,
      S.Verifying,
      S.WaitingHuman,
      S.PausedLimit,
      S.Recovering,
      S.TakenOver,
      S.Failed,
      S.Cancelled,
    ],
    [S.HandingOff]: [
      S.Running,
      S.Verifying,
      S.WaitingHuman,
      S.PausedLimit,
      S.Recovering,
      S.Failed,
      S.Cancelled,
    ],
    [S.Verifying]: [S.Done, S.Queued, S.WaitingHuman, S.Failed, S.Recovering, S.Cancelled],
    [S.WaitingHuman]: [S.Running, S.HandingOff, S.Verifying, S.Queued, S.Cancelled],
    [S.PausedLimit]: [S.Queued, S.Cancelled],
    [S.Recovering]: [S.Queued, S.Failed, S.Cancelled],
    [S.TakenOver]: [S.Recovering, S.Cancelled],
    [S.Done]: [],
    [S.Failed]: [S.Queued],
    [S.Cancelled]: [],
  };

export function canTransition(from: WorkstreamState, to: WorkstreamState): boolean {
  return WORKSTREAM_TRANSITIONS[from].includes(to);
}

const TERMINAL: readonly WorkstreamState[] = [S.Done, S.Failed, S.Cancelled];

export function isTerminal(state: WorkstreamState): boolean {
  return TERMINAL.includes(state);
}

/** States that occupy a lane. WAITING_HUMAN also occupies one while its session is still live. */
export const LANE_STATES: readonly WorkstreamState[] = [
  S.Starting,
  S.Running,
  S.HandingOff,
  S.Verifying,
];

/** Every state except the three terminal ones. */
export const ACTIVE_STATES: readonly WorkstreamState[] = Object.values(S).filter(
  (s) => !TERMINAL.includes(s),
);
