import { execFileSync } from 'node:child_process';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidError } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDecoyRepo } from '../../test/decoy-repo';
import { createTempRepo, isolatedGitEnv, tempDir } from '../../test/fixtures';
import type { TempDir } from '../../test/fixtures';
import { createGit } from './index';

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
