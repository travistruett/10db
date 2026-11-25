/** A gate report file: `evals/reports/<task>/<UTC timestamp>.json`. */
export interface ReportMarker {
  readonly path: string;
  /** The folder name, the suite key when the report names no task of its own. */
  readonly folder: string;
  /** The run's time, from the file name. */
  readonly at: string;
}

/** A lane-pipeline baseline: `evals/lane-pipeline/baselines/<rigor>.json`. */
export interface BaselineMarker {
  readonly path: string;
  readonly rigor: string;
}

/** The files of a repository that say something about its evals. */
export interface EvalMarkers {
  readonly reports: readonly ReportMarker[];
  readonly baselines: readonly BaselineMarker[];
  /** Eval definition files found by name. */
  readonly definitions: readonly string[];
  /** `claude plugin eval` cases (`<evals dir>/<case>/prompt.md`) by their evals directory. */
  readonly promptCases: ReadonlyMap<string, readonly string[]>;
}

const REPORT =
  /(?:^|\/)evals\/reports\/([^/]+)\/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d+)Z\.json$/u;
const BASELINE = /(?:^|\/)evals\/lane-pipeline\/baselines\/([^/]+)\.json$/u;
const DEFINITION = /(?:^|\/)evals\/([^/]+)\/([^/]+)\.py$/u;
const TEST_EVAL = /(?:^|\/)tests\/eval\/test_[^/]*_eval\.py$/u;
const PROMPT_CASE = /^((?:.*\/)?evals)\/([^/]+)\/prompt\.md$/u;

/** The ISO time a report's file name holds; the digits after the seconds are a fraction of one. */
function reportTime(m: RegExpExecArray): string {
  const [, , year, month, day, hour, minute, second, fraction] = m;
  const millis = `${fraction ?? ''}000`.slice(0, 3);
  return `${year ?? ''}-${month ?? ''}-${day ?? ''}T${hour ?? ''}:${minute ?? ''}:${second ?? ''}.${millis}Z`;
}

function isDefinition(path: string): boolean {
  const named = DEFINITION.exec(path);
  if (named === null) return TEST_EVAL.test(path);
  const [, area = '', name = ''] = named;
  if (name === '__init__' || name.startsWith('_')) return false;
  return area !== 'reports' && !area.endsWith('.recorded');
}

/** What a tracked path list says about a repository's evals: result files and definition files, by name alone. */
export function findEvalMarkers(tracked: readonly string[]): EvalMarkers {
  const reports: ReportMarker[] = [];
  const baselines: BaselineMarker[] = [];
  const definitions: string[] = [];
  const promptCases = new Map<string, string[]>();
  for (const path of tracked) {
    const report = REPORT.exec(path);
    if (report !== null) {
      reports.push({ path, folder: report[1] ?? '', at: reportTime(report) });
      continue;
    }
    const baseline = BASELINE.exec(path);
    if (baseline !== null) {
      baselines.push({ path, rigor: baseline[1] ?? '' });
      continue;
    }
    const prompt = PROMPT_CASE.exec(path);
    if (prompt !== null && prompt[2] !== 'reports' && prompt[2] !== 'lane-pipeline') {
      const dir = prompt[1] ?? '';
      promptCases.set(dir, [...(promptCases.get(dir) ?? []), path]);
      continue;
    }
    if (isDefinition(path)) definitions.push(path);
  }
  return { reports, baselines, definitions, promptCases };
}
