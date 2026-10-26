import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidError } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDecoyRepo } from '../../test/decoy-repo';
import {
  createTempClone,
  createTempRepo,
  createTempRepoWithOrigin,
  isolatedGitEnv,
  NETWORK_ENV,
  tempDir,
  waitFor,
} from '../../test/fixtures';
import type { TempDir } from '../../test/fixtures';
import { alive } from '../../test/orphan-gate';
import { installPrePushHook, writePrePushHook } from '../../test/pre-push-hook';
import { createGit, GitNetworkError } from './index';

const git = createGit();
let repo: TempDir;
beforeEach(() => {
  repo = createTempRepo();
});
afterEach(() => {
  repo.cleanup();
});

const write = (rel: string, text: string) => {
  writeFileSync(join(repo.path, rel), text);
};
const rawGit = (...args: string[]) =>
  execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv() })
    .toString()
    .trim();
const commitCount = () => Number(rawGit('rev-list', '--count', 'HEAD'));

describe('commit', () => {
  it('commits only the named paths and leaves other changes alone', async () => {
    write('a.txt', 'a');
    write('b.txt', 'b');
    const { sha, alreadyCommitted } = await git.commit({
      repo: repo.path,
      paths: ['a.txt'],
      message: 'Add a',
      opId: 'op-commit-a1',
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(alreadyCommitted).toBe(false);
    expect((await git.status(repo.path)).map((s) => s.path)).toEqual(['b.txt']);
  });

  it('returns the original commit when the same operation is retried', async () => {
    write('a.txt', 'a');
    const first = await git.commit({
      repo: repo.path,
      paths: ['a.txt'],
      message: 'Add a',
      opId: 'op-retry-001',
    });
    write('a.txt', 'changed after the first commit');
    const retry = await git.commit({
      repo: repo.path,
      paths: ['a.txt'],
      message: 'Add a',
      opId: 'op-retry-001',
    });
    expect(retry).toEqual({ sha: first.sha, alreadyCommitted: true });
    expect(commitCount()).toBe(2);
  });

  it('finds a commit made before a crash, with nothing recorded about it', async () => {
    write('a.txt', 'a');
    rawGit('add', 'a.txt');
    rawGit('commit', '-q', '-m', 'Add a', '--trailer', '10db-Op: op-crash-001');
    const sha = rawGit('rev-parse', 'HEAD');
    write('a.txt', 'edited after the crash');
    const retry = await git.commit({
      repo: repo.path,
      paths: ['a.txt'],
      message: 'Add a',
      opId: 'op-crash-001',
    });
    expect(retry).toEqual({ sha, alreadyCommitted: true });
    expect(commitCount()).toBe(2);
  });

  it('does not mistake another operation id for a retry', async () => {
    write('a.txt', 'a');
    const first = await git.commit({
      repo: repo.path,
      paths: ['a.txt'],
      message: 'Add a',
      opId: 'op-distinct-1',
    });
    write('b.txt', 'b');
    const second = await git.commit({
      repo: repo.path,
      paths: ['b.txt'],
      message: 'Add b',
      opId: 'op-distinct-2',
    });
    expect(second.alreadyCommitted).toBe(false);
    expect(second.sha).not.toBe(first.sha);
  });

  it.each([['../escape.txt'], ['/etc/hosts'], ['']])('rejects the path %j', async (path) => {
    await expect(
      git.commit({ repo: repo.path, paths: [path], message: 'x', opId: 'op-badpath-1' }),
    ).rejects.toThrow(InvalidError);
  });

  it('rejects a path through a symlinked parent that leaves the repo', async () => {
    const outside = tempDir('git-outside');
    try {
      writeFileSync(join(outside.path, 'x.ts'), 'x');
      symlinkSync(outside.path, join(repo.path, 'link'));
      await expect(
        git.commit({
          repo: repo.path,
          paths: ['link/x.ts'],
          message: 'x',
          opId: 'op-symlink-1',
        }),
      ).rejects.toThrow(InvalidError);
    } finally {
      outside.cleanup();
    }
  });

  it('reports nothing to commit as an InvalidError', async () => {
    await expect(
      git.commit({ repo: repo.path, paths: ['README.md'], message: 'x', opId: 'op-nothing-1' }),
    ).rejects.toThrow(/Nothing to commit/);
  });

  it('records deletions of a named path', async () => {
    rmSync(join(repo.path, 'README.md'));
    await git.commit({
      repo: repo.path,
      paths: ['README.md'],
      message: 'Remove readme',
      opId: 'op-delete-01',
    });
    expect(await git.status(repo.path)).toEqual([]);
  });

  it('serializes concurrent commits in one repo', async () => {
    write('x.txt', 'x');
    write('y.txt', 'y');
    const [x, y] = await Promise.all([
      git.commit({ repo: repo.path, paths: ['x.txt'], message: 'x', opId: 'op-parallel-x' }),
      git.commit({ repo: repo.path, paths: ['y.txt'], message: 'y', opId: 'op-parallel-y' }),
    ]);
    expect(x.sha).not.toBe(y.sha);
    expect(commitCount()).toBe(3);
  });
});

describe('history queries', () => {
  it('lists changed files and commits since a base', async () => {
    const base = await git.head(repo.path);
    write('a.txt', 'a');
    const { sha } = await git.commit({
      repo: repo.path,
      paths: ['a.txt'],
      message: 'a',
      opId: 'op-history-1',
    });
    write('b.txt', 'b');
    expect(await git.changedFilesSince(repo.path, base)).toEqual(['a.txt', 'b.txt']);
    expect(await git.commitsSince(repo.path, base)).toEqual([sha]);
  });
});

describe('status', () => {
  it.each([
    {
      name: 'a modified file',
      arrange: () => {
        write('README.md', 'edited');
      },
      expected: [{ code: ' M', path: 'README.md' }],
    },
    {
      name: 'an untracked file',
      arrange: () => {
        write('new.txt', 'n');
      },
      expected: [{ code: '??', path: 'new.txt' }],
    },
    {
      name: 'a staged rename, reported once under its new path',
      arrange: () => {
        rawGit('mv', 'README.md', 'DOC.md');
      },
      expected: [{ code: 'R ', path: 'DOC.md' }],
    },
    {
      name: 'a path containing a space',
      arrange: () => {
        write('with space.txt', 's');
      },
      expected: [{ code: '??', path: 'with space.txt' }],
    },
  ])('reports $name', async ({ arrange, expected }) => {
    arrange();
    expect(await git.status(repo.path)).toEqual(expected);
  });

  // A status that refreshed the index would hold index.lock, and a lane's commit running then fails.
  it('leaves a stale index unwritten', async () => {
    const index = join(repo.path, '.git', 'index');
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(repo.path, 'README.md'), later, later);
    const before = readFileSync(index);
    expect(await git.status(repo.path)).toEqual([]);
    expect(readFileSync(index).equals(before)).toBe(true);
  });
});

describe('branches and remotes', () => {
  it('reads the current branch, and null when HEAD is detached', async () => {
    expect(await git.currentBranch(repo.path)).toBe('main');
    rawGit('checkout', '-q', '--detach');
    expect(await git.currentBranch(repo.path)).toBeNull();
  });

  it("reads a remote's URL, and null when there is no such remote", async () => {
    expect(await git.remoteUrl(repo.path, 'origin')).toBeNull();
    rawGit('remote', 'add', 'origin', '/nowhere/x.git');
    expect(await git.remoteUrl(repo.path, 'origin')).toBe('/nowhere/x.git');
  });

  it('switches to a new branch from a start point, with no upstream', async () => {
    const base = rawGit('rev-parse', 'HEAD');
    write('later.txt', 'later');
    rawGit('add', 'later.txt');
    rawGit('commit', '-q', '-m', 'later');
    await git.switchNewBranch(repo.path, '10db/greetings-0a1b2c3d', base);
    expect(rawGit('branch', '--show-current')).toBe('10db/greetings-0a1b2c3d');
    expect(rawGit('rev-parse', 'HEAD')).toBe(base);
    expect(() => rawGit('rev-parse', '--abbrev-ref', '@{u}')).toThrow();
    await expect(git.switchNewBranch(repo.path, '10db/greetings-0a1b2c3d', base)).rejects.toThrow(
      /already exists/,
    );
  });
});

describe('network calls', () => {
  let remote: ReturnType<typeof createTempRepoWithOrigin>;
  beforeEach(() => {
    remote = createTempRepoWithOrigin();
  });
  afterEach(() => {
    remote.cleanup();
  });

  const net = { env: NETWORK_ENV, timeoutMs: 10_000 };
  const local = (...args: string[]) =>
    execFileSync('git', ['-C', remote.repo.path, ...args], { env: isolatedGitEnv() })
      .toString()
      .trim();
  const origin = (...args: string[]) =>
    execFileSync('git', ['-C', remote.origin.path, ...args], { env: isolatedGitEnv() })
      .toString()
      .trim();
  /** Another clone adds a commit to `branch` on origin, as a teammate would. */
  function pushFromElsewhere(branch: string, file: string): string {
    const other = createTempClone(remote.origin.path);
    try {
      const g = (...args: string[]) =>
        execFileSync('git', ['-C', other.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
          .toString()
          .trim();
      if (branch !== 'main') g('switch', '-q', '-c', branch);
      writeFileSync(join(other.path, file), file);
      g('add', file);
      g('commit', '-q', '-m', `Add ${file}`);
      g('push', '-q', 'origin', branch);
      return g('rev-parse', 'HEAD');
    } finally {
      other.cleanup();
    }
  }

  it('fetches the base branch into origin/<branch> without touching the checkout', async () => {
    const before = local('rev-parse', 'HEAD');
    const upstream = pushFromElsewhere('main', 'upstream.txt');
    await git.fetch(remote.repo.path, 'main', net);
    expect(local('rev-parse', 'origin/main')).toBe(upstream);
    expect(local('rev-parse', 'HEAD')).toBe(before);
  });

  it('fails to fetch a branch origin does not have', async () => {
    const failure = git.fetch(remote.repo.path, 'develop', net);
    await expect(failure).rejects.toBeInstanceOf(GitNetworkError);
    await expect(failure).rejects.toMatchObject({ kind: 'failed' });
  });

  it('pushes a branch and sets its upstream, and pushing it again changes nothing', async () => {
    await git.switchNewBranch(remote.repo.path, '10db/x-0a1b2c3d', 'main');
    writeFileSync(join(remote.repo.path, 'x.txt'), 'x');
    local('add', 'x.txt');
    local('commit', '-q', '-m', 'Add x');
    await git.push(remote.repo.path, '10db/x-0a1b2c3d', net);
    const sha = local('rev-parse', 'HEAD');
    expect(origin('rev-parse', 'refs/heads/10db/x-0a1b2c3d')).toBe(sha);
    expect(local('rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/10db/x-0a1b2c3d');
    await git.push(remote.repo.path, '10db/x-0a1b2c3d', net);
    expect(origin('rev-parse', 'refs/heads/10db/x-0a1b2c3d')).toBe(sha);
  });

  it('reports a rejected push and never forces it', async () => {
    const theirs = pushFromElsewhere('10db/x-0a1b2c3d', 'theirs.txt');
    await git.switchNewBranch(remote.repo.path, '10db/x-0a1b2c3d', 'main');
    writeFileSync(join(remote.repo.path, 'ours.txt'), 'ours');
    local('add', 'ours.txt');
    local('commit', '-q', '-m', 'Add ours');
    const failure = git.push(remote.repo.path, '10db/x-0a1b2c3d', net);
    await expect(failure).rejects.toMatchObject({ name: 'GitNetworkError', kind: 'rejected' });
    expect(origin('rev-parse', 'refs/heads/10db/x-0a1b2c3d')).toBe(theirs);
  });

  it('reports how long a push ran and what git and its pre-push hook printed', async () => {
    await git.switchNewBranch(remote.repo.path, '10db/x-0a1b2c3d', 'main');
    writePrePushHook(remote.repo.path, 'echo "hook: 3 checks passed"; echo "hook: lint warns" >&2');
    const run = await git.push(remote.repo.path, '10db/x-0a1b2c3d', net);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.output).toContain('hook: 3 checks passed');
    expect(run.output).toContain('hook: lint warns');
  });

  it('gives a rejected push its duration and what git printed', async () => {
    pushFromElsewhere('10db/x-0a1b2c3d', 'theirs.txt');
    await git.switchNewBranch(remote.repo.path, '10db/x-0a1b2c3d', 'main');
    writeFileSync(join(remote.repo.path, 'ours.txt'), 'ours');
    local('add', 'ours.txt');
    local('commit', '-q', '-m', 'Add ours');
    const error: unknown = await git
      .push(remote.repo.path, '10db/x-0a1b2c3d', net)
      .catch((caught: unknown) => caught);
    if (!(error instanceof GitNetworkError)) throw new Error('expected the push to be refused');
    expect(error.kind).toBe('rejected');
    expect(error.durationMs).toBeGreaterThanOrEqual(0);
    expect(error.output).toContain('rejected');
  });

  it('times out a fetch that hangs', async () => {
    local('remote', 'set-url', 'origin', 'ssh://git@example.invalid/hang.git');
    // ssh is replaced by a command that hangs; git appends the host and command as arguments.
    const hang = {
      env: { ...NETWORK_ENV, GIT_SSH_COMMAND: 'sleep 5; true', GIT_SSH_VARIANT: 'simple' },
      timeoutMs: 300,
    };
    await expect(git.fetch(remote.repo.path, 'main', hang)).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('stops a push whose pre-push hook runs past its timeout, with every process the hook started', async () => {
    await git.switchNewBranch(remote.repo.path, '10db/x-0a1b2c3d', 'main');
    const hook = installPrePushHook(remote.repo.path, 30);
    try {
      const push = git.push(remote.repo.path, '10db/x-0a1b2c3d', {
        env: NETWORK_ENV,
        timeoutMs: 1_000,
      });
      const timedOut = expect(push).rejects.toMatchObject({ kind: 'timeout' });
      const child = await hook.childPid();
      await timedOut;
      await waitFor(() => !alive(child), 2_000);
      expect(() => origin('rev-parse', '--verify', '-q', 'refs/heads/10db/x-0a1b2c3d')).toThrow();
    } finally {
      hook.cleanup();
    }
  });

  it('stops a fetch when its signal aborts', async () => {
    local('remote', 'set-url', 'origin', 'ssh://git@example.invalid/hang.git');
    const controller = new AbortController();
    const call = {
      env: { ...NETWORK_ENV, GIT_SSH_COMMAND: 'sleep 5; true', GIT_SSH_VARIANT: 'simple' },
      timeoutMs: 10_000,
      signal: controller.signal,
    };
    const pending = git.fetch(remote.repo.path, 'main', call);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  });

  it.each([
    {
      name: 'fetch updates',
      act: async (env: Readonly<Record<string, string>>) => {
        const upstream = pushFromElsewhere('main', 'upstream.txt');
        await git.fetch(remote.repo.path, 'main', { env, timeoutMs: 10_000 });
        expect(local('rev-parse', 'origin/main')).toBe(upstream);
      },
    },
    {
      name: 'push sends from',
      act: async (env: Readonly<Record<string, string>>) => {
        await git.switchNewBranch(remote.repo.path, '10db/x-0a1b2c3d', 'main');
        await git.push(remote.repo.path, '10db/x-0a1b2c3d', { env, timeoutMs: 10_000 });
        expect(origin('rev-parse', 'refs/heads/10db/x-0a1b2c3d')).toBe(local('rev-parse', 'HEAD'));
      },
    },
  ])(
    '$name the repository it is given when the network environment carries hook variables',
    async ({ act }) => {
      // The network environment is the builder's login environment, which a daemon started from a
      // git hook may have captured with GIT_DIR and friends in it.
      const decoy = createDecoyRepo();
      try {
        const before = decoy.snapshot();
        let failure: unknown;
        await act({ ...NETWORK_ENV, ...decoy.hookVariables }).catch((error: unknown) => {
          failure = error;
        });
        expect(decoy.snapshot()).toEqual(before);
        expect(failure).toBeUndefined();
      } finally {
        decoy.cleanup();
      }
    },
  );
});

describe('git hook variables in the daemon environment', () => {
  // Git exports GIT_DIR, GIT_INDEX_FILE and friends to a hook. A daemon started from one must
  // still act on the repository it is given, never on the one the variables point at.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      name: 'head reads',
      act: async () => {
        expect(await git.head(repo.path)).toBe(rawGit('rev-parse', 'HEAD'));
      },
    },
    {
      name: 'status reads',
      act: async () => {
        write('new.txt', 'n');
        expect(await git.status(repo.path)).toEqual([{ code: '??', path: 'new.txt' }]);
      },
    },
    {
      name: 'commit writes to',
      act: async () => {
        write('a.txt', 'a');
        await git.commit({ repo: repo.path, paths: ['a.txt'], message: 'a', opId: 'op-hook-1' });
        expect(commitCount()).toBe(2);
      },
    },
    {
      name: 'currentBranch reads',
      act: async () => {
        expect(await git.currentBranch(repo.path)).toBe('main');
      },
    },
    {
      name: 'remoteUrl reads',
      act: async () => {
        rawGit('remote', 'add', 'origin', '/nowhere/x.git');
        expect(await git.remoteUrl(repo.path, 'origin')).toBe('/nowhere/x.git');
      },
    },
    {
      name: 'switchNewBranch writes to',
      act: async () => {
        await git.switchNewBranch(repo.path, '10db/hook-0a1b2c3d', 'main');
        expect(rawGit('branch', '--show-current')).toBe('10db/hook-0a1b2c3d');
      },
    },
  ])('$name the repository it is given and leaves the other untouched', async ({ act }) => {
    const decoy = createDecoyRepo();
    try {
      const before = decoy.snapshot();
      for (const [name, value] of Object.entries(decoy.hookVariables)) vi.stubEnv(name, value);
      let failure: unknown;
      await act().catch((error: unknown) => {
        failure = error;
      });
      expect(decoy.snapshot()).toEqual(before);
      expect(failure).toBeUndefined();
    } finally {
      decoy.cleanup();
    }
  });
});
