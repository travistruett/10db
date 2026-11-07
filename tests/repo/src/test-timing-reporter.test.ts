import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envWithoutGitVariables } from './fixtures';
import { ShardTimings } from './test-report';
import { repoRoot } from './workspace';

const TEST_FILE = 'packages/contracts/src/team.test.ts';

/** A real Vitest run of one quick file, with the timings going to `path`. */
function runVitest(path: string) {
  const vitest = join(repoRoot, 'node_modules/vitest/vitest.mjs');
  return spawnSync(
    process.execPath,
    [vitest, 'run', '--project', 'contracts', '--shard=1/1', TEST_FILE],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      // Under the test's own limit: a sync spawn blocks the worker, so that limit can't stop a hang.
      timeout: 25_000,
      env: { ...envWithoutGitVariables(), TENDB_TEST_TIMINGS: path },
    },
  );
}

describe('TestTimingReporter, in a real Vitest run', () => {
  it('writes each file under its repo path, with the shard, and keeps the default report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-timings-'));
    try {
      const path = join(dir, 'nested', 'timings.json');
      const result = runVitest(path);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Test Files');
      const timings = ShardTimings.parse(JSON.parse(readFileSync(path, 'utf8')));
      expect(timings.shard).toEqual({ index: 1, count: 1 });
      expect(timings.files.map(({ file }) => file)).toEqual([TEST_FILE]);
      expect(timings.files[0]?.tests).toBeGreaterThan(0);
      expect(timings.files[0]?.seconds).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never fails a passing run: it runs inside a required check', () => {
    const path = '/dev/null/not-a-directory/timings.json';
    const result = runVitest(path);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('test timings not written');
    expect(existsSync(path)).toBe(false);
  });
});
