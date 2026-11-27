import {
  EvalSweepKind as Kind,
  EvalSweepReason as Reason,
  EvalSweepState as State,
  EvalSweepStepState as Step,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { estimateRunCost, sweepNext, type SweepPlan } from './sweep-cost';

type S = SweepPlan['steps'][number];
const step = (state: S['state'], estimateUsd: number | null, costUsd: number | null = null): S => ({
  state,
  estimateUsd,
  costUsd,
});
const plan = (kind: SweepPlan['kind'], capUsd: number, ...steps: S[]): SweepPlan => ({
  kind,
  capUsd,
  steps,
});

describe('estimateRunCost', () => {
  it('scales the reference cost by the output prices and is unknown when either is', () => {
    expect(estimateRunCost({ costUsd: 2, outputPrice: 10 }, 5)).toBe(1);
    expect(estimateRunCost({ costUsd: 2, outputPrice: 10 }, 30)).toBe(6);
    expect(estimateRunCost(null, 5)).toBeNull();
    expect(estimateRunCost({ costUsd: 2, outputPrice: 10 }, null)).toBeNull();
    expect(estimateRunCost({ costUsd: 2, outputPrice: 0 }, 5)).toBeNull();
  });
});

describe('sweepNext', () => {
  it('picks the next step or the end by cost, cap and kind', () => {
    // cheapest: a pass ends the sweep as found, even with steps waiting
    expect(
      sweepNext(plan(Kind.Cheapest, 10, step(Step.Passed, 1, 1), step(Step.Waiting, 2))),
    ).toEqual({ end: State.Found, reason: null });
    // cheapest: a fail runs the next step when its estimate fits exactly, not when a cent short
    expect(
      sweepNext(plan(Kind.Cheapest, 3, step(Step.Failed, 1, 1), step(Step.Waiting, 2))),
    ).toEqual({ step: 1 });
    expect(
      sweepNext(plan(Kind.Cheapest, 2.99, step(Step.Failed, 1, 1), step(Step.Waiting, 2))),
    ).toEqual({ end: State.Done, reason: Reason.Capped });
    // cheapest: an unknown estimate cannot be shown to fit
    expect(
      sweepNext(plan(Kind.Cheapest, 10, step(Step.Failed, 1, 1), step(Step.Waiting, null))),
    ).toEqual({ end: State.Done, reason: Reason.Capped });
    // cheapest: nothing left out for the cap is a plain done
    expect(sweepNext(plan(Kind.Cheapest, 10, step(Step.Failed, 1, 1)))).toEqual({
      end: State.Done,
      reason: null,
    });
    // cheapest: a settled step with an unknown cost stops the sweep
    expect(
      sweepNext(plan(Kind.Cheapest, 10, step(Step.Failed, 1, null), step(Step.Waiting, 1))),
    ).toEqual({ end: State.Stopped, reason: Reason.CostUnknown });
    // float sums still fit exactly
    expect(
      sweepNext(plan(Kind.Cheapest, 0.3, step(Step.Failed, 0.1, 0.1), step(Step.Waiting, 0.2))),
    ).toEqual({ step: 1 });
    // try: a pass does not end it
    expect(sweepNext(plan(Kind.Try, 10, step(Step.Passed, 1, 1), step(Step.Waiting, 2)))).toEqual({
      step: 1,
    });
    // try: an unknown estimate runs, and an unknown cost counts as nothing spent
    expect(
      sweepNext(plan(Kind.Try, 1, step(Step.Failed, 1, null), step(Step.Waiting, null))),
    ).toEqual({ step: 1 });
    // try: a known estimate that does not fit ends it capped; exactly fitting runs
    expect(sweepNext(plan(Kind.Try, 2.99, step(Step.Failed, 1, 1), step(Step.Waiting, 2)))).toEqual(
      { end: State.Done, reason: Reason.Capped },
    );
    expect(sweepNext(plan(Kind.Try, 3, step(Step.Failed, 1, 1), step(Step.Waiting, 2)))).toEqual({
      step: 1,
    });
    expect(sweepNext(plan(Kind.Try, 3, step(Step.Passed, 1, 1)))).toEqual({
      end: State.Done,
      reason: null,
    });
  });
});
