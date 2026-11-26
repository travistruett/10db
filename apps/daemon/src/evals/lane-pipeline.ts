import type { EvalModelResultDto } from '@10db/contracts';
import { z } from 'zod';
import type { ParsedRun } from './run-summary';

/** The outcome of a run that met its case; the lane-pipeline eval's own word (`scripts/eval/grade.ts`). */
const MET = 'met';

const Run = z.object({ outcome: z.string(), costUsd: z.number().nullish() }).loose();

/** A lane-pipeline baseline as the eval script writes it; only the fields read are named. */
export const LanePipelineReport = z
  .object({
    rigor: z.string(),
    agent: z.string(),
    finishedAt: z.string(),
    cases: z.array(z.object({ id: z.string(), runs: z.array(Run) }).loose()),
  })
  .loose();
export type LanePipelineReport = z.infer<typeof LanePipelineReport>;

/** One baseline, as a run of one model (the agent) with a gate per case. */
export function parseLanePipeline(report: LanePipelineReport, path: string): ParsedRun | null {
  const at = new Date(report.finishedAt);
  if (Number.isNaN(at.getTime())) return null;
  const gates = report.cases.map((c) => {
    const met = c.runs.filter((r) => r.outcome === MET).length;
    return {
      name: c.id,
      rate: c.runs.length === 0 ? 0 : met / c.runs.length,
      minimum: 1,
      passed: c.runs.length > 0 && met === c.runs.length,
    };
  });
  const costs = report.cases.flatMap((c) => c.runs.map((r) => r.costUsd ?? null));
  const model: EvalModelResultDto = {
    model: report.agent,
    slot: null,
    passed: gates.length > 0 && gates.every((g) => g.passed),
    gates,
    costUsd:
      costs.length === 0 || costs.includes(null)
        ? null
        : costs.reduce<number>((a, b) => a + (b ?? 0), 0),
    latencyP50Ms: null,
    trials: report.cases.reduce((n, c) => n + c.runs.length, 0),
  };
  return {
    path,
    at: at.toISOString(),
    passed: model.passed,
    fingerprint: null,
    repeat: null,
    models: [model],
    cases: [],
  };
}
