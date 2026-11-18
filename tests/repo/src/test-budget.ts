/** The fewest new unit tests any pull request may add, however little code it adds. */
const MIN_BUDGET = 3;
/** Added code lines that earn one more new unit test. */
const CODE_LINES_PER_TEST = 200;
/** Playwright's core flows are the main check, so their specs never count against the budget. */
const E2E_PREFIX = 'apps/desktop/e2e/';
/**
 * Core code, whose unit tests `.claude/rules/testing.md` asks for, so they never count against the
 * budget: the guard, sandboxes, permissions, trust, git, recovery and claims, and migrations.
 */
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

function isExempt(file: string): boolean {
  return (
    file.startsWith(E2E_PREFIX) ||
    file.endsWith(CORE_SUFFIX) ||
    CORE_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
}
/** A line that opens a case: `it(`, `test(`, `it.each(…)(`, `it.skip(`, a tagged template row. */
const CASE_LINE = /^[+-]\s*(it|test)(\.\w+)*\s*[(`]/;
const REASON_LINE = /^Test-budget:[ \t]*\S/m;

export interface TestBudgetResult {
  readonly ok: boolean;
  /** New cases net of removed ones; negative when the pull request removes more than it adds. */
  readonly added: number;
  readonly budget: number;
  readonly message: string;
}

/**
 * Net new unit-test cases in `git diff -U0 --no-renames <base> <head> -- '*.test.ts' '*.test.tsx'`.
 * An `it.each` table counts as one case.
 */
export function countTestCases(diff: string): number {
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

export function testBudget(codeLines: number): number {
  return Math.max(MIN_BUDGET, Math.floor(codeLines / CODE_LINES_PER_TEST));
}

/** Whether the pull request body has a line `Test-budget: <reason>`. */
export function hasReason(body: string): boolean {
  return REASON_LINE.test(body.replaceAll('\r\n', '\n'));
}

/**
 * Checks a pull request's new unit tests against its budget. `codeLines` is the lines it adds to
 * files `classifyPath` calls code; `body` is the pull request body, null when empty.
 */
export function checkTestBudget(input: {
  readonly diff: string;
  readonly codeLines: number;
  readonly body: string | null;
}): TestBudgetResult {
  const { codeLines } = input;
  const added = countTestCases(input.diff);
  const budget = testBudget(codeLines);
  const counted = `adds ${String(added)} unit tests; its budget is ${String(budget)} (max of ${String(MIN_BUDGET)} and one per ${String(CODE_LINES_PER_TEST)} added code lines: ${String(codeLines)})`;
  if (added <= budget) return { ok: true, added, budget, message: `This pull request ${counted}.` };
  if (hasReason(input.body ?? '')) {
    return {
      ok: true,
      added,
      budget,
      message: `This pull request ${counted}, and its body says why.`,
    };
  }
  return {
    ok: false,
    added,
    budget,
    message: [
      `This pull request ${counted}.`,
      'Add a line starting `Test-budget: <reason>` to the pull request body and save it; the check reruns on the edit. A 10db lane puts that line in the message of the commit that adds the tests.',
      'Playwright e2e specs and tests of core code (guard, sandbox, permissions, trust, git, recovery, claims, migrations) do not count.',
    ].join('\n'),
  };
}
