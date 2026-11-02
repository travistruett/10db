import { GoalStatus } from '@10db/contracts';

interface GoalStatusLook {
  /** A DESIGN.md status color: blue running, yellow waiting on a human, orange paused, red failed. */
  readonly color: 'red' | 'yellow' | 'orange' | 'blue' | 'green' | 'gray';
  readonly label: string;
}

/**
 * How a goal's status reads on the Board. Shipping is blue: green is only for work that has merged,
 * and a goal whose pull requests are still open has not.
 */
export const GOAL_STATUS_LOOK: Readonly<Record<GoalStatus, GoalStatusLook>> = {
  [GoalStatus.Failed]: { color: 'red', label: 'Failed' },
  [GoalStatus.WaitingOnYou]: { color: 'yellow', label: 'Waiting on you' },
  [GoalStatus.WaitingOnSomeone]: { color: 'yellow', label: 'Waiting on someone' },
  [GoalStatus.Paused]: { color: 'orange', label: 'Paused' },
  [GoalStatus.Running]: { color: 'blue', label: 'Running' },
  [GoalStatus.Shipping]: { color: 'blue', label: 'Shipping' },
  [GoalStatus.NotStarted]: { color: 'gray', label: 'Not started' },
  [GoalStatus.Done]: { color: 'green', label: 'Done' },
};
