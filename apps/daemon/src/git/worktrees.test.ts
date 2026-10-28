import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { InvalidError } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepoWithOrigin, isolatedGitEnv, tempDir } from '../../test/fixtures';
import type { TempDir } from '../../test/fixtures';
import {
  createGit,
  GitTrustError,
  GitTrustFailure,
  memoryPinStore,
  WorktreeNotOursError,
  type Git,
} from './index';

let fixture: ReturnType<typeof createTempRepoWithOrigin>;
let root: TempDir;
let elsewhere: TempDir;
let refused: GitTrustError[];
let pins: ReturnType<typeof memoryPinStore>;
let git: Git;
let before: string;

const raw = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();
const main = () => fixture.repo.path;
const mainState = () =>
  [
    raw(main(), 'rev-parse', 'HEAD'),
    raw(main(), 'symbolic-ref', 'HEAD'),
    raw(main(), 'ls-files', '-s'),
    raw(main(), 'status', '--porcelain'),
  ].join('\n');
const at = (name: string) => join(root.path, name);
/** `path` with its parent read through links; the leaf may be gone. */
const real = (path: string) => join(realpathSync(dirname(path)), basename(path));
const add = (name: string, branch = `10db/${name}`, startPoint: string | null = 'main') =>
  git.addWorktree({
    repo: main(),
    path: at(name),
    branch,
    startPoint,
    lockReason: '10db bat_test',
  });
const listed = async () => (await git.listWorktrees(main())).map((e) => e.path);

beforeEach(() => {
  fixture = createTempRepoWithOrigin();
  root = tempDir('worktrees');
  elsewhere = tempDir('elsewhere');
  refused = [];
  pins = memoryPinStore();
  git = createGit({
    worktreeRoot: root.path,
    pins,
    onRefused: (error) => refused.push(error),
  });
  before = mainState();
});
afterEach(() => {
  expect(mainState()).toBe(before);
  fixture.cleanup();
  root.cleanup();
  elsewhere.cleanup();
});

describe('addWorktree', () => {
  it('makes the branch at the start point and a locked worktree on it', async () => {
    const head = await add('a', '10db/a-1');
    expect(head).toBe(raw(main(), 'rev-parse', 'main'));
    const entry = (await git.listWorktrees(main())).find((e) => e.path === real(at('a')));
    expect(entry?.locked).toBe('10db bat_test');
    expect(entry?.branch).toBe('10db/a-1');
    expect(await git.currentBranch(at('a'))).toBe('10db/a-1');
    expect(readFileSync(join(at('a'), 'README.md'), 'utf8')).toBe('# fixture\n');
    expect(existsSync(join((await git.gitDirs(at('a'))).gitDir, 'index'))).toBe(true);
  });

  it('adds a worktree on a branch that already exists', async () => {
    raw(main(), 'branch', 'feat');
    await add('a', 'feat', null);
    expect(await git.currentBranch(at('a'))).toBe('feat');
    expect(existsSync(join(at('a'), 'README.md'))).toBe(true);
  });

  it('refuses a branch that already exists and makes nothing', async () => {
    raw(main(), 'branch', 'dup');
    await expect(add('a', 'dup')).rejects.toBeInstanceOf(InvalidError);
    expect(await listed()).toEqual([real(main())]);
    expect(existsSync(at('a'))).toBe(false);
  });

  it('refuses a missing branch when no start point is given', async () => {
    await expect(add('a', 'nope', null)).rejects.toBeInstanceOf(InvalidError);
    expect(existsSync(at('a'))).toBe(false);
  });

  it('refuses a path that exists, and makes no branch', async () => {
    mkdirSync(at('a'));
    await expect(add('a', 'fresh')).rejects.toBeInstanceOf(InvalidError);
    expect(raw(main(), 'branch', '--list', 'fresh')).toBe('');
    expect(await listed()).toEqual([real(main())]);
  });

  it('refuses a path outside the worktree root', async () => {
    await expect(
      git.addWorktree({
        repo: main(),
        path: join(elsewhere.path, 'a'),
        branch: 'b',
        startPoint: 'main',
        lockReason: '10db bat_test',
      }),
    ).rejects.toBeInstanceOf(InvalidError);
    expect(raw(main(), 'branch', '--list', 'b')).toBe('');
  });

  it("records the worktree's pin at creation", async () => {
    await add('a');
    const other = createGit({ worktreeRoot: root.path, pins });
    const dirs = await other.gitDirs(at('a'));
    expect(dirs.commonDir).toBe(real(join(main(), '.git')));
    expect(pins.get(real(at('a')))?.gitDir).toBe(dirs.gitDir);
  });
});

describe('a path under the worktree root', () => {
  it('is refused when it has no pin', async () => {
    raw(main(), 'worktree', 'add', '-q', '-b', 'foreign', join(root.path, 'foreign'));
    const error = await git.currentBranch(join(root.path, 'foreign')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitTrustError);
    expect((error as GitTrustError).detail.kind).toBe(GitTrustFailure.Unpinned);
    expect(refused.map((e) => e.detail.kind)).toEqual([GitTrustFailure.Unpinned]);
  });

  it('is refused as moved when its gitfile is swapped for another worktree', async () => {
    await add('a');
    await add('b');
    const bGitfile = readFileSync(join(at('b'), '.git'), 'utf8');
    writeFileSync(join(at('a'), '.git'), bGitfile);
    const error = await git.currentBranch(at('a')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitTrustError);
    expect((error as GitTrustError).detail.kind).toBe(GitTrustFailure.Moved);
  });
});

describe('removeWorktree', () => {
  it('removes a listed 10db worktree, its directory and its pin', async () => {
    await add('a');
    await expect(git.removeWorktree(main(), at('a'))).resolves.toBe('removed');
    expect(await listed()).toEqual([real(main())]);
    expect(existsSync(at('a'))).toBe(false);
    expect(pins.get(real(at('a')))).toBeUndefined();
  });

  it('removes a locked entry whose directory is gone', async () => {
    await add('a');
    rmSync(at('a'), { recursive: true, force: true });
    await expect(git.removeWorktree(main(), at('a'))).resolves.toBe('removed');
    expect(await listed()).toEqual([real(main())]);
    expect(pins.get(real(at('a')))).toBeUndefined();
  });

  it("answers absent for a path git doesn't list and that is gone", async () => {
    await expect(git.removeWorktree(main(), at('nothing'))).resolves.toBe('absent');
  });

  it("refuses a directory git doesn't list, and keeps it", async () => {
    mkdirSync(at('plain'));
    writeFileSync(join(at('plain'), 'x'), 'x');
    await expect(git.removeWorktree(main(), at('plain'))).rejects.toBeInstanceOf(
      WorktreeNotOursError,
    );
    expect(existsSync(join(at('plain'), 'x'))).toBe(true);
  });

  it('refuses a path outside the root, and keeps the worktree listed', async () => {
    const path = join(elsewhere.path, 'theirs');
    raw(main(), 'worktree', 'add', '-q', '-b', 'theirs', path);
    await expect(git.removeWorktree(main(), path)).rejects.toBeInstanceOf(WorktreeNotOursError);
    expect(await listed()).toContain(real(path));
  });

  it("refuses a worktree under the root that 10db didn't lock", async () => {
    raw(main(), 'worktree', 'add', '-q', '-b', 'foreign', at('foreign'));
    await expect(git.removeWorktree(main(), at('foreign'))).rejects.toBeInstanceOf(
      WorktreeNotOursError,
    );
    expect(await listed()).toContain(real(at('foreign')));
  });

  it('refuses a link to a worktree, and keeps the worktree', async () => {
    await add('a');
    symlinkSync(real(at('a')), at('link'));
    await expect(git.removeWorktree(main(), at('link'))).rejects.toBeInstanceOf(
      WorktreeNotOursError,
    );
    expect(await listed()).toContain(real(at('a')));
    expect(existsSync(join(at('a'), 'README.md'))).toBe(true);
  });

  it('refuses the root itself', async () => {
    await expect(git.removeWorktree(main(), root.path)).rejects.toBeInstanceOf(
      WorktreeNotOursError,
    );
  });

  it('refuses when no worktree root is configured', async () => {
    await add('a');
    await expect(createGit({ pins }).removeWorktree(main(), at('a'))).rejects.toBeInstanceOf(
      WorktreeNotOursError,
    );
    expect(await listed()).toContain(real(at('a')));
  });
});

describe('deleteBranchIfAt', () => {
  it('deletes a branch at that sha and keeps one that moved', async () => {
    const first = raw(main(), 'rev-parse', 'HEAD');
    raw(main(), 'branch', 'gone');
    await expect(git.deleteBranchIfAt(main(), 'gone', first)).resolves.toBe(true);
    expect(raw(main(), 'branch', '--list', 'gone')).toBe('');

    raw(main(), 'branch', 'moved');
    raw(main(), 'commit', '-q', '--allow-empty', '-m', 'second');
    const second = raw(main(), 'rev-parse', 'HEAD');
    raw(main(), 'update-ref', 'refs/heads/moved', second);
    await expect(git.deleteBranchIfAt(main(), 'moved', first)).resolves.toBe(false);
    expect(raw(main(), 'rev-parse', 'moved')).toBe(second);
    await expect(git.deleteBranchIfAt(main(), 'never-was', first)).resolves.toBe(false);
    before = mainState();
  });
});

describe('ignoredDirectories', () => {
  it('lists top-level and nested ignored directories', async () => {
    writeFileSync(join(main(), '.gitignore'), 'node_modules/\n');
    mkdirSync(join(main(), 'node_modules'));
    writeFileSync(join(main(), 'node_modules', 'f'), 'f');
    mkdirSync(join(main(), 'apps', 'web', 'node_modules'), { recursive: true });
    writeFileSync(join(main(), 'apps', 'web', 'node_modules', 'f'), 'f');
    writeFileSync(join(main(), 'apps', 'web', 'x'), 'x');
    raw(main(), 'add', '.gitignore', 'apps/web/x');
    raw(main(), 'commit', '-q', '-m', 'ignore');
    before = mainState();
    expect(await git.ignoredDirectories(main())).toEqual(['apps/web/node_modules', 'node_modules']);
  });
});

describe('pruneWorktrees', () => {
  it('drops an unlocked entry whose directory is gone and keeps a locked one', async () => {
    await add('a');
    const path = join(elsewhere.path, 'theirs');
    raw(main(), 'worktree', 'add', '-q', '-b', 'theirs', path);
    rmSync(at('a'), { recursive: true, force: true });
    rmSync(path, { recursive: true, force: true });
    await git.pruneWorktrees(main());
    expect(await listed()).toEqual([real(main()), real(at('a'))].sort());
  });
});
