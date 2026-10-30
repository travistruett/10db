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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTempRepo,
  createTempRepoWithOrigin,
  isolatedGitEnv,
  tempDir,
} from '../../test/fixtures';
import type { TempDir } from '../../test/fixtures';
import { gitWrapper } from '../../test/git-wrapper';
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
    lockReason: '10db bat_0a1',
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
    expect(entry?.locked).toBe('10db bat_0a1');
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

  it('creates nothing when the path and its missing parent lie outside the root', async () => {
    await expect(
      git.addWorktree({
        repo: main(),
        path: join(elsewhere.path, 'missing', 'deeper', 'a'),
        branch: 'b',
        startPoint: 'main',
        lockReason: '10db bat_0a1',
      }),
    ).rejects.toBeInstanceOf(InvalidError);
    expect(existsSync(join(elsewhere.path, 'missing'))).toBe(false);
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
        lockReason: '10db bat_0a1',
      }),
    ).rejects.toBeInstanceOf(InvalidError);
    expect(raw(main(), 'branch', '--list', 'b')).toBe('');
  });

  it('leaves nothing behind when checking out the new worktree fails', async () => {
    const wrapper = gitWrapper(
      `case " $* " in *" read-tree "*" -u "*) echo 'read-tree failed' >&2; exit 1;; esac\nexec "$GIT" "$@"`,
    );
    try {
      vi.stubEnv('PATH', wrapper.path);
      await expect(add('a', '10db/a-1')).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      wrapper.cleanup();
    }
    expect(await listed()).toEqual([real(main())]);
    expect(existsSync(at('a'))).toBe(false);
    expect(existsSync(join(main(), '.git', 'worktrees', 'a'))).toBe(false);
    expect(pins.get(real(at('a')))).toBeUndefined();
    expect(raw(main(), 'branch', '--list', '10db/a-1')).toBe('');
  });

  it('writes an absolute gitfile when the repository asks git for relative ones', async () => {
    // Git 2.48 and later write a relative gitfile under this setting; an older git ignores it.
    raw(main(), 'config', 'worktree.useRelativePaths', 'true');
    await add('a');
    expect(readFileSync(join(at('a'), '.git'), 'utf8')).toMatch(/^gitdir: \//);
    expect(await git.currentBranch(at('a'))).toBe('10db/a');
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
    expect(error).toMatchObject({ detail: { kind: GitTrustFailure.Unpinned } });
    expect(refused.map((e) => e.detail.kind)).toEqual([GitTrustFailure.Unpinned]);
  });

  it('is refused as moved when its gitfile is swapped for another worktree', async () => {
    await add('a');
    await add('b');
    const bGitfile = readFileSync(join(at('b'), '.git'), 'utf8');
    writeFileSync(join(at('a'), '.git'), bGitfile);
    const error = await git.currentBranch(at('a')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitTrustError);
    expect(error).toMatchObject({ detail: { kind: GitTrustFailure.Moved } });
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

  it('refuses the root itself, even when it is a locked worktree and named by its real path', async () => {
    raw(
      main(),
      'worktree',
      'add',
      '-q',
      '--lock',
      '--reason',
      '10db bat_root',
      '-b',
      'r',
      root.path,
    );
    await expect(git.removeWorktree(main(), real(root.path))).rejects.toBeInstanceOf(
      WorktreeNotOursError,
    );
    expect(await listed()).toContain(real(root.path));
  });

  it("refuses a lock that isn't a 10db batch's", async () => {
    raw(main(), 'worktree', 'add', '-q', '--lock', '--reason', '10db nothing', '-b', 'l', at('l'));
    await expect(git.removeWorktree(main(), at('l'))).rejects.toBeInstanceOf(WorktreeNotOursError);
    expect(await listed()).toContain(real(at('l')));
  });

  it('refuses when no worktree root is configured', async () => {
    await add('a');
    await expect(createGit({ pins }).removeWorktree(main(), at('a'))).rejects.toBeInstanceOf(
      WorktreeNotOursError,
    );
    expect(await listed()).toContain(real(at('a')));
  });
});

describe('worktreeChanges', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });
  const gitDirOf = (path: string) =>
    realpathSync(
      readFileSync(join(path, '.git'), 'utf8')
        .replace(/^gitdir: /, '')
        .trim(),
    );

  it("lists a worktree's uncommitted changes", async () => {
    await add('a');
    writeFileSync(join(at('a'), 'notes.txt'), 'mine\n');
    await expect(git.worktreeChanges(main(), at('a'))).resolves.toEqual(['notes.txt']);
  });

  it.each<{ name: string; make: () => Promise<string> }>([
    {
      name: "a git dir outside the repository's worktrees",
      make: async () => {
        await add('a');
        const copy = join(elsewhere.path, 'gitdir');
        execFileSync('cp', ['-R', gitDirOf(at('a')), copy]);
        writeFileSync(join(at('a'), '.git'), `gitdir: ${copy}\n`);
        return at('a');
      },
    },
    {
      name: "a git dir nested deeper than the repository's worktrees",
      make: async () => {
        await add('a');
        const nested = join(gitDirOf(at('a')), 'nested');
        execFileSync('cp', ['-R', gitDirOf(at('a')), join(elsewhere.path, 'copy')]);
        execFileSync('mv', [join(elsewhere.path, 'copy'), nested]);
        writeFileSync(join(at('a'), '.git'), `gitdir: ${nested}\n`);
        return at('a');
      },
    },
    {
      name: 'a git dir whose commondir names another repository',
      make: async () => {
        await add('a');
        const other = createTempRepo();
        cleanups.push(() => {
          other.cleanup();
        });
        writeFileSync(join(gitDirOf(at('a')), 'commondir'), `${join(other.path, '.git')}\n`);
        return at('a');
      },
    },
    {
      name: "a worktree 10db didn't lock",
      make: () => {
        raw(main(), 'worktree', 'add', '-q', '-b', 'foreign', at('foreign'));
        return Promise.resolve(at('foreign'));
      },
    },
    {
      name: "a directory git doesn't list",
      make: async () => {
        await add('a');
        mkdirSync(at('copy'));
        writeFileSync(join(at('copy'), '.git'), readFileSync(join(at('a'), '.git')));
        return at('copy');
      },
    },
  ])('refuses $name', async ({ make }) => {
    const path = await make();
    await expect(git.worktreeChanges(main(), path)).rejects.toBeInstanceOf(WorktreeNotOursError);
  });
});

describe('worktreeIgnoredFiles', () => {
  /** Ignores these patterns in every worktree of the repository, with nothing to commit. */
  const ignore = (...patterns: string[]) => {
    writeFileSync(join(main(), '.git', 'info', 'exclude'), `${patterns.join('\n')}\n`);
  };

  it.each<{ name: string; files: string[]; listed: string[] }>([
    { name: 'an ignored file at the top', files: ['.env'], listed: ['.env'] },
    {
      name: 'ignored files in directories git does not track',
      files: ['apps/web/.env.local', 'src/run.log'],
      listed: ['apps/web/.env.local', 'src/run.log'],
    },
    { name: 'an ignored directory', files: ['dist/out.js', 'node_modules/x/i.js'], listed: [] },
    { name: 'an untracked file that is not ignored', files: ['notes.txt'], listed: [] },
  ])('lists $name', async ({ files, listed: expected }) => {
    ignore('.env', '.env.*', '*.log', 'dist/', 'node_modules/');
    await add('a');
    for (const file of files) {
      mkdirSync(dirname(join(at('a'), file)), { recursive: true });
      writeFileSync(join(at('a'), file), 'local\n');
    }
    await expect(git.worktreeIgnoredFiles(main(), at('a'))).resolves.toEqual(expected);
  });

  it("refuses a worktree 10db didn't lock", async () => {
    raw(main(), 'worktree', 'add', '-q', '-b', 'foreign', at('foreign'));
    await expect(git.worktreeIgnoredFiles(main(), at('foreign'))).rejects.toBeInstanceOf(
      WorktreeNotOursError,
    );
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

  /** The local config keys of branch `name`'s section, sorted. */
  const branchKeys = (name: string) =>
    raw(main(), 'config', '--local', '--name-only', '--list')
      .split('\n')
      .filter(
        (key) => key.startsWith(`branch.${name}.`) && !key.slice(name.length + 8).includes('.'),
      )
      .sort();

  /** A branch as 10db's push leaves it: head, remote-tracking ref and upstream config. */
  const pushedBranch = (name: string, sha: string) => {
    raw(main(), 'update-ref', `refs/heads/${name}`, sha);
    raw(main(), 'update-ref', `refs/remotes/origin/${name}`, sha);
    raw(main(), 'config', `branch.${name}.remote`, 'origin');
    raw(main(), 'config', `branch.${name}.merge`, `refs/heads/${name}`);
  };

  it('deletes the remote-tracking ref with the branch, and the branch config, but no neighbour', async () => {
    const first = raw(main(), 'rev-parse', 'HEAD');
    pushedBranch('10db/a.b', first);
    pushedBranch('10db/a.bc', first);
    pushedBranch('10db/a.b.c', first);
    await expect(git.deleteBranchIfAt(main(), '10db/a.b', first, first)).resolves.toBe(true);
    expect(raw(main(), 'for-each-ref', '--format=%(refname)', 'refs/heads/10db/a.b')).toBe('');
    expect(raw(main(), 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/10db/a.b')).toBe(
      '',
    );
    expect(branchKeys('10db/a.b')).toEqual([]);
    expect(branchKeys('10db/a.bc')).toEqual(['branch.10db/a.bc.merge', 'branch.10db/a.bc.remote']);
    expect(branchKeys('10db/a.b.c')).toEqual([
      'branch.10db/a.b.c.merge',
      'branch.10db/a.b.c.remote',
    ]);
    expect(raw(main(), 'rev-parse', 'refs/remotes/origin/10db/a.bc')).toBe(first);
  });

  it('changes nothing when the remote-tracking ref moved, and leaves it when not named', async () => {
    const first = raw(main(), 'rev-parse', 'HEAD');
    pushedBranch('10db/x', first);
    raw(main(), 'commit', '-q', '--allow-empty', '-m', 'second');
    const second = raw(main(), 'rev-parse', 'HEAD');
    raw(main(), 'update-ref', 'refs/remotes/origin/10db/x', second);
    await expect(git.deleteBranchIfAt(main(), '10db/x', first, first)).resolves.toBe(false);
    expect(raw(main(), 'rev-parse', 'refs/heads/10db/x')).toBe(first);
    expect(raw(main(), 'rev-parse', 'refs/remotes/origin/10db/x')).toBe(second);
    expect(branchKeys('10db/x')).toEqual(['branch.10db/x.merge', 'branch.10db/x.remote']);

    await expect(git.deleteBranchIfAt(main(), '10db/x', first, null)).resolves.toBe(true);
    expect(raw(main(), 'for-each-ref', '--format=%(refname)', 'refs/heads/10db/x')).toBe('');
    expect(raw(main(), 'rev-parse', 'refs/remotes/origin/10db/x')).toBe(second);
    expect(branchKeys('10db/x')).toEqual([]);
    before = mainState();
  });

  it('reads the remote-tracking tip, and null when there is none', async () => {
    const first = raw(main(), 'rev-parse', 'HEAD');
    pushedBranch('10db/t', first);
    await expect(git.trackingTip(main(), '10db/t')).resolves.toBe(first);
    await expect(git.trackingTip(main(), '10db/none')).resolves.toBeNull();
  });
});

describe('branchInUse', () => {
  it('is null for a branch nothing has out', async () => {
    raw(main(), 'branch', '10db/free');
    await expect(git.branchInUse(main(), '10db/free')).resolves.toBeNull();
  });

  it('names the main checkout when the branch is checked out there', async () => {
    await expect(git.branchInUse(main(), 'main')).resolves.toBe(realpathSync(main()));
  });

  it('names a worktree that has the branch checked out', async () => {
    raw(main(), 'branch', '10db/out');
    const other = join(elsewhere.path, 'out');
    raw(main(), 'worktree', 'add', '-q', other, '10db/out');
    await expect(git.branchInUse(main(), '10db/out')).resolves.toBe(realpathSync(other));
  });

  it('names a worktree that is rebasing the branch, where it shows as detached', async () => {
    raw(main(), 'branch', '10db/rebasing');
    const other = join(elsewhere.path, 'rebasing');
    raw(main(), 'worktree', 'add', '-q', other, '10db/rebasing');
    raw(other, 'commit', '-q', '--allow-empty', '-m', 'on the branch');
    // A rebase that stops after its first pick leaves the worktree detached, mid-rebase.
    expect(() => raw(other, 'rebase', '-q', '--exec', 'false', 'HEAD~1')).toThrow();
    expect(raw(other, 'branch', '--show-current')).toBe('');
    await expect(git.branchInUse(main(), '10db/rebasing')).resolves.toBe(realpathSync(other));
  });
});

describe('localBranches', () => {
  it('lists the local branches under a prefix with their tips, sorted, and no others', async () => {
    const first = raw(main(), 'rev-parse', 'HEAD');
    raw(main(), 'branch', '10db/b');
    raw(main(), 'branch', '10db/a');
    raw(main(), 'branch', 'feature/10db/x');
    raw(main(), 'branch', '10dbx');
    raw(main(), 'commit', '-q', '--allow-empty', '-m', 'second');
    raw(main(), 'update-ref', 'refs/heads/10db/b', raw(main(), 'rev-parse', 'HEAD'));
    await expect(git.localBranches(main(), '10db/')).resolves.toEqual([
      { name: '10db/a', sha: first },
      { name: '10db/b', sha: raw(main(), 'rev-parse', 'HEAD') },
    ]);
    await expect(git.localBranches(main(), 'nothing/')).resolves.toEqual([]);
    before = mainState();
  });

  it('answers one branch tip, and null for a branch that is not there', async () => {
    raw(main(), 'branch', '10db/a');
    await expect(git.branchTip(main(), '10db/a')).resolves.toBe(raw(main(), 'rev-parse', '10db/a'));
    await expect(git.branchTip(main(), '10db/none')).resolves.toBeNull();
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
