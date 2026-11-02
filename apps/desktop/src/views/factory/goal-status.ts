import { GoalStatus } from '@10db/contracts';
import type { MantineColor } from '@mantine/core';

const S = GoalStatus;

/** DESIGN.md status colors, as for a workstream: blue running, yellow waiting on you, orange paused, red failed, green done, gray idle. */
export const GOAL_STATUS_COLORS: Readonly<Record<GoalStatus, MantineColor>> = {
  [S.Failed]: 'red',
  [S.WaitingOnYou]: 'yellow',
  [S.WaitingOnSomeone]: 'gray',
  [S.Paused]: 'orange',
  [S.Running]: 'blue',
  [S.Shipping]: 'blue',
  [S.NotStarted]: 'gray',
  [S.Done]: 'green',
};

export const GOAL_STATUS_LABELS: Readonly<Record<GoalStatus, string>> = {
  [S.Failed]: 'Failed',
  [S.WaitingOnYou]: 'Waiting on you',
  [S.WaitingOnSomeone]: 'Waiting on someone',
  [S.Paused]: 'Paused',
  [S.Running]: 'Running',
  [S.Shipping]: 'Shipping',
  [S.NotStarted]: 'Not started',
  [S.Done]: 'Done',
};
