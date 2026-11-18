import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepoWithOrigin, isolatedGitEnv, tempDir } from '../../test/fixtures';
import type { TempDir } from '../../test/fixtures';
import {
  createGit,
  handMadeWorktreeFolder,
  memoryPinStore,
  WorktreeNotOursError,
  type Git,
} from './index';

let fixture: ReturnType<typeof createTempRepoWithOrigin>;
let ownRoot: TempDir;
let elsewhere: TempDir;
let git: Git;
let folder: string;

const raw = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();
const main = () => fixture.repo.path;
const at = (name: string) => join(folder, name);
/** A worktree made by hand, as the builder's `git worktree add ../<repo>-worktrees/<name>` does. */
const handMade = (name: string, where = folder): string => {
  mkdirSync(where, { recursive: true });
  const path = join(where, name);
  raw(main(), 'worktree', 'add', '-b', `hand/${name}`, path, 'main');
  return path;
};

beforeEach(() => {
  fixture = createTempRepoWithOrigin();
  ownRoot = tempDir('own-root');
  elsewhere = tempDir('elsewhere');
  folder = handMadeWorktreeFolder(main());
  git = createGit({
    worktreeRoot: ownRoot.path,
    pins: memoryPinStore(),
    onRefused: () => undefined,
  });
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
  fixture.cleanup();
  ownRoot.cleanup();
  elsewhere.cleanup();
});

describe('handMadeWorktreeFolder', () => {
  it('is the folder beside the checkout named for it', () => {
    expect(handMadeWorktreeFolder('/Users/me/Projects/10db')).toBe(
      '/Users/me/Projects/10db-worktrees',
    );
  });
});

describe('a worktree the builder made by hand', () => {
  it('is read and removed with its ignored node_modules, and its branch stays', async () => {
    writeFileSync(join(main(), '.git', 'info', 'exclude'), 'node_modules/\n', { flag: 'a' });
    const path = handMade('feature');
    mkdirSync(join(path, 'node_modules'));
    writeFileSync(join(path, 'node_modules', 'x.js'), 'x');
    await expect(git.handMadeWorktreeChanges(main(), path)).resolves.toEqual([]);
    await expect(git.handMadeWorktreeIgnoredFiles(main(), path)).resolves.toEqual([]);

    await expect(git.removeHandMadeWorktree(main(), path)).resolves.toBe('removed');

    expect(existsSync(path)).toBe(false);
    expect(raw(main(), 'branch', '--list', 'hand/feature')).toContain('hand/feature');
    await expect(git.removeHandMadeWorktree(main(), path)).resolves.toBe('absent');
  });

  it('shows what it holds that is not committed', async () => {
    const path = handMade('dirty');
    writeFileSync(join(path, 'wip.txt'), 'unsaved');
    await expect(git.handMadeWorktreeChanges(main(), path)).resolves.toEqual(['wip.txt']);
  });

  const refusals: readonly {
    readonly name: string;
    readonly make: () => string;
  }[] = [
    {
      name: 'locked, which is the builder’s mark that it stays',
      make: () => {
        const path = handMade('locked');
        raw(main(), 'worktree', 'lock', path);
        return path;
      },
    },
    { name: 'outside the folder', make: () => handMade('away', elsewhere.path) },
    { name: 'the folder itself', make: () => handMade('keep') && folder },
    {
      name: 'a directory git lists no worktree at',
      make: () => {
        mkdirSync(at('plain'), { recursive: true });
        return at('plain');
      },
    },
  ];
  for (const { name, make } of refusals)
    it(`is never removed or read when ${name}`, async () => {
      const path = make();
      await expect(git.removeHandMadeWorktree(main(), path)).rejects.toBeInstanceOf(
        WorktreeNotOursError,
      );
      await expect(git.handMadeWorktreeChanges(main(), path)).rejects.toBeInstanceOf(
        WorktreeNotOursError,
      );
      expect(existsSync(path)).toBe(true);
    });
});
