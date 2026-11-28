import { describe, expect, it } from 'vitest';
import { StallFault, StallMove, stallMove, type StallMoveInput } from './restart-rule';
import { StallKind } from './rules';

/** A fresh active stall with attempts left: only the row's own fields are changed from it. */
const FRESH: StallMoveInput = {
  asking: false,
  kind: StallKind.Active,
  inFlight: false,
  restarted: false,
  stopHung: false,
  recoveryLeft: true,
  fault: null,
};

describe('stallMove', () => {
  const rows: readonly {
    readonly name: string;
    readonly input: StallMoveInput;
    readonly move: StallMove;
    readonly fileDefect: boolean;
  }[] = [
    // Row 1: every other field would restart it, so only asking or the kind can make it a card.
    { name: 'asking', input: { ...FRESH, asking: true }, move: StallMove.Card, fileDefect: false },
    {
      name: 'a queued run',
      input: { ...FRESH, kind: StallKind.Queued, fault: StallFault.NoLane },
      move: StallMove.Card,
      fileDefect: false,
    },
    {
      name: 'a batch',
      input: { ...FRESH, kind: StallKind.Batch },
      move: StallMove.Card,
      fileDefect: false,
    },
    // Row 2: a fresh run would restart, so only the restart in flight makes it wait.
    {
      name: 'in flight',
      input: { ...FRESH, inFlight: true },
      move: StallMove.Wait,
      fileDefect: false,
    },
    // Row 3.
    { name: 'fresh', input: FRESH, move: StallMove.Restart, fileDefect: false },
    {
      name: 'fresh with a fault of 10db’s own',
      input: { ...FRESH, fault: StallFault.NoLane },
      move: StallMove.Restart,
      fileDefect: false,
    },
    // Row 4, each field that sends it up on its own.
    {
      name: 'already restarted, session silent',
      input: { ...FRESH, restarted: true },
      move: StallMove.OutOfMoves,
      fileDefect: false,
    },
    {
      name: 'already restarted, gate past its limit',
      input: { ...FRESH, restarted: true, fault: StallFault.GatePastLimit },
      move: StallMove.OutOfMoves,
      fileDefect: true,
    },
    {
      name: 'its stop hung',
      input: { ...FRESH, stopHung: true, fault: StallFault.StopHung },
      move: StallMove.OutOfMoves,
      fileDefect: true,
    },
    {
      name: 'no recovery attempts left',
      input: { ...FRESH, recoveryLeft: false },
      move: StallMove.OutOfMoves,
      fileDefect: false,
    },
    {
      name: 'no recovery attempts left, never started',
      input: { ...FRESH, recoveryLeft: false, fault: StallFault.NeverStarted },
      move: StallMove.OutOfMoves,
      fileDefect: true,
    },
  ];

  it.each(rows)('$name', ({ input, move, fileDefect }) => {
    expect(stallMove(input)).toEqual({ move, fileDefect });
  });
});
