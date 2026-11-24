#!/usr/bin/env node
// Says whether the `desktop` job of .github/workflows/ci.yml has to run on a macOS runner: it
// prints and writes `desktop=true` or `desktop=false`. Only the paths listed below count, as
// docs/architecture/decisions/2026-11-18-desktop-runs-on-macos-only-for-what-it-tests.md says: a
// change whose files are all unlisted skips the job. The answer depends on the change's files and on
// nothing else, not even the event action: a title edit gets the decision of the last push, and a
// skipped job must never replace a red result. The change is a pull request's files, or, on a push,
// the files of the commits `BEFORE..AFTER` (a squash merge makes that the pull request's diff). Any
// other event (merge_group, workflow_dispatch), and whatever stops the files from being known (a
// force push, a missing or zero `BEFORE`, a failed lookup), runs the job.
// Usage: EVENT_NAME=<event> REPOSITORY=<owner>/<repo> GH_TOKEN=<token> \
//   PR_NUMBER=<n> | BEFORE=<sha> AFTER=<sha>  [GITHUB_OUTPUT=<file>] node scripts/desktop-scope.mjs
// Always exits 0 when it could write the answer.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

// The pull request files API returns at most 3000 files; a list that long may be cut short.
const FILES_API_LIMIT = 3000;
// The compare API lists files on its first page only (later pages fail the lookup) and stops at 300, so a
// list that long may be cut short. Its commit list is paged too: a push of more than 100 commits is unknown.
const COMPARE_FILES_LIMIT = 300;
const COMPARE_COMMITS_LIMIT = 100;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

// Everything under these is what the job builds or tests on macOS.
const DESKTOP_PREFIXES = [
  // The Tauri shell: make rust-check and tauri build.
  'apps/desktop/src-tauri/',
  // The modules the Seatbelt and macOS-only daemon tests exercise; gate-sandbox.seatbelt runs the
  // gate runner in src/verify.
  'apps/daemon/src/sandbox/',
  'apps/daemon/src/guard/',
  'apps/daemon/src/keep-awake/',
  'apps/daemon/src/verify/',
  // install-app.sh and installed-app.sh, which the self-update test runs.
  'scripts/release/',
];
// Every Seatbelt test in the daemon, including one the job's vitest line does not name yet.
const SEATBELT_TEST = /^apps\/daemon\/test\/[^/]+\.seatbelt\.test\.ts$/;
const DESKTOP_FILES = new Set([
  // The job's own definition, and the decision itself.
  '.github/workflows/ci.yml',
  'scripts/desktop-scope.mjs',
  // What the install and the toolchain come from.
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'mise.toml',
  'mise.lock',
  'rust-toolchain.toml',
  'Makefile',
  // The desktop build tauri build runs: its frontend build and the daemon sidecar.
  'apps/desktop/package.json',
  'apps/desktop/vite.config.ts',
  'apps/desktop/postcss.config.cjs',
  'apps/desktop/index.html',
  'apps/desktop/tsconfig.json',
  'apps/desktop/scripts/prepare-sidecar.ts',
  'apps/daemon/package.json',
  'apps/daemon/vitest.config.ts',
  'apps/daemon/scripts/build.ts',
  // Daemon modules the job's tests name, and the macOS paths and tools they reach first.
  'apps/daemon/src/git/lane-writable.ts',
  'apps/daemon/src/git/lane-writable.test.ts',
  'apps/daemon/src/git/run-as-builder.ts',
  'apps/daemon/src/session-setup/builder-skills.ts',
  'apps/daemon/src/session-setup/builder-skills.test.ts',
  'apps/daemon/src/environment/pinned-install.ts',
  'apps/daemon/src/environment/pinned-install.test.ts',
  'apps/daemon/src/environment/agent-pins.ts',
  'apps/daemon/src/sessions/open-in-root.ts',
  'apps/daemon/src/sessions/open-in-root.test.ts',
  'apps/daemon/src/paths.ts',
  // Daemon test helpers the Seatbelt tests import.
  'apps/daemon/test/fixtures.ts',
  'apps/daemon/test/pinned-tarball.ts',
  // The one repo test the job runs, what it imports, and the config that runs it.
  'tests/repo/src/self-update-real-processes.test.ts',
  'tests/repo/src/installed-app-sandbox.ts',
  'tests/repo/src/workspace.ts',
  'tests/repo/vitest.config.ts',
  'tests/repo/package.json',
  'vitest.config.ts',
  'tests/max-workers.ts',
  'tests/git-isolation.setup.ts',
]);

/** True when a change to `path` can affect what the desktop job builds or tests. */
function affectsDesktop(path) {
  if (DESKTOP_FILES.has(path) || SEATBELT_TEST.test(path)) return true;
  return DESKTOP_PREFIXES.some((prefix) => path.startsWith(prefix));
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

/** The files of the commits `before..after`, or undefined when GitHub cannot say or the push is not a fast-forward. */
function pushedFiles(repository, before, after) {
  // `status` is `ahead` only when `after` descends from `before`; a force push is anything else.
  // Each page repeats it, and the prefixes keep a file named `ahead` apart from it.
  const query =
    '"status:" + .status, "commits:" + (.total_commits | tostring), (.files[] | "file:" + .filename, (.previous_filename // empty | "file:" + .))';
  const result = spawnSync(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repository}/compare/${before}...${after}?per_page=100`,
      '--jq',
      query,
    ],
    { encoding: 'utf8', maxBuffer: MAX_RESPONSE_BYTES },
  );
  if (result.status !== 0) {
    process.stderr.write(`gh api failed: ${result.stderr || String(result.error)}\n`);
    return undefined;
  }
  const lines = result.stdout.split('\n').filter((line) => line !== '');
  if (lines.some((line) => line.startsWith('status:') && line !== 'status:ahead')) return undefined;
  const commits = lines.find((line) => line.startsWith('commits:'));
  if (commits === undefined || Number(commits.slice(8)) > COMPARE_COMMITS_LIMIT) return undefined;
  const files = lines
    .filter((line) => line.startsWith('file:') && line.length > 5)
    .map((line) => line.slice(5));
  return files.length === 0 || files.length >= COMPARE_FILES_LIMIT ? undefined : files;
}

function decide() {
  const { EVENT_NAME: event, REPOSITORY: repository, PR_NUMBER: number } = process.env;
  const { BEFORE: before, AFTER: after } = process.env;
  const repositoryKnown = /^[\w.-]+\/[\w.-]+$/.test(repository ?? '');
  let files;
  if (event === 'pull_request') {
    if (!repositoryKnown || !/^\d+$/.test(number ?? '')) return 'the pull request is not known';
    files = changedFiles(repository, number);
  } else if (event === 'push') {
    const sha = /^[0-9a-f]{40}$/;
    if (!repositoryKnown || !sha.test(before ?? '') || !sha.test(after ?? '')) {
      return 'the pushed commits are not known';
    }
    if (/^0+$/.test(before)) return 'the push has no earlier commit';
    files = pushedFiles(repository, before, after);
  } else {
    return `a ${event || 'unknown'} event always runs it`;
  }
  if (files === undefined) return 'the changed files could not be determined';
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
