import { Rigor, Verdict } from '@10db/contracts';
import { z } from 'zod';
import {
  flipsAgainstBaseline,
  flipsBetweenRuns,
  keepRule,
  type BaselineFlips,
  type KeepRule,
} from './compare';
import { GateResult, LaneRule, Outcome } from './grade';

/** Who plays the lanes: real Claude Code on the default account, or the scripted fake. */
export const EvalAgent = { Claude: 'claude', Fake: 'fake' } as const;
export type EvalAgent = (typeof EvalAgent)[keyof typeof EvalAgent];

const Count = z.int().min(0);

export const CaseRun = z.object({
  run: z.int().min(1),
  outcome: z.enum(Outcome),
  workstreamState: z.string(),
  failureReason: z.string().nullable(),
  gate: z.enum(GateResult),
  reviewVerdict: z.enum(Verdict).nullable(),
  reviewRounds: Count,
  sessions: Count,
  handoffs: Count,
  /** Agent and Task calls in the transcripts kept; null when none could be read (the fake agent). */
  spawns: Count.nullable(),
  inputTokens: Count,
  outputTokens: Count,
  cachedTokens: Count,
  /** Dollars the sessions table recorded; null on a subscription, which reports none. */
  costUsd: z.number().min(0).nullable(),
  wallSeconds: z.number().min(0),
  rules: z.array(z.object({ rule: z.enum(LaneRule), held: z.boolean(), detail: z.string() })),
  missingTranscripts: z.array(z.string()),
});
export type CaseRun = z.infer<typeof CaseRun>;

export const CaseReport = z.object({ id: z.string(), title: z.string(), runs: z.array(CaseRun) });
export type CaseReport = z.infer<typeof CaseReport>;

export const EvalReport = z.object({
  rigor: z.enum(Rigor),
  agent: z.enum(EvalAgent),
  /** The rigor's plansInBuild setting the run forced; null when it ran on the playbook as it is. */
  plansInBuild: z.boolean().nullable().default(null),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  cases: z.array(CaseReport),
});
export type EvalReport = z.infer<typeof EvalReport>;

const outcomesOf = (r: EvalReport) =>
  r.cases.map((c) => ({ id: c.id, outcomes: c.runs.map((run) => run.outcome) }));

/** The flips a report shows: between each case's runs, and against the baseline when there is one. */
export function reportFlips(
  report: EvalReport,
  baseline: EvalReport | null,
): { betweenRuns: string[]; againstBaseline: BaselineFlips | null } {
  return {
    betweenRuns: flipsBetweenRuns(outcomesOf(report)),
    againstBaseline:
      baseline === null ? null : flipsAgainstBaseline(outcomesOf(report), outcomesOf(baseline)),
  };
}

const sum = (runs: readonly CaseRun[], pick: (r: CaseRun) => number | null): number | null => {
  const values = runs.map(pick);
  return values.some((v) => v === null) ? null : values.reduce<number>((n, v) => n + (v ?? 0), 0);
};
const dash = (v: number | null, text: (n: number) => string = String): string =>
  v === null ? '—' : text(v);
const dollars = (n: number) => `$${n.toFixed(2)}`;
const seconds = (n: number) => `${String(Math.round(n))} s`;

/** A case's row lists each run's value in run order; the total counts them instead. */
const listed = (values: readonly string[]): string => values.join(', ');
const counted = (values: readonly string[]): string =>
  [...new Set(values)]
    .sort()
    .map((v) => `${String(values.filter((x) => x === v).length)} ${v}`)
    .join(', ');

function row(label: string, runs: readonly CaseRun[], show = listed): string {
  const met = runs.filter((r) => r.outcome === Outcome.Met).length;
  const cells = [
    label,
    `${String(met)}/${String(runs.length)} met`,
    show(runs.map((r) => r.outcome)),
    show(runs.map((r) => r.gate)),
    show(runs.map((r) => r.reviewVerdict ?? '—')),
    dash(sum(runs, (r) => r.reviewRounds)),
    dash(sum(runs, (r) => r.sessions)),
    dash(sum(runs, (r) => r.handoffs)),
    dash(sum(runs, (r) => r.spawns)),
    `${dash(sum(runs, (r) => r.inputTokens))} / ${dash(sum(runs, (r) => r.outputTokens))} / ${dash(sum(runs, (r) => r.cachedTokens))}`,
    dash(
      sum(runs, (r) => r.costUsd),
      dollars,
    ),
    dash(
      sum(runs, (r) => r.wallSeconds),
      seconds,
    ),
  ];
  return `| ${cells.join(' | ')} |`;
}

/** Whether the change is kept against the baseline, and the counts and cases that decide it. */
function keepLine(keep: KeepRule): string {
  const counts = `${String(keep.met)} met runs against the baseline’s ${String(keep.baselineMet)}`;
  if (keep.holds) return `**Holds**: ${counts}, and no case lost.`;
  const lost =
    keep.lostCases.length === 0
      ? ''
      : ` Lost (met in the baseline, in neither run now): ${keep.lostCases.join(', ')}.`;
  return `**Fails**: ${counts}.${lost}`;
}

/**
 * The report as the builder reads it: one row per case over its runs, a total, what flipped, and whether
 * the keep rule holds against the baseline.
 */
export function renderReport(report: EvalReport, baseline: EvalReport | null): string {
  const flips = reportFlips(report, baseline);
  const allRuns = report.cases.flatMap((c) => c.runs);
  const broken = report.cases.flatMap((c) =>
    c.runs.flatMap((r) =>
      r.rules
        .filter((rule) => !rule.held)
        .map((rule) => `- ${c.id} run ${String(r.run)}: ${rule.rule} (${rule.detail})`),
    ),
  );
  const failures = report.cases.flatMap((c) =>
    c.runs
      .filter((r) => r.failureReason !== null)
      .map((r) => `- ${c.id} run ${String(r.run)}: ${r.failureReason ?? ''}`),
  );
  const missing = report.cases.flatMap((c) =>
    c.runs
      .filter((r) => r.missingTranscripts.length > 0)
      .map((r) => `- ${c.id} run ${String(r.run)}: ${r.missingTranscripts.join(', ')}`),
  );
  const against = flips.againstBaseline;
  const keep = baseline === null ? null : keepRule(outcomesOf(report), outcomesOf(baseline));
  const setting =
    report.plansInBuild === null
      ? ''
      : report.plansInBuild
        ? ', plans in the Build session'
        : ', plans in a Plan step';
  return [
    `# Lane-pipeline eval: ${report.rigor}, ${report.agent} agent${setting}`,
    '',
    `Ran ${report.startedAt} to ${report.finishedAt}. Tokens are input / output / cached; a dash is a figure no session recorded.`,
    '',
    '| Case | Criteria | Outcomes | Gate | Review | Rounds | Sessions | Hand-offs | Spawns | Tokens | Cost | Wall |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.cases.map((c) => row(c.id, c.runs)),
    row('**Total**', allRuns, counted),
    '',
    '## Flips between runs',
    '',
    ...(flips.betweenRuns.length === 0 ? ['None.'] : flips.betweenRuns.map((id) => `- ${id}`)),
    '',
    '## Flips against the baseline',
    '',
    ...(against === null
      ? ['No baseline report was given.']
      : against.changed.length + against.added.length + against.dropped.length === 0
        ? ['None.']
        : [
            ...against.changed.map(
              (f) => `- ${f.id}: ${f.before.join(', ')} → ${f.now.join(', ')}`,
            ),
            ...against.added.map((id) => `- ${id}: not in the baseline`),
            ...against.dropped.map((id) => `- ${id}: in the baseline, not run now`),
          ]),
    '',
    '## Keep rule',
    '',
    keep === null ? 'No baseline report was given.' : keepLine(keep),
    '',
    '## Lane rules broken',
    '',
    ...(broken.length === 0 ? ['None.'] : broken),
    '',
    '## Failures',
    '',
    ...(failures.length === 0 ? ['None.'] : failures),
    '',
    '## Sessions with no transcript on disk',
    '',
    ...(missing.length === 0 ? ['None.'] : missing),
    '',
  ].join('\n');
}
