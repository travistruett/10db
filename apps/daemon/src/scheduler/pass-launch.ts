import { PassState } from '@10db/contracts';

// Workbench spec §5.5, §6.2, §12: a page of a pass runs when the builder has written to it (since
// the builder stopped it, if its latest turn was stopped), or when a turn it began has not ended,
// never from a next action alone. A crash or a usage pause leaves a
// `start` or `resume` behind, and a taken message becomes a fresh `start`, so the rows decide.

/** Why a queued page of a pass launches now, or what holds it. */
export const PassLaunch = {
  Launch: 'launch',
  /** Nothing to act on: no builder message waits and the latest turn is carried through. */
  Idle: 'idle',
  /** The pass is closing or abandoning; its pages start no turn. */
  PassNotOpen: 'pass_not_open',
  /** The task is being taken out of the pass. */
  TakingOut: 'taking_out',
  /** Your folder is not seen on the pass's branch this tick. */
  FolderOff: 'folder_off',
} as const;
export type PassLaunch = (typeof PassLaunch)[keyof typeof PassLaunch];

/** What the launch rule reads of a queued page, each from its rows or this tick's branch read. */
export interface PassLaunchFacts {
  readonly passState: PassState;
  /** The task has a take-out of this pass that has not finished. */
  readonly takingOut: boolean;
  /** A builder message of the task that no turn has taken, pushed or not. */
  readonly untaken: boolean;
  /** The latest turn was stopped by the builder. */
  readonly stopped: boolean;
  /** A builder message no turn has taken was written after the latest turn was stopped. */
  readonly writtenSinceStop: boolean;
  /** The task's latest turn is not carried through: still open, or ended and not settled. */
  readonly turnUnsettled: boolean;
  /** Whether Your folder names the pass's branch; null when this tick did not read it. */
  readonly folderOn: boolean | null;
}

export function passLaunch(facts: PassLaunchFacts): PassLaunch {
  if (facts.passState !== PassState.Open) return PassLaunch.PassNotOpen;
  if (facts.takingOut) return PassLaunch.TakingOut;
  // After a Stop the page waits for the builder's next message; what was written before the stop
  // goes with it.
  const written = facts.stopped ? facts.writtenSinceStop : facts.untaken;
  if (!written && !facts.turnUnsettled) return PassLaunch.Idle;
  if (facts.folderOn !== true) return PassLaunch.FolderOff;
  return PassLaunch.Launch;
}
