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
const add = (
  name: string,
  branch = `10db/${name}`,
  startPoint: string | null = 'main',
  lockReason = '10db bat_0a1',
) =>
  git.addWorktree({
    repo: main(),
    path: at(name),
    branch,
    startPoint,
    lockReason,
  });
/** A chat's worktree, locked with its chat's id. */
const addChat = (name: string) => add(name, `chat/${name}`, 'main', '10db cht_0a1');
const listed = async () => (await git.listWorktrees(main())).map((e) => e.path);
/** What `act` threw, or a note that it did not, so a soft check names the row. */
const caught = (act: Promise<unknown>) =>
  act.then(
    () => 'no refusal',
    (error: unknown) => error,
  );

function setUp(): void {
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
}
function tearDown(): void {
  fixture.cleanup();
  root.cleanup();
  elsewhere.cleanup();
}
/** A new repository and worktree root for the next row, after checking the last left main alone. */
function fresh(name: string): void {
  expect.soft(mainState(), `main untouched: ${name}`).toBe(before);
  tearDown();
  setUp();
}

beforeEach(setUp);
afterEach(() => {
  expect(mainState()).toBe(before);
  tearDown();
});

describe('addWorktree', () => {
  it('makes a locked, pinned worktree on a new or an existing branch, with Spotlight kept out of the root', async () => {
    const marker = join(root.path, '.metadata_never_index');
    expect(existsSync(marker)).toBe(false);
    const head = await add('a', '10db/a-1');
    expect(head).toBe(raw(main(), 'rev-parse', 'main'));
    const entry = (await git.listWorktrees(main())).find((e) => e.path === real(at('a')));
    expect(entry?.locked).toBe('10db bat_0a1');
    expect(entry?.branch).toBe('10db/a-1');
    expect(await git.currentBranch(at('a'))).toBe('10db/a-1');
    expect(readFileSync(join(at('a'), 'README.md'), 'utf8')).toBe('# fixture\n');
    expect(existsSync(join((await git.gitDirs(at('a'))).gitDir, 'index'))).toBe(true);
    // The pin is recorded at creation: another daemon on the same pins reads it.
    const other = createGit({ worktreeRoot: root.path, pins });
    const dirs = await other.gitDirs(at('a'));
    expect(dirs.commonDir).toBe(real(join(main(), '.git')));
    expect(pins.get(real(at('a')))?.gitDir).toBe(dirs.gitDir);
    // Spotlight's marker sits in the root, not in the worktree, and git status sees nothing of it.
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(join(at('a'), '.metadata_never_index'))).toBe(false);
    expect(raw(at('a'), 'status', '--porcelain', '--ignored')).toBe('');

    raw(main(), 'branch', 'feat');
    await add('b', 'feat', null);
    expect(await git.currentBranch(at('b'))).toBe('feat');
    expect(existsSync(join(at('b'), 'README.md'))).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('');
  });

  it('leaves a marker the root already holds as it is', async () => {
    const marker = join(root.path, '.metadata_never_index');
    writeFileSync(marker, 'kept');
    await add('spot');
    expect(readFileSync(marker, 'utf8')).toBe('kept');
  });

  it('refuses a taken branch, a missing one with no start point, a path that exists and one outside the root, making nothing', async () => {
    raw(main(), 'branch', 'dup');
    mkdirSync(at('taken'));
    const rows: readonly {
      name: string;
      act: () => Promise<unknown>;
      /** A path that must not be there after, and a branch that must not have been made. */
      path: string | null;
      branch?: string;
    }[] = [
      { name: 'a branch that already exists', act: () => add('a', 'dup'), path: at('a') },
      {
        name: 'a missing branch with no start point',
        act: () => add('b', 'nope', null),
        path: at('b'),
      },
      { name: 'a path that exists', act: () => add('taken', 'fresh'), path: null, branch: 'fresh' },
      {
        name: 'a path outside the root',
        act: () =>
          git.addWorktree({
            repo: main(),
            path: join(elsewhere.path, 'a'),
            branch: 'out',
            startPoint: 'main',
            lockReason: '10db bat_0a1',
          }),
        path: join(elsewhere.path, 'a'),
        branch: 'out',
      },
      {
        name: 'a path whose missing parent lies outside the root',
        act: () =>
          git.addWorktree({
            repo: main(),
            path: join(elsewhere.path, 'missing', 'deeper', 'a'),
            branch: 'deep',
            startPoint: 'main',
            lockReason: '10db bat_0a1',
          }),
        path: join(elsewhere.path, 'missing'),
        branch: 'deep',
      },
    ];
    for (const { name, act, path, branch } of rows) {
      expect.soft(await caught(act()), name).toBeInstanceOf(InvalidError);
      if (path) expect.soft(existsSync(path), `nothing made: ${name}`).toBe(false);
      if (branch)
        expect.soft(raw(main(), 'branch', '--list', branch), `no branch: ${name}`).toBe('');
    }
    expect(await listed()).toEqual([real(main())]);
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
});

describe('a path under the worktree root', () => {
  it('is refused when it has no pin, and as moved when its gitfile is swapped for another worktree', async () => {
    raw(main(), 'worktree', 'add', '-q', '-b', 'foreign', join(root.path, 'foreign'));
    const error = await git.currentBranch(join(root.path, 'foreign')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitTrustError);
    expect(error).toMatchObject({ detail: { kind: GitTrustFailure.Unpinned } });
    expect(refused.map((e) => e.detail.kind)).toEqual([GitTrustFailure.Unpinned]);

    await add('a');
    await add('b');
    const bGitfile = readFileSync(join(at('b'), '.git'), 'utf8');
    writeFileSync(join(at('a'), '.git'), bGitfile);
    const moved = await git.currentBranch(at('a')).catch((e: unknown) => e);
    expect(moved).toBeInstanceOf(GitTrustError);
    expect(moved).toMatchObject({ detail: { kind: GitTrustFailure.Moved } });
  });
});

describe('removeWorktree', () => {
  it("removes a batch's or a chat's worktree, or a locked entry whose directory is gone, with its pin, and answers absent after", async () => {
    await add('a');
    await addChat('c');
    await add('gone');
    await add('twice');
    rmSync(at('gone'), { recursive: true, force: true });
    await expect(git.removeWorktree(main(), at('a'))).resolves.toBe('removed');
    expect(existsSync(at('a'))).toBe(false);
    await expect(git.removeWorktree(main(), at('c'))).resolves.toBe('removed');
    await expect(git.removeWorktree(main(), at('gone'))).resolves.toBe('removed');
    // Two removals asked at once: the second finds it gone.
    const both = await Promise.all([
      git.removeWorktree(main(), at('twice')),
      git.removeWorktree(main(), at('twice')),
    ]);
    expect(both).toEqual(['removed', 'absent']);
    for (const name of ['a', 'c', 'gone', 'twice'])
      expect.soft(pins.get(real(at(name))), `pin of ${name}`).toBeUndefined();
    expect(await listed()).toEqual([real(main())]);
    // A path git doesn't list and that is gone.
    await expect(git.removeWorktree(main(), at('nothing'))).resolves.toBe('absent');
  });

  it("refuses what isn't a listed worktree 10db locked under its root, and keeps it", async () => {
    const rows: readonly {
      name: string;
      /** Makes the thing to remove; answers its path, the worktree still listed and the file still there after. */
      make: () => Promise<{ path: string; remover?: Git; listed?: string; file?: string }>;
    }[] = [
      {
        name: "a directory git doesn't list",
        make: () => {
          mkdirSync(at('plain'));
          writeFileSync(join(at('plain'), 'x'), 'x');
          return Promise.resolve({ path: at('plain'), file: join(at('plain'), 'x') });
        },
      },
      {
        name: 'a path outside the root',
        make: () => {
          const path = join(elsewhere.path, 'theirs');
          raw(main(), 'worktree', 'add', '-q', '-b', 'theirs', path);
          return Promise.resolve({ path, listed: real(path) });
        },
      },
      {
        name: "a worktree under the root that 10db didn't lock",
        make: () => {
          raw(main(), 'worktree', 'add', '-q', '-b', 'foreign', at('foreign'));
          return Promise.resolve({ path: at('foreign'), listed: real(at('foreign')) });
        },
      },
      {
        name: 'a link to a worktree',
        make: async () => {
          await add('a');
          symlinkSync(real(at('a')), at('link'));
          return {
            path: at('link'),
            listed: real(at('a')),
            file: join(at('a'), 'README.md'),
          };
        },
      },
      {
        name: "a lock that isn't a 10db batch's",
        make: () => {
          raw(
            main(),
            'worktree',
            'add',
            '-q',
            '--lock',
            '--reason',
            '10db nothing',
            '-b',
            'l',
            at('l'),
          );
          return Promise.resolve({ path: at('l'), listed: real(at('l')) });
        },
      },
      {
        name: 'a lock that names neither a batch nor a chat',
        make: () => {
          raw(
            main(),
            'worktree',
            'add',
            '-q',
            '--lock',
            '--reason',
            '10db cht_',
            '-b',
            'm',
            at('m'),
          );
          return Promise.resolve({ path: at('m') });
        },
      },
      {
        name: 'a 10db worktree when no worktree root is configured',
        make: async () => {
          await add('b');
          return { path: at('b'), remover: createGit({ pins }), listed: real(at('b')) };
        },
      },
      {
        // Last, in a repository of its own: the root must be empty to become a worktree.
        name: 'the root itself, a locked worktree named by its real path',
        make: () => {
          fresh('the rows before the root');
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
          return Promise.resolve({ path: real(root.path), listed: real(root.path) });
        },
      },
    ];
    for (const { name, make } of rows) {
      const { path, remover, listed: still, file } = await make();
      expect
        .soft(await caught((remover ?? git).removeWorktree(main(), path)), name)
        .toBeInstanceOf(WorktreeNotOursError);
      if (still) expect.soft(await listed(), `still listed: ${name}`).toContain(still);
      if (file) expect.soft(existsSync(file), `file kept: ${name}`).toBe(true);
    }
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

  it("lists a batch's or a chat's worktree's uncommitted changes", async () => {
    await add('a');
    await addChat('c');
    writeFileSync(join(at('a'), 'notes.txt'), 'mine\n');
    writeFileSync(join(at('c'), 'chat.txt'), 'mine\n');
    await expect(git.worktreeChanges(main(), at('a'))).resolves.toEqual(['notes.txt']);
    await expect(git.worktreeChanges(main(), at('c'))).resolves.toEqual(['chat.txt']);
  });

  it("refuses a git dir that isn't one of the repository's own worktrees, or a worktree 10db didn't lock", async () => {
    // One repository, a worktree of its own for each row; the row that rewrites a worktree's
    // commondir comes last.
    const rows: readonly { name: string; make: () => Promise<string> }[] = [
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
          await add('a5');
          mkdirSync(at('copy'));
          writeFileSync(join(at('copy'), '.git'), readFileSync(join(at('a5'), '.git')));
          return at('copy');
        },
      },
      {
        name: "a git dir outside the repository's worktrees",
        make: async () => {
          await add('a1');
          const copy = join(elsewhere.path, 'gitdir');
          execFileSync('cp', ['-R', gitDirOf(at('a1')), copy]);
          writeFileSync(join(at('a1'), '.git'), `gitdir: ${copy}\n`);
          return at('a1');
        },
      },
      {
        name: "a git dir nested deeper than the repository's worktrees",
        make: async () => {
          await add('a2');
          const nested = join(gitDirOf(at('a2')), 'nested');
          execFileSync('cp', ['-R', gitDirOf(at('a2')), join(elsewhere.path, 'copy')]);
          execFileSync('mv', [join(elsewhere.path, 'copy'), nested]);
          writeFileSync(join(at('a2'), '.git'), `gitdir: ${nested}\n`);
          return at('a2');
        },
      },
      {
        name: 'a git dir whose commondir names another repository',
        make: async () => {
          await add('a3');
          const other = createTempRepo();
          cleanups.push(() => {
            other.cleanup();
          });
          writeFileSync(join(gitDirOf(at('a3')), 'commondir'), `${join(other.path, '.git')}\n`);
          return at('a3');
        },
      },
    ];
    for (const { name, make } of rows) {
      const path = await make();
      expect
        .soft(await caught(git.worktreeChanges(main(), path)), name)
        .toBeInstanceOf(WorktreeNotOursError);
    }
  });
});

describe('worktreeIgnoredFiles', () => {
  /** Ignores these patterns in every worktree of the repository, with nothing to commit. */
  const ignore = (...patterns: string[]) => {
    writeFileSync(join(main(), '.git', 'info', 'exclude'), `${patterns.join('\n')}\n`);
  };

  it("lists a batch's or a chat's ignored files, but none in an ignored directory and no untracked one", async () => {
    ignore('.env', '.env.*', '*.log', 'dist/', 'node_modules/');
    const rows: readonly { name: string; files: string[]; listed: string[]; chat?: true }[] = [
      { name: 'an ignored file at the top', files: ['.env'], listed: ['.env'] },
      {
        name: 'ignored files in directories git does not track',
        files: ['apps/web/.env.local', 'src/run.log'],
        listed: ['apps/web/.env.local', 'src/run.log'],
      },
      { name: 'an ignored directory', files: ['dist/out.js', 'node_modules/x/i.js'], listed: [] },
      { name: 'an untracked file that is not ignored', files: ['notes.txt'], listed: [] },
      { name: "a chat's worktree's ignored file", files: ['.env'], listed: ['.env'], chat: true },
    ];
    for (const [i, { name, files, listed: expected, chat }] of rows.entries()) {
      const tree = `w${String(i)}`;
      await (chat ? addChat(tree) : add(tree));
      for (const file of files) {
        mkdirSync(dirname(join(at(tree), file)), { recursive: true });
        writeFileSync(join(at(tree), file), 'local\n');
      }
      expect.soft(await git.worktreeIgnoredFiles(main(), at(tree)), name).toEqual(expected);
    }
  });

  it("refuses a worktree 10db didn't lock", async () => {
    raw(main(), 'worktree', 'add', '-q', '-b', 'foreign', at('foreign'));
    await expect(git.worktreeIgnoredFiles(main(), at('foreign'))).rejects.toBeInstanceOf(
      WorktreeNotOursError,
    );
  });
});

describe('deleteBranchIfAt', () => {
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

  it('deletes a branch at that sha and keeps one that moved, and reads the remote-tracking tip', async () => {
    const first = raw(main(), 'rev-parse', 'HEAD');
    pushedBranch('10db/t', first);
    await expect(git.trackingTip(main(), '10db/t')).resolves.toBe(first);
    await expect(git.trackingTip(main(), '10db/none')).resolves.toBeNull();

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

  it('deletes the remote-tracking ref and the config with the branch, but no neighbour, and nothing when that ref moved', async () => {
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

    // The remote-tracking ref moved: nothing changes, and a call that names no tip leaves it.
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
});

describe('branchInUse', () => {
  it('names the checkout or worktree that has the branch out, a rebasing one too, and null for a free branch', async () => {
    raw(main(), 'branch', '10db/free');
    await expect(git.branchInUse(main(), '10db/free')).resolves.toBeNull();
    await expect(git.branchInUse(main(), 'main')).resolves.toBe(realpathSync(main()));

    raw(main(), 'branch', '10db/out');
    const out = join(elsewhere.path, 'out');
    raw(main(), 'worktree', 'add', '-q', out, '10db/out');
    await expect(git.branchInUse(main(), '10db/out')).resolves.toBe(realpathSync(out));

    raw(main(), 'branch', '10db/rebasing');
    const rebasing = join(elsewhere.path, 'rebasing');
    raw(main(), 'worktree', 'add', '-q', rebasing, '10db/rebasing');
    raw(rebasing, 'commit', '-q', '--allow-empty', '-m', 'on the branch');
    // A rebase that stops after its first pick leaves the worktree detached, mid-rebase.
    expect(() => raw(rebasing, 'rebase', '-q', '--exec', 'false', 'HEAD~1')).toThrow();
    expect(raw(rebasing, 'branch', '--show-current')).toBe('');
    await expect(git.branchInUse(main(), '10db/rebasing')).resolves.toBe(realpathSync(rebasing));
  });
});

describe('localBranches', () => {
  it('lists the local branches under a prefix with their tips, sorted, and answers one tip or null', async () => {
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
