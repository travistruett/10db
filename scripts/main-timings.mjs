// Finds and reads the test timings CI's shards upload as `test-timings-<n>` artifacts, for the
// scripts that compare with or learn from runs on main: test-report.mjs and shard-weights.mjs.
// gh is the only way to GitHub; a call that fails gives null and leaves the choice to the caller.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShardTimings } from '../tests/repo/src/test-report.ts';

export const ARTIFACT_PREFIX = 'test-timings-';
const RUNS_TO_SEARCH = 30;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
  if (result.status === 0) return result.stdout;
  process.stderr.write(`gh ${args.join(' ')}: ${result.stderr || String(result.error)}\n`);
  return null;
}

function jsonFrom(args) {
  const output = gh(args);
  if (output === null) return null;
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

/** The parsed timings in `dir`, in any depth of folders; a file that doesn't parse is left out. */
export function readTimings(dir) {
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

/** The newest runs of CI on pushes to main, newest first; `successOnly` keeps the green ones. */
export function mainRuns(repository, { successOnly = false } = {}) {
  const status = successOnly ? '&status=success' : '';
  const url =
    `repos/${repository}/actions/workflows/ci.yml/runs` +
    `?branch=main&event=push${status}&per_page=${String(RUNS_TO_SEARCH)}`;
  return jsonFrom(['api', url])?.workflow_runs ?? [];
}

/** How many unexpired timing artifacts run `id` holds. */
export function timingArtifacts(repository, id) {
  const listed =
    jsonFrom(['api', `repos/${repository}/actions/runs/${String(id)}/artifacts?per_page=100`])
      ?.artifacts ?? [];
  return listed.filter(({ name, expired }) => name.startsWith(ARTIFACT_PREFIX) && !expired).length;
}

/** Run `id`'s parsed timings, or null when the download fails. */
export function downloadTimings(repository, id) {
  const dir = mkdtempSync(join(tmpdir(), 'main-timings-'));
  try {
    const args = ['run', 'download', String(id), '-R', repository, '-p', `${ARTIFACT_PREFIX}*`];
    return gh([...args, '-D', dir]) === null ? null : readTimings(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
