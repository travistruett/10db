import type { Outcome } from './grade';

/** One case's outcomes, one per run. */
export interface CaseOutcomes {
  readonly id: string;
  readonly outcomes: readonly Outcome[];
}

const sorted = (outcomes: readonly Outcome[]): Outcome[] => [...outcomes].sort();
const samePair = (a: readonly Outcome[], b: readonly Outcome[]): boolean =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** The cases whose runs did not all end the same way. */
export function flipsBetweenRuns(cases: readonly CaseOutcomes[]): string[] {
  return cases.filter((c) => new Set(c.outcomes).size > 1).map((c) => c.id);
}

export interface BaselineFlips {
  /** Cases in both reports whose outcomes differ, each side sorted so run order doesn't count. */
  readonly changed: readonly { id: string; now: Outcome[]; before: Outcome[] }[];
  /** Cases only this report has. */
  readonly added: readonly string[];
  /** Cases only the baseline has. */
  readonly dropped: readonly string[];
}

/** How this report's outcomes differ from a saved baseline's. */
export function flipsAgainstBaseline(
  now: readonly CaseOutcomes[],
  before: readonly CaseOutcomes[],
): BaselineFlips {
  const was = new Map(before.map((c) => [c.id, c.outcomes]));
  const is = new Set(now.map((c) => c.id));
  return {
    changed: now.flatMap((c) => {
      const prior = was.get(c.id);
      return prior === undefined || samePair(c.outcomes, prior)
        ? []
        : [{ id: c.id, now: sorted(c.outcomes), before: sorted(prior) }];
    }),
    added: now.filter((c) => !was.has(c.id)).map((c) => c.id),
    dropped: before.filter((c) => !is.has(c.id)).map((c) => c.id),
  };
}
