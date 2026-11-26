import type {
  EvalModelDto,
  EvalModelsDto,
  EvalModelSuiteDto,
  StoredEvalManifest,
} from '@10db/contracts';
import type { FoundEvals } from './read-results';

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Every model the project's results graded, each with its newest result per suite: the read a model swap
 * needs. A result from a run whose fingerprint differs from the suite's newest run is marked `olderEval`.
 */
export function buildModels(
  found: FoundEvals | null,
  manifest: StoredEvalManifest | null,
): EvalModelsDto {
  const byModel = new Map<string, { slots: Set<string>; suites: EvalModelSuiteDto[] }>();
  for (const suite of found?.suites ?? []) {
    const label = manifest?.manifest.suites.find((s) => s.key === suite.key)?.label ?? suite.key;
    const newestFingerprint = suite.runs.at(-1)?.fingerprint ?? null;
    const seen = new Set<string>();
    for (const run of [...suite.runs].reverse()) {
      for (const result of run.models) {
        const entry = byModel.get(result.model) ?? { slots: new Set<string>(), suites: [] };
        byModel.set(result.model, entry);
        if (result.slot !== null) entry.slots.add(result.slot);
        if (seen.has(result.model)) continue;
        seen.add(result.model);
        entry.suites.push({
          key: suite.key,
          label,
          path: run.path,
          at: run.at,
          passed: result.passed,
          failedGates: result.gates.filter((g) => !g.passed).map((g) => g.name),
          costUsd: result.costUsd,
          latencyP50Ms: result.latencyP50Ms,
          olderEval:
            run.fingerprint !== null &&
            newestFingerprint !== null &&
            run.fingerprint !== newestFingerprint,
        });
      }
    }
  }
  const models: EvalModelDto[] = [...byModel].map(([model, { slots, suites }]) => {
    const cost = suites.some((s) => s.costUsd === null)
      ? null
      : suites.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    return {
      model,
      slots: [...slots].sort(),
      passed: suites.filter((s) => s.passed).length,
      suites: suites.sort(
        (a, b) => Number(a.passed) - Number(b.passed) || a.key.localeCompare(b.key),
      ),
      costUsd: cost,
      latencyP50Ms: median(
        suites.flatMap((s) => (s.latencyP50Ms === null ? [] : [s.latencyP50Ms])),
      ),
    };
  });
  return {
    models: models.sort(
      (a, b) => b.suites.length - a.suites.length || a.model.localeCompare(b.model),
    ),
  };
}
