import { Outcome } from './grade';

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

export interface KeepRule {
  /** Whether the change is kept: as many met runs as the baseline, and no case lost. */
  readonly holds: boolean;
  /** Met runs over the cases both reports have. */
  readonly met: number;
  readonly baselineMet: number;
  /** Cases met in at least one baseline run that are met in neither run now. */
  readonly lostCases: readonly string[];
}

/**
 * Whether a change is kept against the baseline: criteria met the same or better over the cases both
 * reports have, and no case that passed in the baseline (met in at least one of its runs) fails in both
 * runs now. A case only one side has decides nothing.
 */
export function keepRule(now: readonly CaseOutcomes[], before: readonly CaseOutcomes[]): KeepRule {
  const was = new Map(before.map((c) => [c.id, c.outcomes]));
  const shared = now.flatMap((c) => {
    const prior = was.get(c.id);
    return prior === undefined ? [] : [{ id: c.id, now: c.outcomes, before: prior }];
  });
  const metIn = (outcomes: readonly Outcome[]) => outcomes.filter((o) => o === Outcome.Met).length;
  const met = shared.reduce((n, c) => n + metIn(c.now), 0);
  const baselineMet = shared.reduce((n, c) => n + metIn(c.before), 0);
  const lostCases = shared
    .filter((c) => metIn(c.before) > 0 && metIn(c.now) === 0)
    .map((c) => c.id);
  return { holds: met >= baselineMet && lostCases.length === 0, met, baselineMet, lostCases };
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
