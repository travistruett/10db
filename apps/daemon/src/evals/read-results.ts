import { EvalResultFormat } from '@10db/contracts';
import type { Git } from '../git';
import type { Logger } from '../log';
import { GateReport, gateReportTask, parseGateReport } from './gate-report';
import { LanePipelineReport, parseLanePipeline } from './lane-pipeline';
import { findEvalMarkers, type EvalMarkers } from './markers';
import type { ParsedRun } from './run-summary';

/** The most bytes of one result file and of all of them. */
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 32_000_000;

/** One suite's runs, as read from the result files that name it. */
export interface FoundSuite {
  readonly key: string;
  readonly format: EvalResultFormat;
  /** Oldest first. */
  readonly runs: readonly ParsedRun[];
}

/** Everything a repository's HEAD shows of its evals. */
export interface FoundEvals {
  readonly commit: string;
  readonly tracked: ReadonlySet<string>;
  readonly markers: EvalMarkers;
  readonly suites: readonly FoundSuite[];
  /** Result files that did not parse and were left out. */
  readonly skipped: number;
}

type SurveyGit = Pick<Git, 'survey' | 'surveyTexts' | 'commitAt'>;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown; // validated by the format's schema next
  } catch {
    return undefined;
  }
}

/**
 * Reads a repository's eval result files at HEAD through git's object store: a file that fails its
 * format's schema is counted and left out, never thrown. Null when git won't read the repository.
 */
export async function readEvals(
  git: SurveyGit,
  repoPath: string,
  logger: Logger,
  cache: EvalsCache,
): Promise<FoundEvals | null> {
  const commit = await git.commitAt(repoPath, 'HEAD').catch(() => null);
  if (commit === null) return null;
  const cached = cache.get(repoPath, commit);
  if (cached !== undefined) return cached;
  const survey = await git.survey(repoPath, 0);
  if ('refused' in survey) return null;
  const markers = findEvalMarkers(survey.files);
  const wanted = [...markers.reports.map((r) => r.path), ...markers.baselines.map((b) => b.path)];
  const { texts } = await git.surveyTexts(repoPath, wanted, {
    maxBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
  });
  const runs = new Map<string, { format: EvalResultFormat; runs: ParsedRun[] }>();
  let skipped = 0;
  const add = (key: string, format: EvalResultFormat, run: ParsedRun): void => {
    const suite = runs.get(key) ?? { format, runs: [] };
    suite.runs.push(run);
    runs.set(key, suite);
  };
  const skip = (path: string, why: string): void => {
    skipped += 1;
    logger.debug({ path, why }, 'eval result file left out');
  };
  for (const report of markers.reports) {
    const parsed = GateReport.safeParse(parseJson(texts.get(report.path) ?? ''));
    if (!parsed.success) {
      skip(report.path, parsed.error.message.slice(0, 200));
      continue;
    }
    const key = gateReportTask(parsed.data) ?? report.folder;
    add(key, EvalResultFormat.GateReport, parseGateReport(parsed.data, report.path, report.at));
  }
  for (const baseline of markers.baselines) {
    const parsed = LanePipelineReport.safeParse(parseJson(texts.get(baseline.path) ?? ''));
    const run = parsed.success ? parseLanePipeline(parsed.data, baseline.path) : null;
    if (run === null) {
      skip(baseline.path, parsed.success ? 'no finish time' : parsed.error.message.slice(0, 200));
      continue;
    }
    add(
      `lane-pipeline:${parsed.success ? parsed.data.rigor : baseline.rigor}`,
      EvalResultFormat.LanePipeline,
      run,
    );
  }
  const suites = [...runs].map(([key, suite]) => ({
    key,
    format: suite.format,
    runs: suite.runs.sort((a, b) => a.at.localeCompare(b.at) || a.path.localeCompare(b.path)),
  }));
  const found = { commit, tracked: new Set(survey.files), markers, suites, skipped };
  cache.set(repoPath, found);
  return found;
}

/** The last result read per checkout, kept while HEAD stays where it was read. */
export interface EvalsCache {
  get(repoPath: string, commit: string): FoundEvals | undefined;
  set(repoPath: string, found: FoundEvals): void;
}

export function createEvalsCache(): EvalsCache {
  const held = new Map<string, FoundEvals>();
  return {
    get: (repoPath, commit) => {
      const found = held.get(repoPath);
      return found?.commit === commit ? found : undefined;
    },
    set: (repoPath, found) => {
      held.set(repoPath, found);
    },
  };
}
