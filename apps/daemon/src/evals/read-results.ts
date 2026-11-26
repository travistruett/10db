import {
  EvalModelResultDto,
  EvalResultFormat,
  EvalRunSummaryDto,
  EvalSuiteKey,
} from '@10db/contracts';
import type { Git } from '../git';
import type { Logger } from '../log';
import { GateReport, gateReportTask, parseGateReport } from './gate-report';
import { LanePipelineReport, parseLanePipeline } from './lane-pipeline';
import { findEvalMarkers, type EvalMarkers } from './markers';
import { evalsDirs, findResultFiles } from './result-files';
import { runSummary, type ParsedRun } from './run-summary';

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

type SurveyGit = Pick<Git, 'survey' | 'commitAt'>;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown; // validated by the format's schema next
  } catch {
    return undefined;
  }
}

/** Whether a run and its suite key will pass the contracts they are answered under. */
function fitsContracts(key: string, run: ParsedRun): boolean {
  return (
    EvalSuiteKey.safeParse(key).success &&
    run.models.every((m) => EvalModelResultDto.safeParse(m).success) &&
    EvalRunSummaryDto.safeParse(runSummary(run)).success
  );
}

/**
 * Reads a repository's eval files at HEAD (the tracked list) and its result files from the checkout: a file that fails its
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
  const survey = await git.survey(repoPath, 0);
  if ('refused' in survey) return null;
  const results = await findResultFiles(repoPath, evalsDirs(survey.files));
  const cached = cache.get(repoPath, `${commit}:${results.signature}`);
  if (cached !== undefined) return cached;
  const tracked = findEvalMarkers(survey.files);
  const onDisk = findEvalMarkers(results.paths);
  const markers: EvalMarkers = { ...tracked, reports: onDisk.reports, baselines: onDisk.baselines };
  let skipped = results.skipped;
  const texts = new Map<string, string>();
  for (const path of results.paths) {
    const text = await results.read(path);
    if (text === null) {
      skipped += 1;
      logger.debug({ path }, 'eval result file not read');
    } else texts.set(path, text);
  }
  const runs = new Map<string, { format: EvalResultFormat; runs: ParsedRun[] }>();
  const add = (key: string, format: EvalResultFormat, run: ParsedRun): void => {
    if (!fitsContracts(key, run)) {
      skipped += 1;
      logger.debug({ path: run.path }, 'eval result file does not fit the contracts');
      return;
    }
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
  cache.set(repoPath, `${commit}:${results.signature}`, found);
  return found;
}

/** The last result read per checkout, kept while HEAD and the result files stay as they were read. */
export interface EvalsCache {
  get(repoPath: string, key: string): FoundEvals | undefined;
  set(repoPath: string, key: string, found: FoundEvals): void;
}

export function createEvalsCache(): EvalsCache {
  const held = new Map<string, { key: string; found: FoundEvals }>();
  return {
    get: (repoPath, key) => {
      const entry = held.get(repoPath);
      return entry?.key === key ? entry.found : undefined;
    },
    set: (repoPath, key, found) => {
      held.set(repoPath, { key, found });
    },
  };
}
