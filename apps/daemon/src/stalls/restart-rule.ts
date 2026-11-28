import { StallKind } from './rules';

/** How long a stop of a stalled run may take before it counts as hung. */
export const STALL_STOP_DEADLINE_MS = 2 * 60_000;

/** The part of 10db that failed when a run stalled: what a defect task is filed for. */
export const StallFault = {
  /** Running or Verifying with no live lane. */
  NoLane: 'no_lane',
  GatePastLimit: 'gate_past_limit',
  /** Still Starting. */
  NeverStarted: 'never_started',
  StopHung: 'stop_hung',
} as const;
export type StallFault = (typeof StallFault)[keyof typeof StallFault];

export const StallMove = {
  /** Today's Stuck card. */
  Card: 'card',
  Restart: 'restart',
  /** A restart of this run is already under way. */
  Wait: 'wait',
  /** The Out of Moves card. */
  OutOfMoves: 'out_of_moves',
} as const;
export type StallMove = (typeof StallMove)[keyof typeof StallMove];

export interface StallMoveInput {
  /** The Stuck run rule is set to ask. */
  readonly asking: boolean;
  readonly kind: StallKind;
  /** A restart of this run has not returned. */
  readonly inFlight: boolean;
  /** A restart record exists for this run's step. */
  readonly restarted: boolean;
  /** Its record has `stopHungAt`. */
  readonly stopHung: boolean;
  /** The run has recovery attempts left. */
  readonly recoveryLeft: boolean;
  /** Null: the session went silent, which is not 10db's defect. */
  readonly fault: StallFault | null;
}

/**
 * What to do about a stalled run. The first row that matches wins: ask, or anything but an active run, keeps
 * the Stuck card; a restart under way is waited on; a run never restarted, with attempts left, is restarted
 * once; every other case is out of moves, and a fault of 10db's own files a defect.
 */
export function stallMove(input: StallMoveInput): {
  readonly move: StallMove;
  readonly fileDefect: boolean;
} {
  if (input.asking || input.kind !== StallKind.Active) {
    return { move: StallMove.Card, fileDefect: false };
  }
  if (input.inFlight) return { move: StallMove.Wait, fileDefect: false };
  if (!input.restarted && !input.stopHung && input.recoveryLeft) {
    return { move: StallMove.Restart, fileDefect: false };
  }
  return { move: StallMove.OutOfMoves, fileDefect: input.fault !== null };
}
