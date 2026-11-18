#!/usr/bin/env node
// Fails a pull request that adds more unit tests than its budget, unless its body has a line
// `Test-budget: <reason>`
// (docs/architecture/decisions/2026-11-18-a-pull-request-over-its-unit-test-budget-says-why.md).
// Usage: PR_BODY=<body> node scripts/test-budget.mjs
// Run in the checkout of a pull request's merge commit, with its first parent fetched.
import { spawnSync } from 'node:child_process';
import { checkTestBudget } from '../tests/repo/src/test-budget.ts';
import { classifyPath, parseNumstat } from '../tests/repo/src/test-report.ts';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function run(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
  if (result.status === 0) return result.stdout;
  process.stderr.write(`git ${args.join(' ')}: ${result.stderr || String(result.error)}\n`);
  process.stdout.write('::error::The unit-test budget check could not read the diff from git.\n');
  process.exit(1);
}

const diff = run([
  'diff',
  '-U0',
  '--no-renames',
  'HEAD^1',
  'HEAD',
  '--',
  '*.test.ts',
  '*.test.tsx',
]);
const numstat = run(['diff', '-z', '--numstat', '-M', 'HEAD^1', 'HEAD']);
const codeLines = parseNumstat(numstat)
  .filter(({ path }) => classifyPath(path) === 'code')
  .reduce((sum, { added }) => sum + added, 0);
const result = checkTestBudget({ diff, codeLines, body: process.env.PR_BODY ?? '' });
if (result.ok) {
  process.stdout.write(`${result.message}\n`);
} else {
  process.stdout.write(`::error::${result.message.replaceAll('\n', '%0A')}\n`);
  process.exit(1);
}
