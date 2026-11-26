import {
  EvalCoverageState,
  type EvalCoverageDetail,
  type EvalCoverageSideDto,
  type EvalCoverageSnapshot,
  type HazardDef,
} from '@10db/contracts';
import { classifyPath } from '../guard';
import type { ParsedRun } from './run-summary';

/** What a suite's manifest entry gives a run to be matched against, as the manifest stood. */
export function snapshotsOf(
  suites: readonly {
    readonly key: string;
    readonly label?: string | undefined;
    readonly coveredPaths: readonly string[];
    readonly liveCommand?: string | undefined;
  }[],
): EvalCoverageSnapshot[] {
  return suites
    .filter((s) => s.coveredPaths.length > 0)
    .map((s) => ({
      key: s.key,
      label: s.label ?? s.key,
      coveredPaths: [...s.coveredPaths],
      liveCommand: s.liveCommand ?? null,
    }));
}

/** The changed files each suite's covered globs hold, as a hazard's globs hold them; a suite holding none is left out. */
export function matchedSuites(
  files: readonly string[],
  suites: readonly EvalCoverageSnapshot[],
): { key: string; paths: string[]; lastBefore: null }[] {
  const out: { key: string; paths: string[]; lastBefore: null }[] = [];
  for (const suite of suites) {
    const probe: HazardDef = { name: suite.key, globs: [...suite.coveredPaths], commands: [] };
    const paths = files.filter((f) => classifyPath(f, [], [probe]).hazards.length > 0);
    if (paths.length > 0) out.push({ key: suite.key, paths, lastBefore: null });
  }
  return out;
}

const timeOf = (iso: string): number => Date.parse(iso);

/** One result as a task's before or after shows it. */
export function sideOf(run: ParsedRun): EvalCoverageSideDto {
  return {
    path: run.path,
    at: run.at,
    passed: run.passed,
    fingerprint: run.fingerprint,
    models: run.models.map((m) => ({ model: m.model, passed: m.passed })),
  };
}

/**
 * Where a task's covered suite stands, from the suite's runs (any order) and the times of the task's branch
 * point and last commit. Before is the newest run older than the branch point; after is the first run newer
 * than the last commit. Results live in the builder's checkout, not at commits, so the tie is by time.
 * A run graded against a different dataset than before's is `eval_changed`, never a regression.
 */
export function coverageOf(input: {
  readonly runs: readonly ParsedRun[];
  readonly baseAt: string | null;
  readonly headAt: string | null;
}): {
  state: EvalCoverageState;
  before: ParsedRun | null;
  after: ParsedRun | null;
} {
  const ordered = [...input.runs].sort((a, b) => timeOf(a.at) - timeOf(b.at));
  const base = input.baseAt === null ? null : timeOf(input.baseAt);
  const head = input.headAt === null ? null : timeOf(input.headAt);
  const before = base === null ? null : (ordered.filter((r) => timeOf(r.at) < base).at(-1) ?? null);
  const after = head === null ? null : (ordered.find((r) => timeOf(r.at) > head) ?? null);
  if (after === null) return { state: EvalCoverageState.NotRun, before, after };
  if (before !== null && before.fingerprint !== after.fingerprint)
    return { state: EvalCoverageState.EvalChanged, before, after };
  if (after.passed) return { state: EvalCoverageState.Passing, before, after };
  const passedBefore = new Set(before?.models.filter((m) => m.passed).map((m) => m.model));
  const regressedModel = after.models.some((m) => !m.passed && passedBefore.has(m.model));
  const regressed = regressedModel || (before?.passed === true && after.models.length === 0);
  return {
    state: regressed ? EvalCoverageState.Regressed : EvalCoverageState.Failing,
    before,
    after,
  };
}

/** The most files one line names. */
const LINE_FILES = 3;

/**
 * One line per touched suite for the run's Inbox card: the changed code, that the suite hasn't run on it, what it
 * last showed before, and the live command to run in the checkout.
 */
export function coverageLines(detail: EvalCoverageDetail): string[] {
  const named = new Map(detail.suites.map((s) => [s.key, s]));
  return (detail.matched ?? []).map((m) => {
    const files = m.paths.slice(0, LINE_FILES).join(', ');
    const more =
      m.paths.length > LINE_FILES ? ` and ${String(m.paths.length - LINE_FILES)} more` : '';
    const suite = named.get(m.key);
    const command = suite?.liveCommand ?? null;
    return `Changes ${files}${more}; ${suite?.label ?? m.key} hasn't run on this; last before: ${m.lastBefore ?? 'no result'}.${command === null ? '' : ` Run: ${command}`}`;
  });
}
