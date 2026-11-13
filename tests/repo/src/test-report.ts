import { z } from 'zod';

/** Starts the pull request comment, so a later run finds and updates that one comment. */
export const COMMENT_MARKER = '<!-- 10db:test-report -->';

const MAX_ROWS = 10;
const GENERATED_PREFIXES = [
  'packages/contracts/generated/',
  'packages/db/drizzle/',
  'apps/daemon/src/sessions/codex-generated/',
];
const TEST_PATH = /\.(test|spec)\.[cm]?tsx?$|(^|\/)(test|tests|e2e)\//;
const CODE_PATH = /\.([cm]?[jt]sx?|rs|sh|css)$/;

/** What one test shard ran. Read back from a CI artifact, so it is parsed. */
export const ShardTimings = z.object({
  shard: z.object({ index: z.number().int().positive(), count: z.number().int().positive() }),
  files: z.array(
    z.object({
      file: z.string(),
      tests: z.number().int().nonnegative(),
      seconds: z.number().nonnegative(),
    }),
  ),
});
export type ShardTimings = z.infer<typeof ShardTimings>;

/** One file of the pull request's diff against its base. */
export interface DiffEntry {
  readonly path: string;
  readonly added: number;
  /** The path it was renamed from. */
  readonly oldPath?: string;
}

export type PathKind = 'test' | 'code' | 'other';

interface FileChange {
  readonly file: string;
  readonly tests: number;
  readonly seconds: number;
}

/** Why the report has no comparison: no timings from `main`, or too few shards reported. */
type Missing = 'baseline' | { readonly reported: number; readonly expected: number | null } | null;

export interface Report {
  readonly tests: { readonly added: number } | null;
  readonly seconds: { readonly added: number } | null;
  readonly rows: readonly FileChange[];
  readonly lines: { readonly test: number; readonly code: number };
  readonly missing: Missing;
  /** Touched test files left out, because `main` changed them after the baseline. */
  readonly stale: number;
}

/** Whether a line added to `path` counts as test, as code, or as neither. */
export function classifyPath(path: string): PathKind {
  if (GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'other';
  if (!CODE_PATH.test(path)) return 'other';
  return TEST_PATH.test(path) ? 'test' : 'code';
}

/**
 * Parses `git diff -z --numstat -M`. A file is `added<TAB>deleted<TAB>path<NUL>`; a rename leaves
 * the path empty and follows it with the old and new paths. A binary file gives `-` for its counts.
 */
export function parseNumstat(output: string): DiffEntry[] {
  const fields = output.split('\0');
  const entries: DiffEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const [added = '', , path = ''] = (fields[index] ?? '').split('\t');
    if (added === '') continue;
    const count = added === '-' ? 0 : Number(added);
    if (path !== '') {
      entries.push({ path, added: count });
      continue;
    }
    const oldPath = fields[index + 1] ?? '';
    const newPath = fields[index + 2] ?? '';
    index += 2;
    entries.push({ path: newPath, added: count, oldPath });
  }
  return entries;
}

function byFile(shards: readonly ShardTimings[]): Map<string, { tests: number; seconds: number }> {
  const files = new Map<string, { tests: number; seconds: number }>();
  for (const { file, tests, seconds } of shards.flatMap((shard) => shard.files)) {
    const seen = files.get(file) ?? { tests: 0, seconds: 0 };
    files.set(file, { tests: seen.tests + tests, seconds: seen.seconds + seconds });
  }
  return files;
}

/** Sums of seconds pick up binary rounding that would otherwise reach the comment. */
const rounded = (seconds: number): number => Math.round(seconds * 1000) / 1000;

function missingFrom(
  current: readonly ShardTimings[],
  baseline: readonly ShardTimings[] | null,
): Missing {
  const expected = current[0]?.shard.count ?? null;
  if (expected === null || new Set(current.map(({ shard }) => shard.index)).size < expected) {
    return { reported: current.length, expected };
  }
  return baseline === null ? 'baseline' : null;
}

/**
 * Compares a pull request with `baseline`, the timings of an earlier commit on `main`. Tests and
 * seconds cover only the test files the pull request touched, because the whole suite's seconds
 * move by more between two runs of the same code than one pull request adds. `movedOnMain` lists
 * what changed between the baseline and the base: comparing those files would charge the pull
 * request for what merged since, so they are left out.
 */
export function buildReport(input: {
  readonly current: readonly ShardTimings[];
  readonly baseline: readonly ShardTimings[] | null;
  readonly diff: readonly DiffEntry[];
  readonly movedOnMain?: readonly string[];
}): Report {
  const { current, baseline, diff, movedOnMain = [] } = input;
  const lines = { test: 0, code: 0 };
  for (const { path, added } of diff) {
    const kind = classifyPath(path);
    if (kind !== 'other') lines[kind] += added;
  }
  const missing = missingFrom(current, baseline);
  if (missing !== null || baseline === null) {
    return { tests: null, seconds: null, rows: [], lines, missing, stale: 0 };
  }
  const now = byFile(current);
  const before = byFile(baseline);
  const moved = new Set(movedOnMain);
  let stale = 0;
  const rows = diff.flatMap(({ path, oldPath }) => {
    const after = now.get(path);
    const earlier = before.get(oldPath ?? path);
    if (after === undefined && earlier === undefined) return [];
    if (moved.has(path) || moved.has(oldPath ?? path)) {
      stale += 1;
      return [];
    }
    const tests = (after?.tests ?? 0) - (earlier?.tests ?? 0);
    const seconds = rounded((after?.seconds ?? 0) - (earlier?.seconds ?? 0));
    return tests === 0 && seconds === 0 ? [] : [{ file: path, tests, seconds }];
  });
  rows.sort((a, b) => Math.abs(b.seconds) - Math.abs(a.seconds) || (a.file < b.file ? -1 : 1));
  return {
    tests: { added: rows.reduce((sum, row) => sum + row.tests, 0) },
    seconds: { added: rounded(rows.reduce((sum, row) => sum + row.seconds, 0)) },
    rows,
    lines,
    missing,
    stale,
  };
}

const signed = (value: number, text: string): string => (value > 0 ? `+${text}` : text);
const signedSeconds = (seconds: number): string => signed(seconds, `${seconds.toFixed(1)} s`);
const codeSpan = (file: string): string =>
  `\`${file.replaceAll('`', "'").replaceAll('|', '/').replaceAll('\n', ' ')}\``;

function ratio({ test, code }: Report['lines']): string {
  if (test === 0 && code === 0) return 'none';
  if (code === 0) return `${String(test)} test, 0 code`;
  return `${(test / code).toFixed(2)} (${String(test)} test, ${String(code)} code)`;
}

function why(missing: Missing): string | null {
  if (missing === null) return null;
  if (missing === 'baseline') return 'No usable timings from `main`, so nothing is compared.';
  if (missing.expected === null) return 'No test shard reported, so nothing is compared.';
  return `Only ${String(missing.reported)} of ${String(missing.expected)} test shards reported, so nothing is compared.`;
}

/** The comment's Markdown. `baselineSha` is the commit on `main` the report compared with. */
export function renderReport(report: Report, baselineSha: string | null): string {
  const { tests, seconds, rows, lines, missing, stale } = report;
  const summary = [
    COMMENT_MARKER,
    '### Tests in this pull request',
    '',
    '| | |',
    '| --- | --- |',
    `| Tests added | ${tests === null ? 'not compared' : signed(tests.added, String(tests.added))} |`,
    `| Seconds added | ${seconds === null ? 'not compared' : signedSeconds(seconds.added)} |`,
    `| Test lines per code line | ${ratio(lines)} |`,
    '',
  ];
  const left = rows.length - MAX_ROWS;
  const table =
    rows.length === 0
      ? []
      : [
          '| File | Tests | Seconds |',
          '| --- | ---: | ---: |',
          ...rows
            .slice(0, MAX_ROWS)
            .map(
              ({ file, tests: added, seconds: slower }) =>
                `| ${codeSpan(file)} | ${signed(added, String(added))} | ${signedSeconds(slower)} |`,
            ),
          '',
          ...(left > 0 ? [`and ${String(left)} more file${left === 1 ? '' : 's'}.`, ''] : []),
        ];
  const reason = why(missing);
  const sha = tests === null || baselineSha === null ? null : codeSpan(baselineSha);
  const compared = sha === null ? '' : ` against ${sha} on \`main\``;
  const leftOut =
    stale === 0 || sha === null
      ? []
      : [
          `${String(stale)} touched test ${stale === 1 ? 'file is' : 'files are'} left out: ${stale === 1 ? 'it' : 'they'} changed on \`main\` after ${sha}.`,
          '',
        ];
  const note =
    `Counts and seconds cover the Vitest files this pull request touched${compared}. ` +
    'Seconds vary between runs. Lines cover every test and code file. This blocks nothing.';
  const notes = [...(reason === null ? [] : [reason, '']), ...leftOut, note, ''];
  return [...summary, ...table, ...notes].join('\n');
}
