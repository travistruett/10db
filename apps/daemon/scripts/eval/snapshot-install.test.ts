import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { installSnapshotDependencies, SnapshotInstallError } from './snapshot-install';

const dirs: TempDir[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) dir.cleanup();
});

/** A directory of fake executables (mise and pnpm are processes this test doesn't own), and a repo. */
function fixture(scripts: Record<string, string>): {
  env: NodeJS.ProcessEnv;
  repo: string;
  log: string;
} {
  const dir = tempDir('snapshot-install');
  dirs.push(dir);
  const bin = join(dir.path, 'bin');
  const repo = join(dir.path, 'repo');
  mkdirSync(bin);
  mkdirSync(repo);
  const log = join(dir.path, 'calls.log');
  for (const [name, body] of Object.entries(scripts)) {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return { env: { PATH: `${bin}:/usr/bin:/bin`, CALLS: log }, repo, log };
}

const RECORD = 'echo "$0 $PWD $* trusted=$MISE_TRUSTED_CONFIG_PATHS" >> "$CALLS"';

describe('installSnapshotDependencies', () => {
  it('installs through mise in the snapshot, trusting that snapshot only, so its own node and pnpm run', () => {
    const { env, repo, log } = fixture({ mise: RECORD });
    installSnapshotDependencies(repo, { ...env, MISE_TRUSTED_CONFIG_PATHS: '/already/trusted' });
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`${repo} exec -- pnpm install --frozen-lockfile --prefer-offline`);
    expect(calls[0]).toContain(`trusted=/already/trusted:${repo}`);
  });

  it('runs pnpm directly when mise is not installed', () => {
    const { env, repo, log } = fixture({ pnpm: RECORD });
    installSnapshotDependencies(repo, env);
    expect(readFileSync(log, 'utf8')).toContain(
      `${repo} install --frozen-lockfile --prefer-offline`,
    );
  });

  it('fails with the install’s own error output', () => {
    const { env, repo } = fixture({
      mise: 'echo "ERR_PNPM_UNSUPPORTED_ENGINE wanted 26.12.1" >&2; echo "progress line"; exit 3',
    });
    let caught: unknown;
    try {
      installSnapshotDependencies(repo, env);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SnapshotInstallError);
    const message = (caught as SnapshotInstallError).message;
    expect(message).toContain('ERR_PNPM_UNSUPPORTED_ENGINE wanted 26.12.1');
    expect(message).toContain('progress line');
    expect(message).toContain(repo);
  });
});
