import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDecoyRepo } from './decoy-repo';
import { createTempRepo, isolatedGitEnv, type TempDir } from './fixtures';

const gitIn = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: isolatedGitEnv() }).trim();

describe.each([
  { fixture: 'createTempRepo', create: () => createTempRepo() },
  { fixture: 'createDecoyRepo', create: () => createDecoyRepo() },
])('a repository from $fixture', ({ create }) => {
  // Git can leave a detached `git maintenance run --auto` writing objects/maintenance.lock after a
  // commit returns, which a snapshot of .git then trips over or records as a change.
  it('starts no background maintenance or gc when a commit lands', () => {
    const repo = create();
    try {
      const commit = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'probe'], {
        cwd: repo.path,
        env: { ...isolatedGitEnv(), GIT_TRACE: '1' },
        encoding: 'utf8',
      });
      expect(commit.status, commit.stderr).toBe(0);
      expect(commit.stderr).not.toMatch(/run_command: git (maintenance|gc)\b/);
    } finally {
      repo.cleanup();
    }
  });
});

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
