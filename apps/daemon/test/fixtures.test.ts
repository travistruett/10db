import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDecoyRepo } from './decoy-repo';
import { createTempRepo, createTempRepoWithOrigin, isolatedGitEnv, type TempDir } from './fixtures';

const gitIn = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: isolatedGitEnv() }).trim();

describe('createTempRepo', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('makes a git repository with one commit on main and removes it on cleanup', () => {
    const repo = createTempRepo();
    expect(gitIn(repo.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(gitIn(repo.path, 'rev-list', '--count', 'HEAD')).toBe('1');
    repo.cleanup();
    expect(existsSync(repo.path)).toBe(false);
  });

  it('builds its own repository when git hook variables point at another one', () => {
    const decoy = createDecoyRepo();
    let repo: TempDir | undefined;
    try {
      const before = decoy.snapshot();
      for (const [name, value] of Object.entries(decoy.hookVariables)) vi.stubEnv(name, value);
      let failure: unknown;
      try {
        repo = createTempRepo();
      } catch (error) {
        failure = error;
      }
      vi.unstubAllEnvs();

      expect(decoy.snapshot()).toEqual(before);
      expect(failure).toBeUndefined();
      const path = repo?.path ?? '';
      expect(gitIn(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
      expect(gitIn(path, 'rev-list', '--count', 'HEAD')).toBe('1');
      expect(gitIn(path, 'config', 'core.bare')).toBe('false');
      expect(gitIn(path, 'config', 'user.name')).toBe('10db test');
    } finally {
      repo?.cleanup();
      decoy.cleanup();
    }
  });
});

describe('createTempRepoWithOrigin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds its own repository and origin when git hook variables point at another one', () => {
    const decoy = createDecoyRepo();
    let remote: ReturnType<typeof createTempRepoWithOrigin> | undefined;
    try {
      const before = decoy.snapshot();
      for (const [name, value] of Object.entries(decoy.hookVariables)) vi.stubEnv(name, value);
      let failure: unknown;
      try {
        remote = createTempRepoWithOrigin();
      } catch (error) {
        failure = error;
      }
      vi.unstubAllEnvs();

      expect(decoy.snapshot()).toEqual(before);
      expect(failure).toBeUndefined();
      const repo = remote?.repo.path ?? '';
      const origin = remote?.origin.path ?? '';
      expect(gitIn(repo, 'remote', 'get-url', 'origin')).toBe(origin);
      expect(gitIn(origin, 'rev-parse', 'refs/heads/main')).toBe(gitIn(repo, 'rev-parse', 'HEAD'));
    } finally {
      remote?.cleanup();
      decoy.cleanup();
    }
  });
});
