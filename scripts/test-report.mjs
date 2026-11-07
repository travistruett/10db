#!/usr/bin/env node
// Writes the pull request's test report: tests added, seconds added and test lines per code line
// (docs/architecture/decisions/2026-11-06-pull-requests-report-their-test-cost.md). It compares
// the shards' timings with those of the newest commit on main that has every shard's, which can be
// older than the base when a run on main was cancelled. Anything it cannot read leaves that number
// out: the report is informational, so this script has no failure worth failing a job for.
// Usage: REPOSITORY=<owner>/<repo> TIMINGS_DIR=<dir> GH_TOKEN=<token> \
//   node scripts/test-report.mjs > <body file>
// Run in the checkout of a pull request's merge commit, with full history.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReport,
  parseNumstat,
  renderReport,
  ShardTimings,
} from '../tests/repo/src/test-report.ts';

const ARTIFACT_PREFIX = 'test-timings-';
const RUNS_TO_SEARCH = 30;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
  if (result.status === 0) return result.stdout;
  process.stderr.write(`${command} ${args.join(' ')}: ${result.stderr || String(result.error)}\n`);
  return null;
}

/** The parsed timings in `dir`, in any depth of folders; a file that doesn't parse is left out. */
function readTimings(dir) {
  const timings = [];
  // No artifact downloaded means no folder at all.
  if (!existsSync(dir)) return timings;
  for (const name of readdirSync(dir, { recursive: true })) {
    const path = join(dir, String(name));
    if (!statSync(path).isFile()) continue;
    try {
      timings.push(ShardTimings.parse(JSON.parse(readFileSync(path, 'utf8'))));
    } catch (error) {
      process.stderr.write(`${path}: ${String(error)}\n`);
    }
  }
  return timings;
}

function jsonFrom(args) {
  const output = run('gh', args);
  if (output === null) return null;
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

/** The run on main whose timings to compare with: its id and commit, or null. */
function findBaseline(repository, shards) {
  const url =
    `repos/${repository}/actions/workflows/ci.yml/runs` +
    `?branch=main&event=push&per_page=${String(RUNS_TO_SEARCH)}`;
  const runs = jsonFrom(['api', url])?.workflow_runs ?? [];
  for (const { id, head_sha: sha } of runs) {
    // main can move past this pull request's base, and those commits would be charged to it.
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD^1']);
    if (ancestor.status !== 0) continue;
    const listed =
      jsonFrom(['api', `repos/${repository}/actions/runs/${String(id)}/artifacts?per_page=100`])
        ?.artifacts ?? [];
    const usable = listed.filter(
      ({ name, expired }) => name.startsWith(ARTIFACT_PREFIX) && !expired,
    );
    if (usable.length === shards) return { id, sha };
  }
  return null;
}

function downloadBaseline(repository, baseline) {
  const dir = mkdtempSync(join(tmpdir(), 'test-report-'));
  try {
    const pattern = `${ARTIFACT_PREFIX}*`;
    const args = ['run', 'download', String(baseline.id), '-R', repository, '-p', pattern];
    return run('gh', [...args, '-D', dir]) === null ? null : readTimings(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { REPOSITORY: repository = '', TIMINGS_DIR: timingsDir = '' } = process.env;
const current = readTimings(timingsDir);
const shards = current[0]?.shard.count;
const found = shards === undefined ? null : findBaseline(repository, shards);
const downloaded = found === null ? null : downloadBaseline(repository, found);
const baseline = downloaded?.length === shards ? downloaded : null;
const diff = parseNumstat(run('git', ['diff', '-z', '--numstat', '-M', 'HEAD^1', 'HEAD']) ?? '');
const report = buildReport({ current, baseline, diff });
process.stdout.write(
  renderReport(report, baseline === null ? null : (found?.sha.slice(0, 7) ?? null)),
);
