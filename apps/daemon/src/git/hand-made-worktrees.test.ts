import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepoWithOrigin, isolatedGitEnv, tempDir } from '../../test/fixtures';
import type { TempDir } from '../../test/fixtures';
import {
  createGit,
  handMadeWorktreeFolders,
  memoryPinStore,
  WorktreeNotOursError,
  type Git,
} from './index';

let fixture: ReturnType<typeof createTempRepoWithOrigin>;
let ownRoot: TempDir;
let elsewhere: TempDir;
let git: Git;
let folder: string;
let noindexFolder: string;

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
  folder = handMadeWorktreeFolders(main())[1] ?? '';
  noindexFolder = handMadeWorktreeFolders(main())[0] ?? '';
  git = createGit({
    worktreeRoot: ownRoot.path,
    pins: memoryPinStore(),
    onRefused: () => undefined,
  });
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
  rmSync(noindexFolder, { recursive: true, force: true });
  fixture.cleanup();
  ownRoot.cleanup();
  elsewhere.cleanup();
});

describe('handMadeWorktreeFolders', () => {
  it('names the .noindex folder beside the checkout first, then the older one', () => {
    expect(handMadeWorktreeFolders('/Users/me/Projects/10db')).toEqual([
      '/Users/me/Projects/10db-worktrees.noindex',
      '/Users/me/Projects/10db-worktrees',
    ]);
  });
});

describe('a worktree the builder made by hand', () => {
  it('shows what it holds that is not committed, and is read and removed with its ignored node_modules, its branch staying', async () => {
    const dirty = handMade('dirty');
    writeFileSync(join(dirty, 'wip.txt'), 'unsaved');
    await expect(git.handMadeWorktreeChanges(main(), dirty)).resolves.toEqual(['wip.txt']);

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

  it('is read and removed from the .noindex folder as from the older one', async () => {
    const path = handMade('feature', noindexFolder);
    await expect(git.handMadeWorktreeChanges(main(), path)).resolves.toEqual([]);
    await expect(git.removeHandMadeWorktree(main(), path)).resolves.toBe('removed');
    expect(existsSync(path)).toBe(false);
  });

  it('puts a removed worktree back on its branch, and refuses a taken path or a missing branch without changing anything', async () => {
    const path = handMade('feature');
    await git.removeHandMadeWorktree(main(), path);

    mkdirSync(path);
    writeFileSync(join(path, 'mine.txt'), 'someone else');
    await expect(git.restoreHandMadeWorktree(main(), path, 'hand/feature')).resolves.toBe(
      'path_exists',
    );
    expect(existsSync(join(path, 'mine.txt'))).toBe(true);
    rmSync(path, { recursive: true });

    await expect(git.restoreHandMadeWorktree(main(), path, 'hand/gone')).resolves.toBe(
      'branch_gone',
    );
    expect(existsSync(path)).toBe(false);

    await expect(git.restoreHandMadeWorktree(main(), path, 'hand/feature')).resolves.toBe(
      'restored',
    );
    expect(raw(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('hand/feature');
    expect(existsSync(join(path, 'README.md'))).toBe(true);
    await expect(git.handMadeWorktreeChanges(main(), path)).resolves.toEqual([]);
    await expect(git.restoreHandMadeWorktree(main(), path, 'hand/feature')).resolves.toBe(
      'path_exists',
    );
  });

  it('puts nothing back outside the hand-made folders', async () => {
    await expect(
      git.restoreHandMadeWorktree(main(), join(elsewhere.path, 'away'), 'main'),
    ).rejects.toBeInstanceOf(WorktreeNotOursError);
    await expect(git.restoreHandMadeWorktree(main(), folder, 'main')).rejects.toBeInstanceOf(
      WorktreeNotOursError,
    );
    expect(existsSync(join(elsewhere.path, 'away'))).toBe(false);
  });

  it('reads the newest touch of a worktree from its admin files, its root and its top level, not from deeper files', async () => {
    const path = handMade('feature');
    const day = new Date('2026-01-01T00:00:00Z');
    const gitDir = raw(path, 'rev-parse', '--absolute-git-dir');
    const old = (file: string): void => {
      utimesSync(file, day, day);
    };
    for (const file of ['HEAD', 'index', join('logs', 'HEAD')]) old(join(gitDir, file));
    for (const entry of readdirSync(path)) old(join(path, entry));
    old(path);
    await expect(git.handMadeWorktreeIdleSince(main(), path)).resolves.toEqual(day);

    mkdirSync(join(path, 'deep', 'er'), { recursive: true });
    old(join(path, 'deep'));
    old(path);
    writeFileSync(join(path, 'deep', 'er', 'file.txt'), 'x');
    await expect(git.handMadeWorktreeIdleSince(main(), path)).resolves.toEqual(day);

    const touched = new Date('2026-02-02T00:00:00Z');
    utimesSync(join(gitDir, 'index'), touched, touched);
    await expect(git.handMadeWorktreeIdleSince(main(), path)).resolves.toEqual(touched);
    const later = new Date('2026-03-03T00:00:00Z');
    utimesSync(join(path, 'README.md'), later, later);
    await expect(git.handMadeWorktreeIdleSince(main(), path)).resolves.toEqual(later);
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
  it('is never removed or read when locked, outside the folder, the folder itself or not a worktree', async () => {
    const caught = (act: Promise<unknown>) =>
      act.then(
        () => 'no refusal',
        (error: unknown) => error,
      );
    for (const { name, make } of refusals) {
      const path = make();
      expect
        .soft(await caught(git.removeHandMadeWorktree(main(), path)), `remove: ${name}`)
        .toBeInstanceOf(WorktreeNotOursError);
      expect
        .soft(await caught(git.handMadeWorktreeChanges(main(), path)), `read: ${name}`)
        .toBeInstanceOf(WorktreeNotOursError);
      expect.soft(existsSync(path), `kept: ${name}`).toBe(true);
    }
  });
});
