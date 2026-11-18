import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { envWithoutGitVariables } from './fixtures';
import { readRepoFile, repoRoot } from './workspace';

const fixture = join(repoRoot, 'tests/repo/fixtures/vitest-progress');

it('prints a line as each test file starts, before vitest reports the file', () => {
  const result = spawnSync(
    process.execPath,
    [
      join(repoRoot, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      join(fixture, 'vitest.config.mjs'),
      '--reporter=default',
      `--reporter=${join(repoRoot, 'scripts/vitest-progress.mjs')}`,
    ],
    { cwd: fixture, encoding: 'utf8', env: { ...envWithoutGitVariables(), CI: '1' } },
  );

  expect(result.status, result.stderr).toBe(0);
  const started = result.stdout.indexOf('▶ one.check.mjs started');
  const reported = result.stdout.indexOf('✓ one.check.mjs');
  expect(started, result.stdout).toBeGreaterThanOrEqual(0);
  expect(reported, result.stdout).toBeGreaterThan(started);
});

it('is one of the root config’s reporters, so every gate step that runs vitest prints it', () => {
  expect(readRepoFile('vitest.config.ts')).toMatch(
    /const reporters = \[[^\]]*'\.\/scripts\/vitest-progress\.mjs'/,
  );
});
