#!/usr/bin/env node
// Writes the pull request's test report: tests added, seconds added and test lines per code line
// (docs/architecture/decisions/2026-11-06-pull-requests-report-their-test-cost.md). It compares
// the shards' timings with those of the newest commit on main that has every shard's, which can be
// older than the base when a run on main was cancelled. Timings it cannot read leave those numbers
// out, and it exits non-zero with no report only when git cannot give the diff.
// Usage: REPOSITORY=<owner>/<repo> TIMINGS_DIR=<dir> GH_TOKEN=<token> \
//   node scripts/test-report.mjs > <body file>
// Run in the checkout of a pull request's merge commit, with full history.
import { spawnSync } from 'node:child_process';
import { buildReport, parseNumstat, renderReport } from '../tests/repo/src/test-report.ts';
import { downloadTimings, mainRuns, readTimings, timingArtifacts } from './main-timings.mjs';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
  if (result.status === 0) return result.stdout;
  process.stderr.write(`${command} ${args.join(' ')}: ${result.stderr || String(result.error)}\n`);
  return null;
}

/** The run on main whose timings to compare with: its id and commit, or null. */
function findBaseline(repository, shards) {
  for (const { id, head_sha: sha } of mainRuns(repository)) {
    // main can move past this pull request's base, and those commits would be charged to it.
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD^1']);
    if (ancestor.status !== 0) continue;
    if (timingArtifacts(repository, id) === shards) return { id, sha };
  }
  return null;
}

const { REPOSITORY: repository = '', TIMINGS_DIR: timingsDir = '' } = process.env;
const current = readTimings(timingsDir);
const shards = current[0]?.shard.count;
const found = shards === undefined ? null : findBaseline(repository, shards);
const downloaded = found === null ? null : downloadTimings(repository, found.id);
const baseline = downloaded?.length === shards ? downloaded : null;
const numstat = run('git', ['diff', '-z', '--numstat', '-M', 'HEAD^1', 'HEAD']);
if (numstat === null) process.exit(1);
const moved =
  baseline === null || found === null
    ? ''
    : (run('git', ['diff', '-z', '--name-only', '--no-renames', found.sha, 'HEAD^1']) ?? '');
const report = buildReport({
  current,
  baseline,
  diff: parseNumstat(numstat),
  movedOnMain: moved.split('\0').filter(Boolean),
});
process.stdout.write(
  renderReport(report, baseline === null ? null : (found?.sha.slice(0, 7) ?? null)),
);
