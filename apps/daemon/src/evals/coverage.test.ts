import { EvalCoverageState } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { coverageOf } from './coverage';
import type { ParsedRun } from './run-summary';

function run(
  at: string,
  models: Record<string, boolean>,
  fingerprint: string | null = 'f1',
): ParsedRun {
  return {
    path: `evals/reports/t/${at}.json`,
    at,
    passed: Object.values(models).every(Boolean),
    fingerprint,
    repeat: null,
    cases: [],
    models: Object.entries(models).map(([model, passed]) => ({
      model,
      slot: null,
      passed,
      gates: [],
      costUsd: null,
      latencyP50Ms: null,
      trials: null,
      unanswered: {},
    })),
  };
}

const BASE = '2026-11-10T00:00:00.000Z';
const HEAD = '2026-11-12T00:00:00.000Z';

describe('a covered suite against a task', () => {
  it("reads before, after and the marker from the results and the task's times", () => {
    const before = run('2026-11-09T00:00:00Z', { a: true, b: true });
    const stateOf = (runs: ParsedRun[]) => coverageOf({ runs, baseAt: BASE, headAt: HEAD });
    // A result between the branch point and the last commit is neither side.
    const during = run('2026-11-11T00:00:00Z', { a: true, b: true });
    expect(stateOf([before, during])).toMatchObject({
      state: EvalCoverageState.NotRun,
      before: { at: before.at },
      after: null,
    });
    // After is the first result newer than the last commit, however the runs are ordered.
    const first = run('2026-11-13T00:00:00Z', { a: true, b: true });
    const later = run('2026-11-14T00:00:00Z', { a: false, b: true });
    expect(stateOf([later, before, first])).toMatchObject({
      state: EvalCoverageState.Passing,
      after: { at: first.at },
    });
    // A model that passed before and fails after is a regression.
    expect(stateOf([before, run('2026-11-13T00:00:00Z', { a: true, b: false })]).state).toBe(
      EvalCoverageState.Regressed,
    );
    // A failure no passing model preceded, or with no before at all, is failing.
    const weak = run('2026-11-09T00:00:00Z', { a: true, b: false });
    expect(stateOf([weak, run('2026-11-13T00:00:00Z', { a: true, b: false })]).state).toBe(
      EvalCoverageState.Failing,
    );
    expect(stateOf([run('2026-11-13T00:00:00Z', { a: false })]).state).toBe(
      EvalCoverageState.Failing,
    );
    // A different dataset is the eval changing, never a regression.
    expect(stateOf([before, run('2026-11-13T00:00:00Z', { a: false, b: false }, 'f2')]).state).toBe(
      EvalCoverageState.EvalChanged,
    );
  });
});
