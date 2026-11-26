import type { EvalModelResultDto, EvalRunSummaryDto } from '@10db/contracts';

/** What one trial of one case showed: how a flaky case is found. */
export interface CaseTrials {
  readonly name: string;
  readonly trials: number;
  readonly failed: number;
}

/** One result file read into the shape every format shares. */
export interface ParsedRun {
  readonly path: string;
  readonly at: string;
  readonly passed: boolean;
  readonly fingerprint: string | null;
  readonly repeat: number | null;
  readonly models: readonly EvalModelResultDto[];
  /** Empty for a format that records no cases. */
  readonly cases: readonly CaseTrials[];
}

/** What a run list shows of a run; the one place its summary is made. */
export const runSummary = (run: ParsedRun): EvalRunSummaryDto => ({
  path: run.path,
  at: run.at,
  passed: run.passed,
  costUsd: runCost(run.models),
  models: run.models.map((m) => m.model),
  fingerprint: run.fingerprint,
});

/** A run's whole cost: the models' sum, null when any model's is unknown or there is none. */
export function runCost(models: readonly EvalModelResultDto[]): number | null {
  if (models.length === 0) return null;
  let sum = 0;
  for (const model of models) {
    if (model.costUsd === null) return null;
    sum += model.costUsd;
  }
  return sum;
}
