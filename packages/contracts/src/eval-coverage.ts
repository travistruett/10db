import { z } from 'zod';

/**
 * Where a task's covered suite stands. `not_run`: no result newer than the task's last commit. `passing` and
 * `failing` read that result; `regressed` is a failing result where a model passed before; `eval_changed` is a
 * result graded against a different dataset than the one before it, so no comparison is made.
 */
export const EvalCoverageState = {
  NotRun: 'not_run',
  Passing: 'passing',
  Failing: 'failing',
  Regressed: 'regressed',
  EvalChanged: 'eval_changed',
} as const;
export type EvalCoverageState = (typeof EvalCoverageState)[keyof typeof EvalCoverageState];

/** A suite as the manifest stood when a run started: its covered globs are what the run is matched against. */
export const EvalCoverageSnapshot = z.object({
  key: z.string(),
  label: z.string(),
  coveredPaths: z.array(z.string()),
  liveCommand: z.string().nullable(),
});
export type EvalCoverageSnapshot = z.infer<typeof EvalCoverageSnapshot>;

/**
 * What an `eval_coverage` evidence row keeps. `matched` is null until the run's change is read after its gate;
 * the times are those of the commit the run branched from and of its last commit. Stored rows are never
 * rewritten, so changes stay backward compatible.
 */
export const EvalCoverageDetail = z.object({
  suites: z.array(EvalCoverageSnapshot),
  matched: z
    .array(
      z.object({
        key: z.string(),
        paths: z.array(z.string()),
        /** What the suite last showed before the run, as a short phrase; null when it had no result. */
        lastBefore: z.string().nullable(),
      }),
    )
    .nullable(),
  baseAt: z.string().nullable(),
  headAt: z.string().nullable(),
  /** Set when the change could not be read, so nothing was matched. */
  skipped: z.string().nullable(),
});
export type EvalCoverageDetail = z.infer<typeof EvalCoverageDetail>;

/** What a row whose detail does not parse reads as: no suite, so no marker. */
export const UNREADABLE_EVAL_COVERAGE_DETAIL: EvalCoverageDetail = {
  suites: [],
  matched: null,
  baseAt: null,
  headAt: null,
  skipped: 'unreadable',
};

/** `EvalCoverageDetail` as an evidence row reads it. */
export const StoredEvalCoverageDetail = EvalCoverageDetail.catch(UNREADABLE_EVAL_COVERAGE_DETAIL);

/** One suite's mark on a task's card. */
export const EvalMarkerDto = z.object({
  suiteKey: z.string(),
  label: z.string(),
  state: z.enum(EvalCoverageState),
});
export type EvalMarkerDto = z.infer<typeof EvalMarkerDto>;

/** `GET /projects/:id/eval-markers`: the markers of the project's tasks, by task id; a task with none is absent. */
export const EvalMarkersDto = z.object({
  tasks: z.record(z.string(), z.array(EvalMarkerDto)),
});
export type EvalMarkersDto = z.infer<typeof EvalMarkersDto>;

/** One result on either side of a task. */
export const EvalCoverageSideDto = z.object({
  path: z.string(),
  at: z.iso.datetime(),
  passed: z.boolean(),
  fingerprint: z.string().nullable(),
  models: z.array(z.object({ model: z.string(), passed: z.boolean() })),
});
export type EvalCoverageSideDto = z.infer<typeof EvalCoverageSideDto>;

export const EvalCoverageSuiteDto = z.object({
  suiteKey: z.string(),
  label: z.string(),
  state: z.enum(EvalCoverageState),
  /** The changed files that matched the suite's covered globs. */
  paths: z.array(z.string()),
  /** The paid command, for the builder to run in their checkout; 10db never runs it. */
  liveCommand: z.string().nullable(),
  before: EvalCoverageSideDto.nullable(),
  after: EvalCoverageSideDto.nullable(),
});
export type EvalCoverageSuiteDto = z.infer<typeof EvalCoverageSuiteDto>;

/** `GET /tasks/:id/eval-coverage`: the suites the task's change touched, with their results either side of it. */
export const TaskEvalCoverageDto = z.object({ suites: z.array(EvalCoverageSuiteDto) });
export type TaskEvalCoverageDto = z.infer<typeof TaskEvalCoverageDto>;
