import type { Git } from '../git';
import { valueCardOf } from '../test-value';
import { testBudgetLine } from './pr-text';

/*
 * CI's unit-test budget (`scripts/test-budget.mjs`, `tests/repo/src/test-budget.ts`) is counted again
 * here from the batch's own diff, so the pull request opens with the `Test-budget:` line that clears
 * it when the batch can honestly say why. The rules below are that check's; a test in
 * `test-budget-reason.test.ts` runs both over one diff.
 */

/** The fewest new unit tests any pull request may add, however little code it adds. */
const MIN_BUDGET = 3;
/** Added code lines that earn one more new unit test. */
const CODE_LINES_PER_TEST = 200;
/** Playwright's core flows never count against the budget. */
const E2E_PREFIX = 'apps/desktop/e2e/';
/** Core code, whose unit tests `.claude/rules/testing.md` asks for, so they never count. */
const CORE_PREFIXES = [
  'apps/daemon/src/guard/',
  'apps/daemon/src/sandbox/',
  'apps/daemon/src/permissions/',
  'apps/daemon/src/trust/',
  'apps/daemon/src/git/',
  'apps/daemon/src/recovery/',
  'apps/daemon/src/hazards/',
  'packages/db/src/migrations-',
  'tests/repo/src/git-guard',
];
const CORE_SUFFIX = '.seatbelt.test.ts';
const GENERATED_PREFIXES = [
  'packages/contracts/generated/',
  'packages/db/drizzle/',
  'apps/daemon/src/sessions/codex-generated/',
];
const TEST_PATH = /\.(test|spec)\.[cm]?tsx?$|(^|\/)(test|tests|e2e)\//;
const CODE_PATH = /\.([cm]?[jt]sx?|rs|sh|css)$/;
/** The files whose cases the budget counts. */
const UNIT_TEST_FILE = /\.test\.tsx?$/;
/** A line that opens a case: `it(`, `test(`, `it.each(…)(`, `it.skip(`, a tagged template row. */
const CASE_LINE = /^[+-]\s*(it|test)(\.\w+)*\s*[(`]/;

/** The file CI's budget check lives in; a project without it has no budget to clear. */
export const TEST_BUDGET_SCRIPT = 'scripts/test-budget.mjs';

const DIFF_BYTES = 1024 * 1024;
const REASON_MAX = 160;
const LINE_REASONS_MAX = 600;

const isExempt = (file: string): boolean =>
  file.startsWith(E2E_PREFIX) ||
  file.endsWith(CORE_SUFFIX) ||
  CORE_PREFIXES.some((prefix) => file.startsWith(prefix));

const isCountedTestFile = (file: string): boolean => UNIT_TEST_FILE.test(file) && !isExempt(file);

const isCode = (file: string): boolean =>
  !GENERATED_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
  CODE_PATH.test(file) &&
  !TEST_PATH.test(file);

/** Net new unit-test cases in a unified diff of test files, as CI counts them. */
export function countNewTests(diff: string): number {
  let file = '';
  let count = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice('+++ b/'.length) : '';
      continue;
    }
    if (line.startsWith('--- ') || isExempt(file)) continue;
    if (!CASE_LINE.test(line)) continue;
    count += line.startsWith('+') ? 1 : -1;
  }
  return count;
}

/** The unit tests a pull request adding `codeLines` code lines may add without saying why. */
export function unitTestBudget(codeLines: number): number {
  return Math.max(MIN_BUDGET, Math.floor(codeLines / CODE_LINES_PER_TEST));
}

/** What a value card's `why_new` must name: a core area (`.claude/rules/testing.md`) or an escaped bug. */
const NAMES_CORE_OR_BUG =
  /\b(?:core|escaped|bug|regression|git|guard|judge|sandbox\w*|permissions?|trust|claims?|recovery|merges?|pushes|worktrees?|migrations?|parsers?|rule tables?)\b/i;
const WHY_NEW = /\bwhy_new\s*[=:]\s*(.*?)\s*(?:;\s*no_claim\b|$)/is;

/**
 * The `why_new` of the value card a commit message carries, when it names a core area or an
 * escaped bug; null for no card, no `why_new`, or one that names neither (`none`, a feature).
 */
export function coreReasonOf(message: string): string | null {
  const reason = WHY_NEW.exec(valueCardOf(message) ?? '')?.[1]?.trim() ?? '';
  return NAMES_CORE_OR_BUG.test(reason) ? reason : null;
}

/** Net new cases in the counted test files `base..tip` changes; null when the diff was cut short. */
async function newTestsBetween(
  git: Pick<Git, 'diffSince'>,
  checkout: string,
  base: string,
  tip: string,
): Promise<number | null> {
  const files = (await git.diffSince(checkout, base, tip, 0)).files.map((file) => file.path);
  const only = files.filter(isCountedTestFile);
  if (only.length === 0) return 0;
  const read = await git.diffSince(checkout, base, tip, DIFF_BYTES, { only });
  return read.truncated ? null : countNewTests(read.diff);
}

/**
 * The `Test-budget:` line for a batch whose new unit tests are over CI's budget when every commit
 * that adds one carries a value card whose `why_new` names a core area or an escaped bug, summing
 * those reasons up; null when it is within budget, when some such commit has no such card, or when
 * a diff was too long to count (CI's check then decides, as it does without a line).
 */
export async function autoTestBudgetLine(
  git: Pick<Git, 'commitMessagesSince' | 'diffSince'>,
  checkout: string,
  base: string,
  tip: string,
): Promise<string | null> {
  const added = await newTestsBetween(git, checkout, base, tip);
  if (added === null || added <= MIN_BUDGET) return null;
  const whole = await git.diffSince(checkout, base, tip, 0);
  const codeLines = whole.files
    .filter((file) => isCode(file.path))
    .reduce((sum, file) => sum + (file.added ?? 0), 0);
  const budget = unitTestBudget(codeLines);
  if (added <= budget) return null;
  const reasons = new Set<string>();
  for (const commit of await git.commitMessagesSince(checkout, base, tip)) {
    const [parent, ...others] = commit.parents;
    if (parent === undefined || others.length > 0) continue;
    const net = await newTestsBetween(git, checkout, parent, commit.sha);
    if (net === null) return null;
    if (net <= 0) continue;
    const reason = coreReasonOf(commit.message);
    if (reason === null) return null;
    reasons.add(reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 1)}…` : reason);
  }
  if (reasons.size === 0) return null;
  const summary = [...reasons].join('; ');
  const clipped =
    summary.length > LINE_REASONS_MAX ? `${summary.slice(0, LINE_REASONS_MAX - 1)}…` : summary;
  return testBudgetLine(
    `${String(added)} new unit tests against a budget of ${String(budget)}, each added with a value card naming a core area or an escaped bug: ${clipped}`,
  );
}
