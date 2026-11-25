import { z } from 'zod';
import { PathPattern } from './entities';

/** A result file format 10db reads. 10db defines no eval format of its own; each is a project's. */
export const EvalResultFormat = {
  /** ampsio's `evals/reports/<task>/<UTC timestamp>.json`: gates per model slot, billed cost. */
  GateReport: 'gate_report',
  /** 10db's own lane-pipeline eval: `apps/daemon/evals/lane-pipeline/baselines/<rigor>.json`. */
  LanePipeline: 'lane_pipeline',
} as const;
export type EvalResultFormat = (typeof EvalResultFormat)[keyof typeof EvalResultFormat];

/** A suite's key: a report's own task name, or a manifest's key. */
export const EvalSuiteKey = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'a suite key is letters, digits and . _ : / -');
export type EvalSuiteKey = z.infer<typeof EvalSuiteKey>;

/** A tracked path of the repository, as a manifest names it. */
const RepoPath = z.string().min(1).max(300);

/** One named assertion's rate against its bar in one run, for one model. */
export const EvalGateDto = z.object({
  name: z.string(),
  rate: z.number().min(0).max(1),
  /** The rate it must reach; null when the format states none. */
  minimum: z.number().min(0).max(1).nullable(),
  passed: z.boolean(),
});
export type EvalGateDto = z.infer<typeof EvalGateDto>;

/** One model's result in one run. */
export const EvalModelResultDto = z.object({
  /** The model as the run asked for it (a slug or preset). */
  model: z.string(),
  /** The project's own name for the binding (`SMART@medium`), when it has one. */
  slot: z.string().nullable(),
  passed: z.boolean(),
  gates: z.array(EvalGateDto),
  /** What the run cost on this model, in dollars; null when the report says nothing, never 0 for unknown. */
  costUsd: z.number().min(0).nullable(),
  latencyP50Ms: z.number().min(0).nullable(),
  trials: z.int().min(0).nullable(),
});
export type EvalModelResultDto = z.infer<typeof EvalModelResultDto>;

/** One committed result file: one run of a suite. */
export const EvalRunSummaryDto = z.object({
  /** The result file, which identifies the run. */
  path: RepoPath,
  at: z.iso.datetime(),
  passed: z.boolean(),
  /** The run's whole cost; null when any model's is unknown. */
  costUsd: z.number().min(0).nullable(),
  models: z.array(z.string()),
});
export type EvalRunSummaryDto = z.infer<typeof EvalRunSummaryDto>;

/** What the list shows of a suite. */
export const EvalSuiteDto = z.object({
  key: EvalSuiteKey,
  label: z.string(),
  /** The bar in words, from the manifest. */
  bar: z.string().nullable(),
  /** The cases, goldens and gates that define it. */
  definitionPaths: z.array(RepoPath),
  /** Where its results are read from; null when no result file was found. */
  format: z.enum([EvalResultFormat.GateReport, EvalResultFormat.LanePipeline]).nullable(),
  runCount: z.int().min(0),
  latest: z
    .object({
      path: RepoPath,
      at: z.iso.datetime(),
      passed: z.boolean(),
      models: z.array(EvalModelResultDto),
    })
    .nullable(),
  /** Whether each of the last eight runs passed, oldest first. */
  trend: z.array(z.boolean()).max(8),
});
export type EvalSuiteDto = z.infer<typeof EvalSuiteDto>;

/** A piece of LLM work no suite covers, as the manifest names it. */
export const EvalGapDto = z.object({
  label: z.string().min(1).max(200),
  /** Where the model call is, `path` or `path:line`. */
  where: z.string().min(1).max(300),
  /** Why it counts, in the repository's own words where it has them. */
  why: z.string().max(500),
});
export type EvalGapDto = z.infer<typeof EvalGapDto>;

/** What 10db has found of a project's evals at its checkout's HEAD. */
export const EvalsDto = z.object({
  /** The commit read; null for a repository with no commit. */
  commit: z.string().nullable(),
  /** When an agent last assessed the project's evals; null when only file names found them. */
  assessedAt: z.iso.datetime().nullable(),
  suites: z.array(EvalSuiteDto),
  /** Eval files found by name that no suite links to yet. Empty once assessed. */
  unlinked: z.array(RepoPath),
  /** The manifest's LLM work with no eval; null before an assessment, which is the only way to know. */
  gaps: z.array(EvalGapDto).nullable(),
});
export type EvalsDto = z.infer<typeof EvalsDto>;

/** A case that both passed and failed across recent runs. */
export const EvalFlakyCaseDto = z.object({
  name: z.string(),
  failed: z.int().min(0),
  trials: z.int().min(1),
});
export type EvalFlakyCaseDto = z.infer<typeof EvalFlakyCaseDto>;

/** A suite's drawer: every run, one run whole, its flaky cases and what the manifest says of it. */
export const EvalSuiteDetailDto = z.object({
  suite: EvalSuiteDto,
  /** Newest first. */
  runs: z.array(EvalRunSummaryDto),
  run: z
    .object({
      path: RepoPath,
      at: z.iso.datetime(),
      passed: z.boolean(),
      /** The dataset's fingerprint, when the format records one. */
      fingerprint: z.string().nullable(),
      repeat: z.int().min(1).nullable(),
      models: z.array(EvalModelResultDto),
    })
    .nullable(),
  /** Across the last eight runs. */
  flaky: z.array(EvalFlakyCaseDto),
  coveredPaths: z.array(PathPattern),
  freeCommand: z.string().nullable(),
  liveCommand: z.string().nullable(),
});
export type EvalSuiteDetailDto = z.infer<typeof EvalSuiteDetailDto>;

/** The query of a suite's drawer: the run to show whole, the newest by default. */
export const EvalSuiteQuery = z.strictObject({ run: RepoPath.optional() });
export type EvalSuiteQuery = z.infer<typeof EvalSuiteQuery>;

/** One suite as an assessment records it. */
export const EvalManifestSuite = z.strictObject({
  key: EvalSuiteKey,
  label: z.string().min(1).max(200).optional(),
  bar: z.string().min(1).max(1000).optional(),
  definitionPaths: z.array(RepoPath).max(50).default([]),
  coveredPaths: z.array(PathPattern).max(50).default([]),
  /** The free arm that runs in the project's own gate, such as a replay. */
  freeCommand: z.string().min(1).max(300).optional(),
  /** The paid arm. 10db shows it and never runs it. */
  liveCommand: z.string().min(1).max(300).optional(),
});
export type EvalManifestSuite = z.infer<typeof EvalManifestSuite>;

/**
 * What an agent's assessment of a project's evals records, a project setting beside its hazards and
 * never a file in the repository. It names what no file name says: which code a suite covers, its bar and
 * commands, and the LLM work with no eval.
 */
export const EvalManifest = z.strictObject({
  suites: z.array(EvalManifestSuite).max(500),
  gaps: z.array(EvalGapDto).max(200),
});
export type EvalManifest = z.infer<typeof EvalManifest>;

/** The manifest as stored: what was recorded, the commit it read, and when. */
export const StoredEvalManifest = z.object({
  manifest: EvalManifest,
  commit: z.string().nullable(),
  assessedAt: z.iso.datetime(),
});
export type StoredEvalManifest = z.infer<typeof StoredEvalManifest>;

/** What recording a manifest did: each path it names that isn't tracked is refused before it is kept. */
export const EvalManifestResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), evals: EvalsDto }),
  z.object({ ok: z.literal(false), untracked: z.array(z.string()), message: z.string() }),
]);
export type EvalManifestResult = z.infer<typeof EvalManifestResult>;
