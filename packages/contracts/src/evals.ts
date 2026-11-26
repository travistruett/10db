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
  /**
   * Trials that got no answer, by the report's own kind (`provider_error`, `timeout`): availability, apart
   * from quality. They stay in every gate's denominator. Empty when every trial was answered or the format
   * doesn't say.
   */
  unanswered: z.record(z.string(), z.int().min(1)),
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
  /** The dataset's fingerprint when the format records one: runs with different ones graded different evals. */
  fingerprint: z.string().nullable(),
});
export type EvalRunSummaryDto = z.infer<typeof EvalRunSummaryDto>;

/** One run in a suite's trend. */
export const EvalTrendPointDto = z.object({ passed: z.boolean(), evalChanged: z.boolean() });
export type EvalTrendPointDto = z.infer<typeof EvalTrendPointDto>;

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
  /**
   * The last eight runs, oldest first: whether each passed, and whether it graded a different eval than the
   * run before it (its fingerprint changed), so a dot isn't compared with one that measured something else.
   */
  trend: z.array(EvalTrendPointDto).max(8),
  /**
   * When a definition file was committed well after the latest run, so that run no longer measures the
   * eval as written; null when it wasn't, or nothing names the definition.
   */
  definitionChangedAt: z.iso.datetime().nullable(),
});
export type EvalSuiteDto = z.infer<typeof EvalSuiteDto>;

/** A piece of LLM work no suite covers, as the manifest names it. */
export const EvalGap = z.object({
  label: z.string().min(1).max(200),
  /** Where the model call is, `path` or `path:line`. */
  where: z.string().min(1).max(300),
  /** Why it counts, in the repository's own words where it has them. */
  why: z.string().max(500),
});
export type EvalGap = z.infer<typeof EvalGap>;

/** How a gap was known: an assessment named it, or a call pattern found it at HEAD. */
export const EvalGapSource = { Assessed: 'assessed', Found: 'found' } as const;
export type EvalGapSource = (typeof EvalGapSource)[keyof typeof EvalGapSource];

/** A gap as the page shows it. */
export const EvalGapDto = z.object({
  label: z.string().min(1).max(200),
  where: z.string().min(1).max(300),
  why: z.string().max(500),
  source: z.enum([EvalGapSource.Assessed, EvalGapSource.Found]),
});
export type EvalGapDto = z.infer<typeof EvalGapDto>;

/** The most matches one read of a project's call sites keeps, across all its patterns. */
export const MAX_CALL_SITES = 2000;

/** How many sites one call pattern found at HEAD. */
export const EvalCallSiteCountDto = z.object({
  label: z.string(),
  /** Null when git refused the pattern. */
  count: z.int().min(0).nullable(),
  /** The count stopped at the cap, so there are more. */
  capped: z.boolean(),
});
export type EvalCallSiteCountDto = z.infer<typeof EvalCallSiteCountDto>;

/** What changed since the assessment's commit that the manifest doesn't account for. */
export const EvalDriftDto = z.object({
  /** The commit the assessment read. */
  since: z.string(),
  /** Eval files by name at HEAD, not at the assessed commit, that no suite links. */
  newEvalFiles: z.array(RepoPath),
  /** Call sites found at HEAD outside every suite that weren't at the assessed commit. */
  newGaps: z.array(EvalGapDto),
  /** Definition paths and covered globs the manifest names that HEAD no longer tracks. */
  missingPaths: z.array(z.string()),
});
export type EvalDriftDto = z.infer<typeof EvalDriftDto>;

/** What 10db has found of a project's evals at its checkout's HEAD. */
export const EvalsDto = z.object({
  /** The commit read; null for a repository with no commit. */
  commit: z.string().nullable(),
  /** When an agent last assessed the project's evals; null when only file names found them. */
  assessedAt: z.iso.datetime().nullable(),
  suites: z.array(EvalSuiteDto),
  /** Eval files found by name that no suite links to yet. Empty once assessed. */
  unlinked: z.array(RepoPath),
  /**
   * LLM work with no eval: what the manifest names, then what its call patterns find at HEAD outside every
   * suite's covered paths. Null before an assessment, which is the only way to know.
   */
  gaps: z.array(EvalGapDto).nullable(),
  /** What each call pattern found at HEAD, so a pattern that is too broad shows. Empty before an assessment. */
  callSites: z.array(EvalCallSiteCountDto),
  /** Null when HEAD is the assessed commit, nothing has changed that the manifest misses, or there is no manifest. */
  drift: EvalDriftDto.nullable(),
});
export type EvalsDto = z.infer<typeof EvalsDto>;

/** A model's newest result in one suite. */
export const EvalModelSuiteDto = z.object({
  key: EvalSuiteKey,
  label: z.string(),
  path: RepoPath,
  at: z.iso.datetime(),
  passed: z.boolean(),
  /** The gates under their minimum, by name. */
  failedGates: z.array(z.string()),
  costUsd: z.number().min(0).nullable(),
  latencyP50Ms: z.number().min(0).nullable(),
  /**
   * The run graded an older eval than the suite's newest run (their fingerprints differ), so it can't be
   * compared with that run's models as if they took the same test.
   */
  olderEval: z.boolean(),
});
export type EvalModelSuiteDto = z.infer<typeof EvalModelSuiteDto>;

/** One model across every suite that graded it. */
export const EvalModelDto = z.object({
  model: z.string(),
  /** The project's names for it (`SMART@medium`), as its runs bound it. */
  slots: z.array(z.string()),
  passed: z.int().min(0),
  /** Its newest result per suite, failing first. */
  suites: z.array(EvalModelSuiteDto),
  /** One run of each suite it ran; null when any one's cost is unknown. */
  costUsd: z.number().min(0).nullable(),
  /** The median of its suites' p50 latency; null when none recorded one. */
  latencyP50Ms: z.number().min(0).nullable(),
});
export type EvalModelDto = z.infer<typeof EvalModelDto>;

/** Every model a project's results graded, the one that ran the most suites first. */
export const EvalModelsDto = z.object({ models: z.array(EvalModelDto) });
export type EvalModelsDto = z.infer<typeof EvalModelsDto>;

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

/** Regex syntax git's extended regex (`git grep -E`) reads differently or not at all: `\\d`, `\\b`, `(?…)`, `*?`. */
const NOT_EXTENDED_REGEX = /\\[A-Za-z0-9]|\(\?|[*+?}]\?/u;

/** A regex the manifest records, read by `git grep -E` and checked here as a pattern both git and JS parse alike. */
export const EvalCallRegex = z
  .string()
  .min(1)
  .max(300)
  .refine((r) => {
    try {
      new RegExp(r);
      return true;
    } catch {
      return false;
    }
  }, 'is not a regex')
  .refine(
    (r) => !NOT_EXTENDED_REGEX.test(r),
    'uses syntax git grep -E does not read (\\d, \\b, (?..), lazy quantifiers): use [0-9], [[:space:]] and plain groups',
  );

/** A glob a call pattern searches, as git's `:(glob)` pathspec reads it: no `{a,b}`. */
const CallGlob = PathPattern.refine(
  (g) => !g.includes('{'),
  'git pathspecs have no {a,b}: list each glob',
);

/**
 * How the project marks a unit of LLM work (a decorator, a registry call, an SDK call), so 10db finds each
 * one at every HEAD with `git grep` and a new one with no eval shows the commit it lands.
 */
export const EvalCallPattern = z.strictObject({
  label: z.string().min(1).max(100),
  regex: EvalCallRegex,
  /** The files searched; every tracked file when none is named. */
  globs: z.array(CallGlob).min(1).max(10).default(['**']),
});
export type EvalCallPattern = z.infer<typeof EvalCallPattern>;

/**
 * What an agent's assessment of a project's evals records, a project setting beside its hazards and
 * never a file in the repository. It names what no file name says: which code a suite covers, its bar and
 * commands, and the LLM work with no eval.
 */
export const EvalManifest = z
  .strictObject({
    suites: z.array(EvalManifestSuite).max(500),
    gaps: z.array(EvalGap).max(200),
    callPatterns: z.array(EvalCallPattern).max(20).default([]),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    for (const [index, suite] of m.suites.entries()) {
      if (seen.has(suite.key)) {
        ctx.addIssue({
          code: 'custom',
          message: `the suite key ${suite.key} is named twice`,
          path: ['suites', index, 'key'],
        });
      }
      seen.add(suite.key);
    }
    const labels = new Set<string>();
    for (const [index, pattern] of m.callPatterns.entries()) {
      if (labels.has(pattern.label)) {
        ctx.addIssue({
          code: 'custom',
          message: `the call pattern ${pattern.label} is named twice`,
          path: ['callPatterns', index, 'label'],
        });
      }
      labels.add(pattern.label);
    }
  })
  .refine((m) => m.suites.reduce((n, s) => n + s.coveredPaths.length, 0) <= 200, {
    message: 'a manifest covers at most 200 globs in all',
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

/** Where a request for an eval came from, so the task says why it exists. */
export const NewEvalOrigin = {
  /** The Evals page's header button. */
  Page: 'page',
  /** A row of the No Eval tab. */
  Gap: 'gap',
  /** A goal's proposed eval in a Shape plan. */
  PlanEval: 'plan_eval',
} as const;
export type NewEvalOrigin = (typeof NewEvalOrigin)[keyof typeof NewEvalOrigin];

const RationaleText = z.string().trim().max(4000);

/**
 * What the New Eval form sends: the rationale an eval is written from, which becomes the brief of a task
 * that drafts it. Only the behavior is required; each other section reads "not stated" when empty.
 */
export const NewEvalRequest = z.strictObject({
  /** The behavior the eval pins, as the task's title names it. */
  behavior: z
    .string()
    .trim()
    .min(1)
    .max(150)
    .refine((b) => !/\p{Cc}/u.test(b), 'no control characters such as newlines or tabs'),
  decision: RationaleText.default(''),
  evidence: RationaleText.default(''),
  oracle: RationaleText.default(''),
  /** The cases to cover and the bar a model must reach. */
  coverageAndBar: RationaleText.default(''),
  models: RationaleText.default(''),
  execution: RationaleText.default(''),
  /** Tracked paths the behavior lives in; the lane reads them, and they pick the task's areas. */
  where: z.array(RepoPath).max(20).default([]),
  origin: z.enum([NewEvalOrigin.Page, NewEvalOrigin.Gap, NewEvalOrigin.PlanEval]).default('page'),
});
export type NewEvalBody = z.output<typeof NewEvalRequest>;
