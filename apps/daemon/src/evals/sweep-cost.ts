import {
  EvalSweepKind,
  EvalSweepReason,
  EvalSweepState,
  EvalSweepStepState,
} from '@10db/contracts';

/** The sweep as it stands: its steps in run order, with each one's estimate and, once settled, its cost. */
export interface SweepPlan {
  readonly kind: EvalSweepKind;
  readonly capUsd: number;
  readonly steps: readonly {
    readonly state: EvalSweepStepState;
    readonly estimateUsd: number | null;
    readonly costUsd: number | null;
  }[];
}

/**
 * What one run on a candidate should cost: the reference run's cost scaled by the candidate's output price over
 * the reference model's. Unknown when either price or the reference is, or when the reference is free.
 */
export function estimateRunCost(
  reference: { costUsd: number; outputPrice: number } | null,
  candidateOutputPrice: number | null,
): number | null {
  if (reference === null || candidateOutputPrice === null) return null;
  if (!(reference.outputPrice > 0)) return null;
  return (reference.costUsd * candidateOutputPrice) / reference.outputPrice;
}

// Money is compared in whole micro-dollars so a cap that fits exactly is not lost to float sums.
const micros = (usd: number): number => Math.round(usd * 1_000_000);

type Next = { step: number } | { end: EvalSweepState; reason: EvalSweepReason | null };

/**
 * The next step to start or the end, once a step has settled. Spent counts known costs only. `cheapest` ends
 * `found` at the first pass, stops when a settled step's cost is unknown (the budget can no longer be kept), and
 * starts the next step only when its estimate is known and fits what the cap has left; `try` runs every step,
 * an unknown estimate included while the cap has money left, and stops before a step whose known estimate does
 * not fit.
 */
export function sweepNext(plan: SweepPlan): Next {
  const settled = plan.steps.filter(
    (s) => s.state === EvalSweepStepState.Passed || s.state === EvalSweepStepState.Failed,
  );
  const cheapest = plan.kind === EvalSweepKind.Cheapest;
  if (cheapest && settled.some((s) => s.state === EvalSweepStepState.Passed))
    return { end: EvalSweepState.Found, reason: null };
  if (cheapest && settled.some((s) => s.costUsd === null))
    return { end: EvalSweepState.Stopped, reason: EvalSweepReason.CostUnknown };

  const next = plan.steps.findIndex((s) => s.state === EvalSweepStepState.Waiting);
  const waiting = plan.steps[next];
  if (waiting === undefined) return { end: EvalSweepState.Done, reason: null };

  const left =
    micros(plan.capUsd) - micros(plan.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0));
  const fits = waiting.estimateUsd !== null && micros(waiting.estimateUsd) <= left;
  const runs = fits || (!cheapest && waiting.estimateUsd === null && left > 0);
  return runs ? { step: next } : { end: EvalSweepState.Done, reason: EvalSweepReason.Capped };
}
