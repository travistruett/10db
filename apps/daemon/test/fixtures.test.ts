import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDecoyRepo } from './decoy-repo';
import { gitWrapper } from './git-wrapper';
import {
  buildRemoteTemplate,
  buildRepoTemplate,
  createTempClone,
  createTempRepo,
  createTempRepoWithOrigin,
  isolatedGitEnv,
  tempDir,
  type TempDir,
} from './fixtures';

const gitIn = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: isolatedGitEnv() }).trim();

/** A clone of a fresh origin; its cleanup removes both. */
function cloneOfFreshOrigin(): TempDir {
  const remote = createTempRepoWithOrigin();
  const clone = createTempClone(remote.origin.path);
  return {
    path: clone.path,
    cleanup: () => {
      clone.cleanup();
      remote.cleanup();
    },
  };
}

describe.each([
  { fixture: 'createTempRepo', create: () => createTempRepo() },
  { fixture: 'createDecoyRepo', create: () => createDecoyRepo() },
  { fixture: 'createTempClone', create: cloneOfFreshOrigin },
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

describe('createTempRepo copies', () => {
  it('give each repository its own objects and refs', () => {
    const first = createTempRepo();
    const second = createTempRepo();
    try {
      gitIn(first.path, 'commit', '-q', '--allow-empty', '-m', 'only in the first');
      expect(gitIn(first.path, 'rev-list', '--count', 'HEAD')).toBe('2');
      expect(gitIn(second.path, 'rev-list', '--count', 'HEAD')).toBe('1');
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });
});

describe('buildRepoTemplate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds its own repository when git hook variables point at another one', () => {
    const decoy = createDecoyRepo();
    let template: TempDir | undefined;
    try {
      const before = decoy.snapshot();
      for (const [name, value] of Object.entries(decoy.hookVariables)) vi.stubEnv(name, value);
      let failure: unknown;
      try {
        template = buildRepoTemplate();
      } catch (error) {
        failure = error;
      }
      vi.unstubAllEnvs();

      expect(decoy.snapshot()).toEqual(before);
      expect(failure).toBeUndefined();
      const path = template?.path ?? '';
      expect(gitIn(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
      expect(gitIn(path, 'rev-list', '--count', 'HEAD')).toBe('1');
      expect(gitIn(path, 'config', 'maintenance.auto')).toBe('false');
    } finally {
      template?.cleanup();
      decoy.cleanup();
    }
  });
});

describe('buildRemoteTemplate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds its own repository and origin when git hook variables point at another one', () => {
    const decoy = createDecoyRepo();
    let pair: ReturnType<typeof buildRemoteTemplate> | undefined;
    try {
      const before = decoy.snapshot();
      for (const [name, value] of Object.entries(decoy.hookVariables)) vi.stubEnv(name, value);
      let failure: unknown;
      try {
        pair = buildRemoteTemplate();
      } catch (error) {
        failure = error;
      }
      vi.unstubAllEnvs();

      expect(decoy.snapshot()).toEqual(before);
      expect(failure).toBeUndefined();
      const repo = pair?.repo.path ?? '';
      const origin = pair?.origin.path ?? '';
      expect(gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
      expect(gitIn(repo, 'rev-list', '--count', 'HEAD')).toBe('1');
      expect(gitIn(origin, 'rev-parse', 'refs/heads/main')).toBe(gitIn(repo, 'rev-parse', 'HEAD'));
      expect(gitIn(repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(
        gitIn(repo, 'rev-parse', 'HEAD'),
      );
    } finally {
      pair?.cleanup();
      decoy.cleanup();
    }
  });
});

describe('createTempClone', () => {
  it("commits as the teammate and keeps the test repository's maintenance off, from the clone itself", () => {
    const remote = createTempRepoWithOrigin();
    const clone = createTempClone(remote.origin.path);
    try {
      expect(gitIn(clone.path, 'config', '--local', 'user.name')).toBe('teammate');
      expect(gitIn(clone.path, 'config', '--local', 'user.email')).toBe('teammate@10db.invalid');
      expect(gitIn(clone.path, 'config', '--local', 'commit.gpgsign')).toBe('false');
      expect(gitIn(clone.path, 'config', '--local', 'gc.auto')).toBe('0');
      gitIn(clone.path, 'commit', '-q', '--allow-empty', '-m', 'probe');
      expect(gitIn(clone.path, 'log', '-1', '--format=%an')).toBe('teammate');
    } finally {
      clone.cleanup();
      remote.cleanup();
    }
  });
});

describe('createTempRepoWithOrigin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // A push runs receive-pack in the bare origin, and receive-pack can leave a detached `git
  // maintenance run --auto` writing there after the push returns, which races the origin's removal.
  it('starts no background maintenance or gc in the origin when a push lands', () => {
    const remote = createTempRepoWithOrigin();
    try {
      gitIn(remote.repo.path, 'commit', '-q', '--allow-empty', '-m', 'probe');
      const push = spawnSync('git', ['push', '-q', 'origin', 'main'], {
        cwd: remote.repo.path,
        env: { ...isolatedGitEnv(), GIT_TRACE: '1' },
        encoding: 'utf8',
      });
      expect(push.status, push.stderr).toBe(0);
      // receive-pack traces to the same stderr, so the check below covers the receiving side.
      expect(push.stderr).toMatch(/built-in: git receive-pack\b/);
      expect(push.stderr).not.toMatch(/run_command: git (maintenance|gc)\b/);
    } finally {
      remote.cleanup();
    }
  });

  // Each git process costs a spawn, and under the gate's load a spawn is slow: a delivery test makes
  // one of these per harness and has a 30 s limit, so a copy of a template pair stands in for the
  // dozen calls that used to build it.
  it('runs no git process: it copies a template pair and points the repository at the copy', () => {
    const log = tempDir('git-calls');
    const calls = join(log.path, 'calls.log');
    const wrapper = gitWrapper(`echo "$*" >> '${calls}'\nexec "$GIT" "$@"`);
    vi.stubEnv('PATH', wrapper.path);
    let remote: ReturnType<typeof createTempRepoWithOrigin> | undefined;
    try {
      remote = createTempRepoWithOrigin();
      vi.unstubAllEnvs();
      expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').toBe('');
      const repo = remote.repo.path;
      const origin = remote.origin.path;
      expect(gitIn(repo, 'remote', 'get-url', 'origin')).toBe(origin);
      expect(gitIn(repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(
        gitIn(repo, 'rev-parse', 'HEAD'),
      );
      expect(gitIn(repo, 'status', '--porcelain')).toBe('');
      expect(gitIn(repo, 'config', 'user.name')).toBe('10db test');
      for (const [key, value] of [
        ['maintenance.auto', 'false'],
        ['gc.auto', '0'],
        ['receive.autogc', 'false'],
        ['user.name', 'github'],
        ['commit.gpgsign', 'false'],
      ] as const)
        expect(gitIn(origin, 'config', key)).toBe(value);
      // A push from the copy lands in the copy's own origin.
      gitIn(repo, 'commit', '-q', '--allow-empty', '-m', 'probe');
      gitIn(repo, 'push', '-q', 'origin', 'main');
      expect(gitIn(origin, 'rev-parse', 'refs/heads/main')).toBe(gitIn(repo, 'rev-parse', 'HEAD'));
    } finally {
      vi.unstubAllEnvs();
      remote?.cleanup();
      wrapper.cleanup();
      log.cleanup();
    }
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
