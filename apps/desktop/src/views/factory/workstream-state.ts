import { isTerminal, WorkstreamState, type WorkstreamState as State } from '@10db/contracts';
import type { MantineColor } from '@mantine/core';

const S = WorkstreamState;

/** DESIGN.md status colors: blue running, yellow waiting on you, orange paused, red failed, green done, gray idle. */
export const STATE_COLORS: Readonly<Record<State, MantineColor>> = {
  [S.Queued]: 'gray',
  [S.Held]: 'gray',
  [S.Starting]: 'blue',
  [S.Running]: 'blue',
  [S.HandingOff]: 'blue',
  [S.Verifying]: 'blue',
  [S.TakenOver]: 'blue',
  [S.WaitingHuman]: 'yellow',
  [S.PausedLimit]: 'orange',
  [S.Recovering]: 'orange',
  [S.Failed]: 'red',
  [S.Done]: 'green',
  [S.Cancelled]: 'gray',
};

export const STATE_LABELS: Readonly<Record<State, string>> = {
  [S.Queued]: 'Queued',
  [S.Held]: 'Held',
  [S.Starting]: 'Starting',
  [S.Running]: 'Running',
  [S.HandingOff]: 'Handing off',
  [S.Verifying]: 'Verifying',
  [S.TakenOver]: 'Taken over',
  [S.WaitingHuman]: 'Waiting on you',
  [S.PausedLimit]: 'Paused (usage limit)',
  [S.Recovering]: 'Recovering',
  [S.Failed]: 'Failed',
  [S.Done]: 'Done',
  [S.Cancelled]: 'Cancelled',
};

export function canCancel(state: State): boolean {
  return !isTerminal(state);
}

/** Only a failed workstream can be retried (the daemon refuses anything else). */
export function canRetry(state: State): boolean {
  return state === S.Failed;
}
