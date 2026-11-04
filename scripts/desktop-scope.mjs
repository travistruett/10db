#!/usr/bin/env node
// Says whether the `desktop` job of .github/workflows/ci.yml has to run on a macOS runner: it
// prints and writes `desktop=true` or `desktop=false`. The paths that count are listed in
// docs/architecture/decisions/2026-11-04-desktop-runs-on-macos-only-when-its-files-change.md.
// The answer depends on the pull request's files and on nothing else, not even the event action: a
// title edit gets the decision of the last push, and a skipped job must never replace a red result.
// Only a pull_request event can skip the job. Whatever stops the files from being known, it runs.
// Usage: EVENT_NAME=<event> REPOSITORY=<owner>/<repo> PR_NUMBER=<n> GH_TOKEN=<token> \
//   [GITHUB_OUTPUT=<file>] node scripts/desktop-scope.mjs
// Always exits 0 when it could write the answer.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

// The pull request files API returns at most 3000 files; a list that long may be cut short.
const FILES_API_LIMIT = 3000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

// Paths the desktop job cannot read. Everything else counts as desktop, so a path nobody listed
// runs the job.
const SKIPPED_PREFIXES = ['docs/', '.github/', '.claude/', '.codex/', '.vscode/', 'scripts/'];
// Inside a skipped prefix, but read by the desktop job.
const DESKTOP_PREFIXES = ['scripts/release/'];
const DESKTOP_FILES = new Set([
  // The job's own definition, and the decision itself.
  '.github/workflows/ci.yml',
  'scripts/desktop-scope.mjs',
]);
// The one repo test the job runs, and what it imports; the rest of tests/repo/src is the gate's.
const DESKTOP_TEST_FILES = new Set([
  'tests/repo/src/self-update-real-processes.test.ts',
  'tests/repo/src/installed-app-sandbox.ts',
  'tests/repo/src/workspace.ts',
]);
// Files in the root that no job reads but the policy and gate ones.
const SKIPPED_ROOT_FILES = new Set(['LICENSE', 'NOTICE', 'renovate.json']);

/** True when a change to `path` can affect what the desktop job builds or tests. */
function affectsDesktop(path) {
  if (DESKTOP_FILES.has(path) || DESKTOP_TEST_FILES.has(path)) return true;
  if (DESKTOP_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  if (path.startsWith('tests/repo/src/')) return false;
  // A Markdown or licence file in the root.
  if (!path.includes('/') && (path.endsWith('.md') || SKIPPED_ROOT_FILES.has(path))) return false;
  return true;
}

/** The pull request's file names, or undefined when GitHub cannot say. */
function changedFiles(repository, number) {
  // A renamed file lists its old name too: a file moved out of apps/desktop changes the build.
  const names = '.[] | .filename, (.previous_filename // empty)';
  const result = spawnSync(
    'gh',
    ['api', '--paginate', `repos/${repository}/pulls/${number}/files?per_page=100`, '--jq', names],
    { encoding: 'utf8', maxBuffer: MAX_RESPONSE_BYTES },
  );
  if (result.status !== 0) {
    process.stderr.write(`gh api failed: ${result.stderr || String(result.error)}\n`);
    return undefined;
  }
  const files = result.stdout.split('\n').filter((line) => line !== '');
  return files.length === 0 || files.length >= FILES_API_LIMIT ? undefined : files;
}

function decide() {
  const { EVENT_NAME: event, REPOSITORY: repository, PR_NUMBER: number } = process.env;
  if (event !== 'pull_request') return `a ${event || 'unknown'} event always runs it`;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d+$/.test(number ?? '')) {
    return 'the pull request is not known';
  }
  const files = changedFiles(repository, number);
  if (files === undefined) return 'the pull request files could not be determined';
  const reason = files.find(affectsDesktop);
  if (reason !== undefined) return `${reason} can affect the desktop build`;
  return undefined;
}

const reason = decide();
const line = `desktop=${reason === undefined ? 'false' : 'true'}`;
process.stdout.write(
  `${line}${reason === undefined ? ': no changed file can affect it' : `: ${reason}`}\n`,
);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
