import { EvalSuiteKey } from '@10db/contracts';
import type {
  EvalFlakyCaseDto,
  EvalManifestSuite,
  EvalResultFormat,
  EvalsDto,
  EvalSuiteDetailDto,
  EvalSuiteDto,
  EvalTrendPointDto,
  StoredEvalManifest,
} from '@10db/contracts';
import type { FoundEvals } from './read-results';
import { runSummary, type ParsedRun } from './run-summary';

/** Runs a trend and the flaky-case count look back over. */
const RECENT_RUNS = 8;
const MAX_FLAKY = 10;

/** A suite before the manifest is laid over it. */
interface Candidate {
  readonly key: string;
  readonly format: EvalResultFormat | null;
  /** Oldest first. */
  readonly runs: readonly ParsedRun[];
  readonly definitionPaths: readonly string[];
}

function candidates(found: FoundEvals, manifest: StoredEvalManifest | null): Candidate[] {
  const out = new Map<string, Candidate>();
  for (const suite of found.suites) {
    out.set(suite.key, { ...suite, definitionPaths: [] });
  }
  for (const [dir, paths] of found.markers.promptCases) {
    const key = `plugin-eval:${dir}`;
    if (!EvalSuiteKey.safeParse(key).success) continue;
    out.set(key, { key, format: null, runs: [], definitionPaths: [...paths].sort() });
  }
  for (const suite of manifest?.manifest.suites ?? []) {
    if (!out.has(suite.key))
      out.set(suite.key, { key: suite.key, format: null, runs: [], definitionPaths: [] });
  }
  return [...out.values()];
}

const manifestSuite = (
  manifest: StoredEvalManifest | null,
  key: string,
): EvalManifestSuite | undefined => manifest?.manifest.suites.find((s) => s.key === key);

/** The last runs as trend points: a run whose fingerprint differs from the run before it graded another eval. */
function trendOf(runs: readonly ParsedRun[]): EvalTrendPointDto[] {
  return runs.map((run, i) => {
    const before = runs[i - 1]?.fingerprint ?? null;
    return {
      passed: run.passed,
      evalChanged: before !== null && run.fingerprint !== null && before !== run.fingerprint,
    };
  });
}

/** When each suite's definition was last committed, by key, as the service read it. */
export type DefinitionTimes = ReadonlyMap<string, string>;

/** How long after a run its definition may be committed and still count as the eval that ran: run, then commit. */
const COMMIT_GRACE_MS = 12 * 60 * 60 * 1000;

function changedSince(latest: string | undefined, committed: string | undefined): string | null {
  if (latest === undefined || committed === undefined) return null;
  return Date.parse(committed) - Date.parse(latest) > COMMIT_GRACE_MS ? committed : null;
}

function suiteDto(
  c: Candidate,
  manifest: StoredEvalManifest | null,
  times: DefinitionTimes,
): EvalSuiteDto {
  const named = manifestSuite(manifest, c.key);
  const newest = c.runs.at(-1);
  return {
    key: c.key,
    label: named?.label ?? c.key,
    bar: named?.bar ?? null,
    definitionPaths: [...new Set([...c.definitionPaths, ...(named?.definitionPaths ?? [])])].sort(),
    format: c.format,
    runCount: c.runs.length,
    latest:
      newest === undefined
        ? null
        : { path: newest.path, at: newest.at, passed: newest.passed, models: [...newest.models] },
    trend: trendOf(c.runs).slice(-RECENT_RUNS),
    definitionChangedAt: changedSince(newest?.at, times.get(c.key)),
  };
}

/** Failing latest first, then passing, then no results; ties by key. */
const rank = (s: EvalSuiteDto): number => (s.latest === null ? 2 : s.latest.passed ? 1 : 0);

/** What 10db has found of a project's evals, the manifest laid over it. */
export function buildEvals(
  found: FoundEvals | null,
  manifest: StoredEvalManifest | null,
  times: DefinitionTimes = new Map(),
): EvalsDto {
  const suites = (found === null ? [] : candidates(found, manifest))
    .map((c) => suiteDto(c, manifest, times))
    .sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
  const linked = new Set(suites.flatMap((s) => s.definitionPaths));
  return {
    commit: found?.commit ?? null,
    assessedAt: manifest?.assessedAt ?? null,
    suites,
    unlinked: (found?.markers.definitions ?? []).filter((p) => !linked.has(p)).sort(),
    gaps: manifest?.manifest.gaps ?? null,
  };
}

/** Cases that both passed and failed a trial across the recent runs, the most failed first. */
function flakyCases(runs: readonly ParsedRun[]): EvalFlakyCaseDto[] {
  const total = new Map<string, { trials: number; failed: number }>();
  for (const run of runs.slice(-RECENT_RUNS)) {
    for (const c of run.cases) {
      const seen = total.get(c.name) ?? { trials: 0, failed: 0 };
      seen.trials += c.trials;
      seen.failed += c.failed;
      total.set(c.name, seen);
    }
  }
  return [...total]
    .filter(([, t]) => t.failed > 0 && t.failed < t.trials)
    .map(([name, t]) => ({ name, failed: t.failed, trials: t.trials }))
    .sort((a, b) => b.failed - a.failed || a.name.localeCompare(b.name))
    .slice(0, MAX_FLAKY);
}

export type SuiteDetailResult =
  | { readonly kind: 'ok'; readonly detail: EvalSuiteDetailDto }
  | { readonly kind: 'no_suite' }
  | { readonly kind: 'no_run' };

/** A suite's drawer: its runs newest first, the run asked for (the newest by default) whole. */
export function buildSuiteDetail(
  found: FoundEvals | null,
  manifest: StoredEvalManifest | null,
  key: string,
  runPath: string | undefined,
  times: DefinitionTimes = new Map(),
): SuiteDetailResult {
  const c = found === null ? undefined : candidates(found, manifest).find((s) => s.key === key);
  if (c === undefined) return { kind: 'no_suite' };
  const shown = runPath === undefined ? c.runs.at(-1) : c.runs.find((r) => r.path === runPath);
  if (runPath !== undefined && shown === undefined) return { kind: 'no_run' };
  const named = manifestSuite(manifest, key);
  return {
    kind: 'ok',
    detail: {
      suite: suiteDto(c, manifest, times),
      runs: [...c.runs].reverse().map(runSummary),
      run:
        shown === undefined
          ? null
          : {
              path: shown.path,
              at: shown.at,
              passed: shown.passed,
              fingerprint: shown.fingerprint,
              repeat: shown.repeat,
              models: [...shown.models],
            },
      flaky: flakyCases(c.runs),
      coveredPaths: named?.coveredPaths ?? [],
      freeCommand: named?.freeCommand ?? null,
      liveCommand: named?.liveCommand ?? null,
    },
  };
}
