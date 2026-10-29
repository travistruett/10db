import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
import { HANGING_SSH_URL, hangingSsh } from '../../test/hanging-ssh';
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
  execFileSync('git', ['-C', repo.path, ...args], {
    env: isolatedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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
      branch: 'main',
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(alreadyCommitted).toBe(false);
    expect(await git.changedPaths(repo.path)).toEqual(['b.txt']);
  });

  it('returns the original commit when the same operation is retried', async () => {
    write('a.txt', 'a');
    const first = await git.commit({
      repo: repo.path,
      paths: ['a.txt'],
      message: 'Add a',
      opId: 'op-retry-001',
      branch: 'main',
    });
    write('a.txt', 'changed after the first commit');
    const retry = await git.commit({
      repo: repo.path,
      paths: ['a.txt'],
      message: 'Add a',
      opId: 'op-retry-001',
      branch: 'main',
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
      branch: 'main',
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
      branch: 'main',
    });
    write('b.txt', 'b');
    const second = await git.commit({
      repo: repo.path,
      paths: ['b.txt'],
      message: 'Add b',
      opId: 'op-distinct-2',
      branch: 'main',
    });
    expect(second.alreadyCommitted).toBe(false);
    expect(second.sha).not.toBe(first.sha);
  });

  it.each([['../escape.txt'], ['/etc/hosts'], ['']])('rejects the path %j', async (path) => {
    await expect(
      git.commit({
        repo: repo.path,
        paths: [path],
        message: 'x',
        opId: 'op-badpath-1',
        branch: 'main',
      }),
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
          branch: 'main',
        }),
      ).rejects.toThrow(InvalidError);
    } finally {
      outside.cleanup();
    }
  });

  it('reports nothing to commit as an InvalidError', async () => {
    await expect(
      git.commit({
        repo: repo.path,
        paths: ['README.md'],
        message: 'x',
        opId: 'op-nothing-1',
        branch: 'main',
      }),
    ).rejects.toThrow(/Nothing to commit/);
  });

  it('records deletions of a named path', async () => {
    rmSync(join(repo.path, 'README.md'));
    await git.commit({
      repo: repo.path,
      paths: ['README.md'],
      message: 'Remove readme',
      opId: 'op-delete-01',
      branch: 'main',
    });
    expect(await git.changedPaths(repo.path)).toEqual([]);
  });

  it('serializes concurrent commits in one repo', async () => {
    write('x.txt', 'x');
    write('y.txt', 'y');
    const [x, y] = await Promise.all([
      git.commit({
        repo: repo.path,
        paths: ['x.txt'],
        message: 'x',
        opId: 'op-parallel-x',
        branch: 'main',
      }),
      git.commit({
        repo: repo.path,
        paths: ['y.txt'],
        message: 'y',
        opId: 'op-parallel-y',
        branch: 'main',
      }),
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
      branch: 'main',
    });
    write('b.txt', 'b');
    expect(await git.changedFilesSince(repo.path, base)).toEqual(['a.txt', 'b.txt']);
    expect(await git.commitsSince(repo.path, base)).toEqual([sha]);
  });

  it('lists the files committed between two commits, not what is uncommitted', async () => {
    const base = await git.head(repo.path);
    mkdirSync(join(repo.path, 'dir'));
    write('dir/a.txt', 'a');
    write('b.txt', 'b');
    const { sha } = await git.commit({
      repo: repo.path,
      paths: ['dir/a.txt', 'b.txt'],
      message: 'a and b',
      opId: 'op-history-2',
      branch: 'main',
    });
    write('c.txt', 'c');
    expect(await git.filesChangedBetween(repo.path, base, sha)).toEqual(['b.txt', 'dir/a.txt']);
    expect(await git.filesChangedBetween(repo.path, sha, sha)).toEqual([]);
  });
});

describe('gitDirs', () => {
  it('names one directory for both in an ordinary checkout', async () => {
    const gitDir = join(realpathSync(repo.path), '.git');
    expect(await git.gitDirs(repo.path)).toEqual({ gitDir, commonDir: gitDir });
  });

  it("names a linked worktree's own git dir and the main repository's common dir", async () => {
    const outside = tempDir('worktree');
    try {
      const checkout = join(outside.path, 'wt');
      rawGit('worktree', 'add', '-q', '-b', 'wt', checkout);
      const commonDir = join(realpathSync(repo.path), '.git');
      expect(await git.gitDirs(checkout)).toEqual({
        gitDir: join(commonDir, 'worktrees', 'wt'),
        commonDir,
      });
    } finally {
      outside.cleanup();
    }
  });
});

describe('changedPaths', () => {
  it.each([
    {
      name: 'a modified file',
      arrange: () => {
        write('README.md', 'edited');
      },
      expected: ['README.md'],
    },
    {
      name: 'an untracked file',
      arrange: () => {
        write('new.txt', 'n');
      },
      expected: ['new.txt'],
    },
    {
      name: 'a deleted file',
      arrange: () => {
        rmSync(join(repo.path, 'README.md'));
      },
      expected: ['README.md'],
    },
    {
      name: 'a staged rename, as the old path gone and the new one added',
      arrange: () => {
        rawGit('mv', 'README.md', 'DOC.md');
      },
      expected: ['DOC.md', 'README.md'],
    },
    {
      name: 'a file made executable',
      arrange: () => {
        chmodSync(join(repo.path, 'README.md'), 0o755);
      },
      expected: ['README.md'],
    },
    {
      name: 'a file swapped for a link',
      arrange: () => {
        rmSync(join(repo.path, 'README.md'));
        symlinkSync('/etc/hosts', join(repo.path, 'README.md'));
      },
      expected: ['README.md'],
    },
    {
      name: 'a path containing a space',
      arrange: () => {
        write('with space.txt', 's');
      },
      expected: ['with space.txt'],
    },
    {
      name: 'nothing for an ignored file',
      arrange: () => {
        write('.git/info/exclude', 'build/\n');
        mkdirSync(join(repo.path, 'build'));
        write('build/out.js', 'x');
      },
      expected: [],
    },
    {
      name: 'nothing for a file only touched',
      arrange: () => {
        const later = new Date(Date.now() + 60_000);
        utimesSync(join(repo.path, 'README.md'), later, later);
      },
      expected: [],
    },
  ])('reports $name', async ({ arrange, expected }) => {
    arrange();
    expect(await git.changedPaths(repo.path)).toEqual(expected);
  });

  it('reports only the paths it is asked about', async () => {
    write('README.md', 'edited');
    write('new.txt', 'n');
    write('other.txt', 'o');
    expect(await git.changedPaths(repo.path, ['new.txt', 'README.md', 'gone.txt'])).toEqual([
      'README.md',
      'new.txt',
    ]);
  });

  // A read that refreshed the index would hold index.lock, and a lane's commit running then fails.
  it('leaves a stale index unwritten', async () => {
    const index = join(repo.path, '.git', 'index');
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(repo.path, 'README.md'), later, later);
    const before = readFileSync(index);
    expect(await git.changedPaths(repo.path)).toEqual([]);
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
    expect(() => rawGit('rev-parse', '--abbrev-ref', '@{u}')).toThrow(/no upstream configured/);
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

  it('pushes a branch and records its upstream, and pushing it again changes nothing', async () => {
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

  it('reports how long a push ran and what git printed', async () => {
    await git.switchNewBranch(remote.repo.path, '10db/x-0a1b2c3d', 'main');
    const run = await git.push(remote.repo.path, '10db/x-0a1b2c3d', net);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.output).toContain('[new branch]');
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
    local('remote', 'set-url', 'origin', 'git@example.invalid:hang.git');
    // ssh is replaced by a command that hangs; git appends the host and command as arguments.
    const hang = {
      env: { ...NETWORK_ENV, GIT_SSH_COMMAND: 'sleep 5; true', GIT_SSH_VARIANT: 'simple' },
      timeoutMs: 300,
    };
    await expect(git.fetch(remote.repo.path, 'main', hang)).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('stops a push that runs past its timeout, with every process its transport started', async () => {
    // Set before the daemon's first call there, which records origin's URLs.
    local('remote', 'set-url', '--push', 'origin', HANGING_SSH_URL);
    await git.switchNewBranch(remote.repo.path, '10db/x-0a1b2c3d', 'main');
    const ssh = hangingSsh(30);
    try {
      const push = git.push(remote.repo.path, '10db/x-0a1b2c3d', {
        env: { ...NETWORK_ENV, ...ssh.env },
        timeoutMs: 1_000,
      });
      const timedOut = expect(push).rejects.toMatchObject({ kind: 'timeout' });
      const child = await ssh.childPid();
      await timedOut;
      await waitFor(() => !alive(child), 2_000);
      expect(() => origin('rev-parse', '--verify', '-q', 'refs/heads/10db/x-0a1b2c3d')).toThrow();
    } finally {
      ssh.cleanup();
    }
  });

  it('stops a fetch when its signal aborts', async () => {
    local('remote', 'set-url', 'origin', 'git@example.invalid:hang.git');
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
        expect(await git.changedPaths(repo.path)).toEqual(['new.txt']);
      },
    },
    {
      name: 'commit writes to',
      act: async () => {
        write('a.txt', 'a');
        await git.commit({
          repo: repo.path,
          paths: ['a.txt'],
          message: 'a',
          opId: 'op-hook-1',
          branch: 'main',
        });
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

describe('diffSince', () => {
  const commitAll = (message: string) => {
    rawGit('add', '-A');
    rawGit('commit', '-q', '-m', message);
  };

  it('returns the diff and numstat from the base to HEAD', async () => {
    const base = rawGit('rev-parse', 'HEAD');
    write('a.txt', 'one\ntwo\n');
    writeFileSync(join(repo.path, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    commitAll('add files');

    const changes = await git.diffSince(repo.path, base, 512 * 1024);

    expect(changes.truncated).toBe(false);
    expect(changes.diff).toContain('diff --git a/a.txt b/a.txt');
    expect(changes.diff).toContain('+two');
    expect([...changes.files].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'a.txt', added: 2, removed: 0 },
      { path: 'blob.bin', added: null, removed: null },
    ]);
  });

  it('is empty when nothing changed since the base', async () => {
    expect(await git.diffSince(repo.path, rawGit('rev-parse', 'HEAD'), 1024)).toEqual({
      diff: '',
      truncated: false,
      files: [],
    });
  });

  it('caps the diff at the byte limit, on a character boundary, and flags it', async () => {
    const base = rawGit('rev-parse', 'HEAD');
    write('big.txt', `${'é'.repeat(2000)}\n`);
    write('other.txt', 'x\n');
    commitAll('big');

    const changes = await git.diffSince(repo.path, base, 1001);

    expect(changes.truncated).toBe(true);
    expect(Buffer.byteLength(changes.diff)).toBeLessThanOrEqual(1001);
    expect(changes.diff).not.toContain('�');
    // The counts cover every file even when the text was cut.
    expect(changes.files.map((f) => f.path).sort()).toEqual(['big.txt', 'other.txt']);
  });

  it('does not run a textconv driver or an external diff program', async () => {
    const base = rawGit('rev-parse', 'HEAD');
    const textconvMark = join(repo.path, '..', `textconv-ran-${String(process.pid)}`);
    const externalMark = join(repo.path, '..', `external-ran-${String(process.pid)}`);
    write('.gitattributes', '*.dat diff=evil\n');
    write('f.dat', 'payload\n');
    commitAll('add dat');
    rawGit('config', 'diff.evil.textconv', `sh -c 'touch ${textconvMark}; cat' --`);
    rawGit('config', 'diff.external', `sh -c 'touch ${externalMark}' --`);
    write('f.dat', 'changed\n');
    commitAll('change dat');

    const changes = await git.diffSince(repo.path, base, 512 * 1024);

    expect(changes.diff).toContain('+changed');
    expect(existsSync(textconvMark)).toBe(false);
    expect(existsSync(externalMark)).toBe(false);
  });
});
