#!/usr/bin/env node
// Fails a pull request that adds more unit tests than its budget, unless its body has a line
// `Test-budget: <reason>`
// (docs/architecture/decisions/2026-11-18-a-pull-request-over-its-unit-test-budget-says-why.md).
// Usage: PR_BODY=<body> node scripts/test-budget.mjs
//   Run in the checkout of a pull request's merge commit, with its first parent fetched.
// Usage: node scripts/test-budget.mjs --warn
//   The pre-push hook's form: counts the branch against its merge base with origin/main and only
//   prints, so whoever opens the pull request can put the reason in its body before CI asks. It
//   never fails a push.
import { spawnSync } from 'node:child_process';
import { checkTestBudget } from '../tests/repo/src/test-budget.ts';
import { classifyPath, parseNumstat } from '../tests/repo/src/test-report.ts';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const warn = process.argv.includes('--warn');

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
  if (result.status === 0) return result.stdout;
  if (warn) process.exit(0);
  process.stderr.write(`git ${args.join(' ')}: ${result.stderr || String(result.error)}\n`);
  process.stdout.write('::error::The unit-test budget check could not read the diff from git.\n');
  process.exit(1);
}

const base = warn ? git(['merge-base', 'origin/main', 'HEAD']).trim() : 'HEAD^1';
const diff = git(['diff', '-U0', '--no-renames', base, 'HEAD', '--', '*.test.ts', '*.test.tsx']);
const numstat = git(['diff', '-z', '--numstat', '-M', base, 'HEAD']);
const codeLines = parseNumstat(numstat)
  .filter(({ path }) => classifyPath(path) === 'code')
  .reduce((sum, { added }) => sum + added, 0);
const result = checkTestBudget({
  diff,
  codeLines,
  body: warn ? null : (process.env.PR_BODY ?? ''),
});

if (warn) {
  if (!result.ok) {
    process.stdout.write(
      `test budget: ${result.message.split('\n')[0]}\nPut a line \`Test-budget: <reason>\` in the pull request body when you open it, or drop the tests that guard neither core nor an escaped bug.\n`,
    );
  }
} else if (result.ok) {
  process.stdout.write(`${result.message}\n`);
} else {
  process.stdout.write(`::error::${result.message.replaceAll('\n', '%0A')}\n`);
  process.exit(1);
}
