import type { EvalModelResultDto } from '@10db/contracts';
import { z } from 'zod';
import type { CaseTrials, ParsedRun } from './run-summary';

const Gate = z
  .object({
    rate: z.number(),
    minimum: z.number().nullish(),
    passed: z.boolean(),
  })
  .loose();

const Trial = z
  .object({
    name: z.string(),
    source_case: z.string().nullish(),
    failed: z.boolean().nullish(),
    assertions: z.record(z.string(), z.unknown()).nullish(),
  })
  .loose();

const Slot = z
  .object({
    slot: z.string().nullish(),
    slug: z.string(),
    passed: z.boolean(),
    trials: z.number().nullish(),
    gates: z.record(z.string(), Gate),
    cost: z
      .object({ total: z.union([z.string(), z.number()]).nullish() })
      .loose()
      .nullish(),
    latency_ms: z.object({ p50: z.number().nullish() }).loose().nullish(),
    cases: z.array(Trial).nullish(),
  })
  .loose();

/** A gate report as the project's own evals write it; only the fields read are named. */
export const GateReport = z
  .object({
    task: z.string().nullish(),
    fingerprint: z.string().nullish(),
    repeat: z.number().nullish(),
    passed: z.boolean(),
    slots: z.array(Slot),
  })
  .loose();
export type GateReport = z.infer<typeof GateReport>;

const unit = (n: number): number => Math.min(1, Math.max(0, n));

function modelOf(slot: z.infer<typeof Slot>): EvalModelResultDto {
  const total = slot.cost?.total;
  const cost =
    total === null || total === undefined || String(total).trim() === ''
      ? Number.NaN
      : Number(total);
  return {
    model: slot.slug,
    slot:
      slot.slot === null || slot.slot === undefined || slot.slot === slot.slug ? null : slot.slot,
    passed: slot.passed,
    gates: Object.entries(slot.gates).map(([name, gate]) => ({
      name,
      rate: unit(gate.rate),
      minimum: gate.minimum === null || gate.minimum === undefined ? null : unit(gate.minimum),
      passed: gate.passed,
    })),
    costUsd: Number.isFinite(cost) && cost >= 0 ? cost : null,
    latencyP50Ms: slot.latency_ms?.p50 ?? null,
    trials:
      slot.trials === null || slot.trials === undefined
        ? null
        : Math.max(0, Math.trunc(slot.trials)),
  };
}

/** A trial failed when it says so or any assertion it records is false. */
const trialFailed = (trial: z.infer<typeof Trial>): boolean =>
  trial.failed === true || Object.values(trial.assertions ?? {}).some((held) => held === false);

/** Trials counted per source case and model, so a case flaky on one model shows under it. */
function casesOf(report: GateReport): CaseTrials[] {
  const byName = new Map<string, { trials: number; failed: number }>();
  for (const slot of report.slots) {
    for (const trial of slot.cases ?? []) {
      const name = `${trial.source_case ?? trial.name} (${slot.slug})`;
      const seen = byName.get(name) ?? { trials: 0, failed: 0 };
      seen.trials += 1;
      if (trialFailed(trial)) seen.failed += 1;
      byName.set(name, seen);
    }
  }
  return [...byName].map(([name, counts]) => ({ name, ...counts }));
}

/** The suite key a report names itself, or null when it names none. */
export const gateReportTask = (report: GateReport): string | null =>
  report.task === null || report.task === undefined || report.task === '' ? null : report.task;

/** One gate report, as a run: the time is the file name's. */
export function parseGateReport(report: GateReport, path: string, at: string): ParsedRun {
  return {
    path,
    at,
    passed: report.passed,
    fingerprint: report.fingerprint ?? null,
    repeat:
      report.repeat === null || report.repeat === undefined || report.repeat < 1
        ? null
        : Math.trunc(report.repeat),
    models: report.slots.map(modelOf),
    cases: casesOf(report),
  };
}
