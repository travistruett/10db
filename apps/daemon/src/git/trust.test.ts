import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { InvalidError } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTempRepo,
  createTempRepoWithOrigin,
  isolatedGitEnv,
  NETWORK_ENV,
  TEST_REPO_CONFIG,
  tempDir,
  type TempDir,
} from '../../test/fixtures';
import { writeHook } from '../../test/git-hooks';
import { gitWrapper, realGit } from '../../test/git-wrapper';
import { memoryPinStore } from './checkout-pin';
import {
  createGit,
  GitNetworkError,
  GitTrustError,
  GitVersionError,
  resolveGit,
  trustCard,
  type Git,
} from './index';
import { GitError, runGit } from './run';

let repo: TempDir;
let scratch: TempDir;
beforeEach(() => {
  repo = createTempRepo();
  scratch = tempDir('git-trust');
});
afterEach(() => {
  vi.unstubAllEnvs();
  repo.cleanup();
  scratch.cleanup();
});

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], {
    env: isolatedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
const rawGit = (...args: string[]) => gitIn(repo.path, ...args);
const write = (rel: string, text: string) => {
  mkdirSync(join(repo.path, rel, '..'), { recursive: true });
  writeFileSync(join(repo.path, rel), text);
};

/** A program that records each run in `<scratch>/<name>.ran` and passes stdin through, as a filter must. */
function marker(name: string): { path: string; ran(): boolean } {
  const path = join(scratch.path, `${name}.sh`);
  const ran = join(scratch.path, `${name}.ran`);
  writeFileSync(path, `#!/bin/sh\necho ran >> '${ran}'\ncat\n`);
  chmodSync(path, 0o755);
  return { path, ran: () => existsSync(ran) };
}

async function refusal(act: Promise<unknown>): Promise<GitTrustError> {
  const error: unknown = await act.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof GitTrustError))
    throw new Error(`expected a GitTrustError, got ${String(error)}`);
  return error;
}

/** Runs `act`, accepting a refusal: these tests are about what never runs, not whether git agrees. */
async function tolerate(act: Promise<unknown>): Promise<void> {
  await act.catch((error: unknown) => {
    if (!(error instanceof GitTrustError || error instanceof InvalidError)) throw error;
  });
}

/**
 * A branch `side` one commit past `other`, made with plumbing and every hook, monitor, filter and
 * signature off, so making it runs nothing an act is tested for.
 */
function sideBranch(): void {
  const quiet = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
  const run = (args: string[], input?: string, extra: Record<string, string> = {}) =>
    execFileSync('git', ['-C', repo.path, ...quiet, ...args], {
      env: { ...isolatedGitEnv(), ...extra },
      input: input ?? '',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  const blob = run(['hash-object', '-w', '--no-filters', '--stdin'], 'side\n');
  const index = { GIT_INDEX_FILE: join(scratch.path, 'side-index') };
  run(['read-tree', 'other'], undefined, index);
  run(['update-index', '--add', '--cacheinfo', `100644,${blob},side.txt`], undefined, index);
  const tree = run(['write-tree'], undefined, index);
  const commit = run(['commit-tree', '--no-gpg-sign', tree, '-p', 'other'], 'side\n');
  run(['update-ref', 'refs/heads/side', commit]);
}

const commitA = (git: Git, opId = 'op-trust-a1', branch = 'main') => {
  write('a.txt', `a ${opId}`);
  return git.commit({ repo: repo.path, paths: ['a.txt'], message: 'a', opId, branch });
};

/** A repository inside the checkout whose own git dir names `program` as a filter for every file. */
function embeddedRepo(at: string, program: string, gitDir?: string): void {
  const dir = join(repo.path, at);
  mkdirSync(dir, { recursive: true });
  const env = isolatedGitEnv();
  execFileSync(
    'git',
    ['init', '-q', '-b', 'main', ...(gitDir ? [`--separate-git-dir=${gitDir}`] : []), dir],
    { env },
  );
  for (const [key, value] of [
    ...Object.entries(TEST_REPO_CONFIG),
    ['user.name', 'lane'] as const,
    ['user.email', 'lane@10db.invalid'] as const,
  ])
    gitIn(dir, 'config', key, value);
  writeFileSync(join(dir, 'f.txt'), 'hi\n');
  writeFileSync(join(dir, '.gitattributes'), '* filter=x\n');
  gitIn(dir, 'add', 'f.txt', '.gitattributes');
  gitIn(dir, 'commit', '-q', '-m', 'inner');
  gitIn(dir, 'config', 'filter.x.clean', program);
  gitIn(dir, 'config', 'filter.x.smudge', program);
  // A change git would have to hash through the filter to compare.
  writeFileSync(join(dir, 'f.txt'), 'changed\n');
}

describe('no program from the checkout runs in a daemon git call', () => {
  const ACTS: readonly { name: string; act: (git: Git) => Promise<unknown> }[] = [
    { name: 'changedPaths', act: (git) => git.changedPaths(repo.path) },
    { name: 'changedFilesSince', act: (git) => git.changedFilesSince(repo.path, 'HEAD') },
    {
      name: 'filesChangedBetween',
      act: (git) => git.filesChangedBetween(repo.path, 'HEAD', 'HEAD'),
    },
    { name: 'commit', act: (git) => commitA(git) },
    { name: 'a retried commit', act: (git) => commitA(git).then(() => commitA(git)) },
    {
      name: 'mergedCommit',
      act: (git) => {
        sideBranch();
        return git.mergedCommit({
          repo: repo.path,
          ours: 'main',
          theirs: 'side',
          ref: 'refs/10db/starts/x',
          message: 'start',
        });
      },
    },
    {
      // After the commits, so main has its own: a merge commit, read-tree -m -u and update-ref.
      name: 'mergeIntoBranch',
      act: (git) => {
        sideBranch();
        return git.mergeIntoBranch({
          repo: repo.path,
          branch: 'main',
          from: 'side',
          message: 'merge',
        });
      },
    },
    {
      name: 'switchNewBranch',
      act: (git) => git.switchNewBranch(repo.path, '10db/x-0a1b2c3d', 'other'),
    },
    {
      name: 'switchBack',
      act: (git) =>
        git.switchBack(repo.path, '10db/x-0a1b2c3d', {
          branch: 'main',
          sha: rawGit('rev-parse', 'main'),
        }),
    },
  ];
  const HOOKS = [
    'pre-commit',
    'prepare-commit-msg',
    'commit-msg',
    'post-commit',
    'post-index-change',
    'post-checkout',
    'reference-transaction',
    'pre-merge-commit',
    'post-merge',
  ];
  it.each([
    {
      name: 'a filter driver the checkout configures and selects for every file',
      arrange: (program: string) => {
        write('.gitattributes', '* filter=x diff=x\n');
        rawGit('add', '.gitattributes');
        rawGit('commit', '-q', '-m', 'attributes');
        rawGit('branch', 'other');
        for (const key of ['clean', 'smudge', 'process'])
          rawGit('config', `filter.x.${key}`, program);
        write('README.md', 'edited\n');
      },
    },
    {
      name: 'a diff driver and an external diff the checkout configures',
      arrange: (program: string) => {
        write('.gitattributes', '* diff=x\n');
        rawGit('add', '.gitattributes');
        rawGit('commit', '-q', '-m', 'attributes');
        rawGit('branch', 'other');
        rawGit('config', 'diff.x.textconv', program);
        rawGit('config', 'diff.x.command', program);
        rawGit('config', 'diff.external', program);
      },
    },
    {
      name: 'an fsmonitor program',
      arrange: (program: string) => {
        rawGit('branch', 'other');
        rawGit('config', 'core.fsmonitor', program);
        write('README.md', 'edited\n');
      },
    },
    {
      name: 'hooks in .git/hooks',
      arrange: (program: string) => {
        rawGit('branch', 'other');
        writeHook(join(repo.path, '.git', 'hooks'), HOOKS, program);
      },
    },
    {
      name: "hooks in a core.hooksPath directory in the checkout (lefthook's, husky's)",
      arrange: (program: string) => {
        rawGit('branch', 'other');
        writeHook(join(repo.path, '.husky'), HOOKS, program);
        rawGit('config', 'core.hooksPath', '.husky');
      },
    },
    {
      name: 'signature checks and signing the checkout configures',
      arrange: (program: string) => {
        // A commit that carries a signature, which `log --show-signature` would hand to gpg.program.
        const tree = rawGit('rev-parse', 'HEAD^{tree}');
        const parent = rawGit('rev-parse', 'HEAD');
        const signed = [
          `tree ${tree}`,
          `parent ${parent}`,
          'author a <a@b> 1700000000 +0000',
          'committer a <a@b> 1700000000 +0000',
          'gpgsig -----BEGIN PGP SIGNATURE-----',
          ' ',
          ' iQEzBAABCAAdFiEE',
          ' -----END PGP SIGNATURE-----',
          '',
          'signed',
          '',
        ].join('\n');
        const oid = execFileSync(
          'git',
          ['-C', repo.path, 'hash-object', '-t', 'commit', '-w', '--stdin'],
          {
            env: isolatedGitEnv(),
            input: signed,
          },
        )
          .toString()
          .trim();
        rawGit('update-ref', 'refs/heads/main', oid);
        rawGit('branch', 'other');
        rawGit('config', 'log.showSignature', 'true');
        rawGit('config', 'commit.gpgsign', 'true');
        rawGit('config', 'gpg.program', program);
        rawGit('config', 'gpg.ssh.program', program);
      },
    },
    {
      name: 'a nested repository with its git dir in the checkout and a staged gitlink',
      arrange: (program: string) => {
        rawGit('branch', 'other');
        embeddedRepo('sub', program, join(repo.path, 'evilgit'));
        rawGit(
          'update-index',
          '--add',
          '--cacheinfo',
          `160000,${gitIn(join(repo.path, 'sub'), 'rev-parse', 'HEAD')},sub`,
        );
      },
    },
    {
      name: 'the same, with a .gitmodules that asks to see every submodule change',
      arrange: (program: string) => {
        rawGit('branch', 'other');
        embeddedRepo('sub', program, join(repo.path, 'evilgit'));
        rawGit(
          'update-index',
          '--add',
          '--cacheinfo',
          `160000,${gitIn(join(repo.path, 'sub'), 'rev-parse', 'HEAD')},sub`,
        );
        write('.gitmodules', '[submodule "sub"]\n\tpath = sub\n\turl = ./x\n\tignore = none\n');
      },
    },
    {
      name: 'an embedded repository the index does not know',
      arrange: (program: string) => {
        rawGit('branch', 'other');
        embeddedRepo('vendor/lib', program);
      },
    },
  ])('$name', async ({ arrange }) => {
    const program = marker('program');
    arrange(program.path);
    // switchNewBranch and switchBack come last: they are the only acts that move HEAD.
    for (const { act } of ACTS) await tolerate(act(createGit()));
    expect(program.ran()).toBe(false);
  });

  it("runs nothing when a lane rewrites a submodule's config after the daemon's first git call", async () => {
    const program = marker('program');
    // A submodule as git lays one out: its git dir under .git/modules, a gitfile in its worktree.
    const modules = join(repo.path, '.git', 'modules', 'x');
    embeddedRepo('x', program.path);
    gitIn(join(repo.path, 'x'), 'config', '--unset', 'filter.x.clean');
    gitIn(join(repo.path, 'x'), 'config', '--unset', 'filter.x.smudge');
    mkdirSync(join(repo.path, '.git', 'modules'), { recursive: true });
    renameSync(join(repo.path, 'x', '.git'), modules);
    writeFileSync(join(repo.path, 'x', '.git'), 'gitdir: ../.git/modules/x\n');
    gitIn(modules, 'config', 'core.worktree', '../../../x');
    rawGit(
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${gitIn(join(repo.path, 'x'), 'rev-parse', 'HEAD')},x`,
    );
    write('.gitmodules', '[submodule "x"]\n\tpath = x\n\turl = ./x\n\tignore = none\n');
    rawGit('add', '.gitmodules');
    rawGit('commit', '-q', '-m', 'submodule');
    const flag = join(scratch.path, 'rewritten');
    const wrapper = gitWrapper(
      `if [ ! -e '${flag}' ]; then touch '${flag}'; printf '[filter "x"]\\n\\tclean = ${program.path}\\n\\tsmudge = ${program.path}\\n[core]\\n\\tfsmonitor = ${program.path}\\n' >> '${join(modules, 'config')}'; fi\nexec "$GIT" "$@"`,
    );
    try {
      vi.stubEnv('PATH', wrapper.path);
      const git = createGit();
      await git.changedPaths(repo.path);
      await commitA(git);
      expect(existsSync(flag)).toBe(true);
      expect(program.ran()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      wrapper.cleanup();
    }
  });

  it.each([
    { name: 'GIT_CONFIG_PARAMETERS', value: "'core.hookspath'='.husky'" },
    {
      name: 'GIT_CONFIG_COUNT',
      value: '1',
      also: { GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '.husky' },
    },
  ])(
    'runs no hook that $name in the daemon environment points at',
    async ({ name, value, also }) => {
      const program = marker('program');
      writeHook(
        join(repo.path, '.husky'),
        ['pre-commit', 'post-commit', 'reference-transaction'],
        program.path,
      );
      vi.stubEnv(name, value);
      for (const [k, v] of Object.entries(also ?? {})) vi.stubEnv(k, v);
      await commitA(createGit());
      expect(program.ran()).toBe(false);
    },
  );
});

describe("a batch's new branch is checked out without git's checkout", () => {
  /** A start point whose attributes select filter `x` for every file, which local config names. */
  function filteredStartPoint(program: string): void {
    rawGit('switch', '-q', '-c', 'start');
    write('.gitattributes', '* filter=x\n');
    write('src/app.txt', 'as stored\n');
    write('bin/run.sh', '#!/bin/sh\n');
    chmodSync(join(repo.path, 'bin', 'run.sh'), 0o755);
    symlinkSync('../src/app.txt', join(repo.path, 'link.txt'));
    rawGit('rm', '-q', 'README.md');
    rawGit('add', '-A');
    rawGit('commit', '-q', '-m', 'start');
    rawGit('switch', '-q', 'main');
    for (const key of ['clean', 'smudge', 'process']) rawGit('config', `filter.x.${key}`, program);
  }

  it('refuses while an attributes file sits in the git dir, running nothing', async () => {
    const program = marker('program');
    filteredStartPoint(program.path);
    write('.git/info/attributes', '* filter=x\n');
    const error = await refusal(createGit().switchNewBranch(repo.path, '10db/x-0a1b2c3d', 'start'));
    expect(error.detail).toEqual({
      kind: 'attributes',
      file: join(realpathSync(repo.path), '.git', 'info', 'attributes'),
    });
    expect(program.ran()).toBe(false);
    expect(() => rawGit('rev-parse', '--verify', '-q', 'refs/heads/10db/x-0a1b2c3d')).toThrow();
  });

  it('writes each file as stored, runs no filter the start point selects, and moves HEAD to the branch', async () => {
    const program = marker('program');
    filteredStartPoint(program.path);
    const start = rawGit('rev-parse', 'start');
    await createGit().switchNewBranch(repo.path, '10db/x-0a1b2c3d', 'start');
    expect(program.ran()).toBe(false);
    expect(rawGit('symbolic-ref', 'HEAD')).toBe('refs/heads/10db/x-0a1b2c3d');
    expect(rawGit('rev-parse', 'HEAD')).toBe(start);
    expect(readFileSync(join(repo.path, 'src', 'app.txt'), 'utf8')).toBe('as stored\n');
    expect(lstatSync(join(repo.path, 'bin', 'run.sh')).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(repo.path, 'link.txt'))).toBe('../src/app.txt');
    expect(existsSync(join(repo.path, 'README.md'))).toBe(false);
    expect(await createGit().changedPaths(repo.path)).toEqual([]);
  });

  it('writes nothing through a link that stands where the start point has a directory', async () => {
    const outside = tempDir('outside');
    try {
      filteredStartPoint(marker('program').path);
      write('.git/info/exclude', 'src\n');
      symlinkSync(outside.path, join(repo.path, 'src'));
      // Git either refuses or, the link being ignored and so expendable, replaces it with a real
      // directory. Either way nothing lands outside the checkout.
      await createGit()
        .switchNewBranch(repo.path, '10db/x-0a1b2c3d', 'start')
        .catch(() => undefined);
      expect(existsSync(join(outside.path, 'app.txt'))).toBe(false);
      expect(lstatSync(join(repo.path, 'src')).isSymbolicLink()).toBe(
        rawGit('symbolic-ref', 'HEAD') === 'refs/heads/main',
      );
    } finally {
      outside.cleanup();
    }
  });

  /** A tree object written as raw bytes, so its entry names skip every check git makes on input. */
  function rawTree(entries: readonly { mode: string; name: string; oid: string }[]): string {
    const bytes = Buffer.concat(
      entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex')]),
    );
    return execFileSync(
      'git',
      ['-C', repo.path, 'hash-object', '-t', 'tree', '-w', '--literally', '--stdin'],
      {
        env: isolatedGitEnv(),
        input: bytes,
      },
    )
      .toString()
      .trim();
  }
  const blob = (text: string) =>
    execFileSync('git', ['-C', repo.path, 'hash-object', '-w', '--stdin'], {
      env: isolatedGitEnv(),
      input: text,
    })
      .toString()
      .trim();

  it.each([
    { name: 'a parent directory', entry: '..' },
    { name: '.git in capitals', entry: '.GIT' },
    { name: '.git with a character HFS+ ignores', entry: '.git\u200c' },
    { name: "NTFS's short name for .git", entry: 'git~1' },
  ])(
    'writes nothing outside the checkout or into .git for a tree entry naming $name',
    async ({ entry }) => {
      const escape = `escape-${String(Math.random()).slice(2)}`;
      const inner = rawTree([
        { mode: '100644', name: 'config', oid: blob('[core]\n\thooksPath = evil\n') },
        { mode: '100644', name: escape, oid: blob('escaped\n') },
      ]);
      const root = rawTree([{ mode: '40000', name: entry, oid: inner }]);
      const commit = rawGit('commit-tree', root, '-m', 'crafted');
      const config = readFileSync(join(repo.path, '.git', 'config'), 'utf8');
      await createGit()
        .switchNewBranch(repo.path, '10db/x-0a1b2c3d', commit)
        .catch(() => undefined);
      expect(readFileSync(join(repo.path, '.git', 'config'), 'utf8')).toBe(config);
      expect(existsSync(join(repo.path, '..', escape))).toBe(false);
      expect(existsSync(join(repo.path, '.git', escape))).toBe(false);
      expect(() => rawGit('rev-parse', '--verify', '-q', 'refs/heads/10db/x-0a1b2c3d')).toThrow();
    },
  );

  it('writes nothing for a tree entry that names an absolute path', async () => {
    const target = join(scratch.path, `absolute-${String(Math.random()).slice(2)}`);
    const root = rawTree([{ mode: '100644', name: target, oid: blob('escaped\n') }]);
    const commit = rawGit('commit-tree', root, '-m', 'crafted');
    await createGit()
      .switchNewBranch(repo.path, '10db/x-0a1b2c3d', commit)
      .catch(() => undefined);
    expect(existsSync(target)).toBe(false);
  });

  it('writes nothing outside when a lane swaps a parent directory for a link mid-cut', async () => {
    const outside = tempDir('outside');
    try {
      write('lib/a.txt', 'one\n');
      rawGit('add', 'lib/a.txt');
      rawGit('commit', '-q', '-m', 'lib');
      rawGit('switch', '-q', '-c', 'start');
      write('lib/a.txt', 'two\n');
      write('lib/b.txt', 'new\n');
      rawGit('add', 'lib');
      rawGit('commit', '-q', '-m', 'change lib');
      rawGit('switch', '-q', 'main');
      const lib = join(repo.path, 'lib');
      const wrapper = gitWrapper(
        `case " $* " in *" read-tree "*" -u "*) rm -rf '${lib}'; ln -s '${outside.path}' '${lib}';; esac\nexec "$GIT" "$@"`,
      );
      try {
        vi.stubEnv('PATH', wrapper.path);
        await createGit()
          .switchNewBranch(repo.path, '10db/x-0a1b2c3d', 'start')
          .catch(() => undefined);
      } finally {
        vi.unstubAllEnvs();
        wrapper.cleanup();
      }
      expect(existsSync(join(outside.path, 'a.txt'))).toBe(false);
      expect(existsSync(join(outside.path, 'b.txt'))).toBe(false);
    } finally {
      outside.cleanup();
    }
  });

  it('refuses a dirty checkout and an existing branch, writing nothing', async () => {
    rawGit('branch', 'taken');
    await expect(createGit().switchNewBranch(repo.path, 'taken', 'main')).rejects.toThrow(
      /already exists/,
    );
    write('README.md', 'edited\n');
    await expect(createGit().switchNewBranch(repo.path, 'fresh', 'main')).rejects.toThrow(
      /uncommitted changes/,
    );
    expect(() => rawGit('rev-parse', '--verify', '-q', 'refs/heads/fresh')).toThrow();
  });
});

describe('the daemon never commits a submodule or an embedded repository', () => {
  it.each([
    {
      name: 'a staged gitlink',
      arrange: (program: string) => {
        embeddedRepo('sub', program, join(repo.path, 'evilgit'));
        rawGit(
          'update-index',
          '--add',
          '--cacheinfo',
          `160000,${gitIn(join(repo.path, 'sub'), 'rev-parse', 'HEAD')},sub`,
        );
        rawGit('commit', '-q', '-m', 'gitlink');
      },
      paths: ['sub'],
    },
    {
      name: 'an embedded repository named itself',
      arrange: (program: string) => {
        embeddedRepo('sub', program);
      },
      paths: ['sub'],
    },
    {
      name: 'a file inside an embedded repository',
      arrange: (program: string) => {
        embeddedRepo('sub', program);
      },
      paths: ['sub/f.txt'],
    },
    {
      name: 'a directory that holds an embedded repository',
      arrange: (program: string) => {
        embeddedRepo('vendor/lib', program);
        write('vendor/README.md', 'vendored\n');
      },
      paths: ['vendor'],
    },
    {
      name: 'a path inside .git',
      arrange: () => undefined,
      paths: ['.git/config'],
    },
  ])('refuses $name, committing nothing and running nothing', async ({ arrange, paths }) => {
    const program = marker('program');
    arrange(program.path);
    const tip = rawGit('rev-parse', 'refs/heads/main');
    const error = await refusal(
      createGit().commit({
        repo: repo.path,
        paths,
        message: 'x',
        opId: 'op-embedded',
        branch: 'main',
      }),
    );
    expect(error.detail.kind).toBe('embedded');
    expect(rawGit('rev-parse', 'refs/heads/main')).toBe(tip);
    expect(program.ran()).toBe(false);
  });
});

describe('a commit beside a submodule', () => {
  it('says there is nothing to commit, not that a submodule is in the way', async () => {
    rawGit('update-index', '--add', '--cacheinfo', `160000,${rawGit('rev-parse', 'HEAD')},lib`);
    rawGit('commit', '-q', '-m', 'submodule');
    const onRefused = vi.fn();
    await expect(
      createGit({ onRefused }).commit({
        repo: repo.path,
        paths: ['README.md'],
        message: 'nothing',
        opId: 'op-noop',
        branch: 'main',
      }),
    ).rejects.toThrow(/Nothing to commit/);
    expect(onRefused).not.toHaveBeenCalled();
  });
});

describe('a commit never takes a file through a link', () => {
  it('refuses a path under a linked directory outside the checkout, and commits a link as a link', async () => {
    const outside = tempDir('outside');
    try {
      writeFileSync(join(outside.path, 'secret.txt'), 'private key\n');
      symlinkSync(outside.path, join(repo.path, 'out'));
      const tip = rawGit('rev-parse', 'refs/heads/main');
      await expect(
        createGit().commit({
          repo: repo.path,
          paths: ['out/secret.txt'],
          message: 's',
          opId: 'op-link-1',
          branch: 'main',
        }),
      ).rejects.toThrow();
      // The link itself points outside, so it is refused too.
      await expect(
        createGit().commit({
          repo: repo.path,
          paths: ['out'],
          message: 'link',
          opId: 'op-link-2',
          branch: 'main',
        }),
      ).rejects.toThrow(InvalidError);
      expect(rawGit('rev-parse', 'refs/heads/main')).toBe(tip);
      const secret = execFileSync('git', ['-C', repo.path, 'hash-object', '--stdin'], {
        env: isolatedGitEnv(),
        input: 'private key\n',
      })
        .toString()
        .trim();
      expect(() => rawGit('cat-file', '-e', secret)).toThrow();
    } finally {
      outside.cleanup();
    }
  });
});

describe('a commit never takes a file through a link swapped in after the path check', () => {
  it('stores nothing from outside when a directory becomes a link just before git adds it', async () => {
    const outside = tempDir('outside');
    try {
      writeFileSync(join(outside.path, 'note.txt'), 'private key\n');
      write('docs/note.txt', 'ours\n');
      const docs = join(repo.path, 'docs');
      const wrapper = gitWrapper(
        `case " $* " in *" add "*) rm -rf '${docs}'; ln -s '${outside.path}' '${docs}';; esac\nexec "$GIT" "$@"`,
      );
      const tip = rawGit('rev-parse', 'refs/heads/main');
      try {
        vi.stubEnv('PATH', wrapper.path);
        await createGit()
          .commit({
            repo: repo.path,
            paths: ['docs/note.txt'],
            message: 'n',
            opId: 'op-swap-add',
            branch: 'main',
          })
          .catch(() => undefined);
      } finally {
        vi.unstubAllEnvs();
        wrapper.cleanup();
      }
      const secret = execFileSync('git', ['-C', repo.path, 'hash-object', '--stdin'], {
        env: isolatedGitEnv(),
        input: 'private key\n',
      })
        .toString()
        .trim();
      expect(() => rawGit('cat-file', '-e', secret)).toThrow();
      expect(rawGit('rev-parse', 'refs/heads/main')).toBe(tip);
    } finally {
      outside.cleanup();
    }
  });
});

describe('a commit lands only on its branch', () => {
  beforeEach(() => {
    rawGit('switch', '-q', '-c', 'lane');
  });

  it('commits on the branch without touching HEAD, and the checkout shows nothing left to commit', async () => {
    const before = rawGit('rev-parse', 'refs/heads/lane');
    const main = rawGit('rev-parse', 'refs/heads/main');
    const { sha } = await commitA(createGit(), 'op-lane-1', 'lane');
    expect(rawGit('rev-parse', 'refs/heads/lane')).toBe(sha);
    expect(rawGit('rev-parse', `${sha}^`)).toBe(before);
    expect(rawGit('rev-parse', 'refs/heads/main')).toBe(main);
    expect(rawGit('symbolic-ref', 'HEAD')).toBe('refs/heads/lane');
    expect(rawGit('status', '--porcelain')).toBe('');
    expect(rawGit('log', '-1', '--format=%B', sha)).toBe('a\n\n10db-Op: op-lane-1');
  });

  it.each([
    { name: 'another branch', move: () => rawGit('switch', '-q', 'main'), found: 'main' },
    { name: 'a detached HEAD', move: () => rawGit('switch', '-q', '--detach'), found: null },
  ])('refuses when HEAD is on $name, committing nothing', async ({ move, found }) => {
    move();
    const lane = rawGit('rev-parse', 'refs/heads/lane');
    const main = rawGit('rev-parse', 'refs/heads/main');
    const onRefused = vi.fn();
    const error = await refusal(commitA(createGit({ onRefused }), 'op-lane-2', 'lane'));
    expect(error.detail).toEqual({ kind: 'branch', expected: 'lane', found, committed: false });
    expect(rawGit('rev-parse', 'refs/heads/lane')).toBe(lane);
    expect(rawGit('rev-parse', 'refs/heads/main')).toBe(main);
    expect(onRefused).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('refuses a branch that is a symbolic ref to another, leaving that one alone', async () => {
    rawGit('symbolic-ref', 'refs/heads/lane', 'refs/heads/main');
    const main = rawGit('rev-parse', 'refs/heads/main');
    const error = await refusal(commitA(createGit(), 'op-lane-3', 'lane'));
    expect(error.detail).toEqual({ kind: 'ref', ref: 'refs/heads/lane', reason: 'symbolic' });
    expect(rawGit('rev-parse', 'refs/heads/main')).toBe(main);
  });

  it("commits on the branch when a lane points HEAD at main between the daemon's git calls, and says so", async () => {
    const main = rawGit('rev-parse', 'refs/heads/main');
    const head = join(repo.path, '.git', 'HEAD');
    const wrapper = gitWrapper(
      `case " $* " in *" commit-tree "*) "$GIT" "$@"; s=$?; printf 'ref: refs/heads/main\\n' > '${head}'; exit $s;; esac\nexec "$GIT" "$@"`,
    );
    try {
      vi.stubEnv('PATH', wrapper.path);
      const onRefused = vi.fn();
      const { sha } = await commitA(createGit({ onRefused }), 'op-lane-4', 'lane');
      vi.unstubAllEnvs();
      expect(rawGit('rev-parse', 'refs/heads/lane')).toBe(sha);
      expect(rawGit('rev-parse', 'refs/heads/main')).toBe(main);
      expect(onRefused).toHaveBeenCalledOnce();
      const error: unknown = onRefused.mock.calls[0]?.[0];
      if (!(error instanceof GitTrustError)) throw new Error('expected a refusal');
      expect(error.detail).toEqual({
        kind: 'branch',
        expected: 'lane',
        found: 'main',
        committed: true,
      });
    } finally {
      vi.unstubAllEnvs();
      wrapper.cleanup();
    }
  });

  it("refuses when the branch moves between the daemon's git calls, leaving it where it was moved", async () => {
    rawGit('commit', '-q', '--allow-empty', '-m', 'elsewhere');
    const moved = rawGit('rev-parse', 'HEAD');
    rawGit('reset', '-q', '--soft', 'HEAD~1');
    const wrapper = gitWrapper(
      `case " $* " in *" commit-tree "*) "$GIT" "$@"; s=$?; "$GIT" -C '${repo.path}' update-ref refs/heads/lane ${moved}; exit $s;; esac\nexec "$GIT" "$@"`,
    );
    try {
      vi.stubEnv('PATH', wrapper.path);
      const error = await refusal(commitA(createGit(), 'op-lane-5', 'lane'));
      vi.unstubAllEnvs();
      expect(error.detail).toEqual({ kind: 'ref', ref: 'refs/heads/lane', reason: 'raced' });
      expect(rawGit('rev-parse', 'refs/heads/lane')).toBe(moved);
    } finally {
      vi.unstubAllEnvs();
      wrapper.cleanup();
    }
  });

  it("never moves another branch when a lane turns the branch into a symbolic ref between the daemon's git calls", async () => {
    const main = rawGit('rev-parse', 'refs/heads/main');
    const wrapper = gitWrapper(
      `case " $* " in *" commit-tree "*) "$GIT" "$@"; s=$?; "$GIT" -C '${repo.path}' symbolic-ref refs/heads/lane refs/heads/main; exit $s;; esac\nexec "$GIT" "$@"`,
    );
    try {
      vi.stubEnv('PATH', wrapper.path);
      await tolerate(commitA(createGit(), 'op-lane-6', 'lane'));
      vi.unstubAllEnvs();
      expect(rawGit('rev-parse', 'refs/heads/main')).toBe(main);
    } finally {
      vi.unstubAllEnvs();
      wrapper.cleanup();
    }
  });

  it("signs only as the builder's own config says, with the builder's signing program", async () => {
    const builders = marker('builder-gpg');
    const lanes = marker('lane-gpg');
    const global = join(scratch.path, 'gitconfig');
    writeFileSync(global, `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${builders.path}\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', global);
    rawGit('config', 'gpg.program', lanes.path);
    rawGit('config', 'gpg.openpgp.program', lanes.path);
    // The stand-in signer prints no signature, so git refuses to commit: what matters is who ran.
    await commitA(createGit(), 'op-lane-7', 'lane').catch(() => undefined);
    expect(builders.ran()).toBe(true);
    expect(lanes.ran()).toBe(false);
  });

  it('refuses a file whose attributes ask for a filter, committing nothing', async () => {
    write('.gitattributes', '*.bin filter=lfs\n');
    write('big.bin', 'binary');
    const error = await refusal(
      createGit().commit({
        repo: repo.path,
        paths: ['big.bin'],
        message: 'b',
        opId: 'op-lfs',
        branch: 'lane',
      }),
    );
    expect(error.detail).toEqual({ kind: 'filter', paths: [{ path: 'big.bin', filter: 'lfs' }] });
  });
});

describe('the checkout is the one pinned for it', () => {
  /** Moves `.git` aside and makes a new repository in its place, as a lane could. */
  function replaceGitDir(): void {
    renameSync(
      join(repo.path, '.git'),
      join(scratch.path, `old-git-${String(Date.now())}-${String(Math.random())}`),
    );
    const env = isolatedGitEnv();
    execFileSync('git', ['-C', repo.path, 'init', '-q', '-b', 'main'], { env });
    for (const [key, value] of [
      ...Object.entries(TEST_REPO_CONFIG),
      ['user.name', 'lane'] as const,
      ['user.email', 'lane@10db.invalid'] as const,
    ])
      rawGit('config', key, value);
    rawGit('commit', '-q', '--allow-empty', '-m', 'swapped');
  }
  const ACTS = [
    { name: 'changedPaths', act: (git: Git, path: string) => git.changedPaths(path) },
    { name: 'head', act: (git: Git, path: string) => git.head(path) },
    { name: 'currentBranch', act: (git: Git, path: string) => git.currentBranch(path) },
    { name: 'commitsSince', act: (git: Git, path: string) => git.commitsSince(path, 'HEAD') },
    { name: 'gitDirs', act: (git: Git, path: string) => git.gitDirs(path) },
    { name: 'commit', act: (git: Git) => commitA(git, 'op-swap') },
    {
      name: 'mergeIntoBranch',
      act: (git: Git, path: string) =>
        git.mergeIntoBranch({ repo: path, branch: 'main', from: 'HEAD', message: 'merge' }),
    },
    {
      name: 'mergedCommit',
      act: (git: Git, path: string) =>
        git.mergedCommit({
          repo: path,
          ours: 'HEAD',
          theirs: 'HEAD',
          ref: 'refs/10db/starts/x',
          message: 'start',
        }),
    },
    {
      name: 'switchNewBranch',
      act: (git: Git, path: string) => git.switchNewBranch(path, '10db/x-0a1b2c3d', 'HEAD'),
    },
    {
      name: 'switchBack',
      act: (git: Git, path: string) =>
        git.switchBack(path, '10db/x-0a1b2c3d', { branch: 'main', sha: 'HEAD' }),
    },
  ];

  it.each(ACTS)('refuses $name once .git was replaced', async ({ act }) => {
    const onRefused = vi.fn();
    const git = createGit({ onRefused });
    await git.head(repo.path);
    replaceGitDir();
    const error = await refusal(act(git, repo.path));
    expect(error.detail.kind).toBe('moved');
    expect(onRefused).toHaveBeenCalledExactlyOnceWith(error);
  });

  it('keeps refusing in a new daemon that shares the persisted pins, until the builder re-trusts', async () => {
    const pins = memoryPinStore();
    await createGit({ pins }).head(repo.path);
    replaceGitDir();
    const restarted = createGit({ pins });
    const { detail } = await refusal(restarted.currentBranch(repo.path));
    if (detail.kind !== 'moved') throw new Error('expected a moved checkout');
    await restarted.retrust(repo.path, detail.candidate);
    expect(await restarted.currentBranch(repo.path)).toBe('main');
  });

  it('re-trusts only the state the refusal found: a second swap before the answer is refused anew', async () => {
    const onRefused = vi.fn();
    const git = createGit({ onRefused });
    await git.head(repo.path);
    replaceGitDir();
    const { detail } = await refusal(git.head(repo.path));
    if (detail.kind !== 'moved') throw new Error('expected a moved checkout');
    // Before the builder answers, the lane swaps .git once more.
    replaceGitDir();
    const again = await refusal(git.retrust(repo.path, detail.candidate));
    expect(again.detail.kind).toBe('moved');
    if (again.detail.kind !== 'moved') throw new Error('expected a moved checkout');
    expect(again.detail.candidate.id).not.toBe(detail.candidate.id);
    await expect(git.head(repo.path)).rejects.toBeInstanceOf(GitTrustError);
  });

  /** Where a lane could write a git dir: the checkout, a lane temp root, another project's checkout. */
  const WRITABLE_GIT_DIRS = [
    { name: 'inside the checkout', at: () => join(repo.path, 'vendor', 'git') },
    { name: "in a lane's temp root", at: () => join(scratch.path, 'lane-root', 'git') },
    {
      name: "inside another registered project's checkout",
      at: () => join(scratch.path, 'other-checkout', 'git'),
    },
  ];
  const gitWithRoots = (onRefused: (error: GitTrustError) => void) =>
    createGit({
      onRefused,
      laneRoots: [join(scratch.path, 'lane-root')],
      checkouts: () => [repo.path, join(scratch.path, 'other-checkout')],
    });

  it.each(WRITABLE_GIT_DIRS)(
    'refuses to pin a checkout whose git dir lies $name, which a lane could write',
    async ({ at }) => {
      const onRefused = vi.fn();
      mkdirSync(dirname(at()), { recursive: true });
      renameSync(join(repo.path, '.git'), at());
      writeFileSync(join(repo.path, '.git'), `gitdir: ${at()}\n`);
      const git = gitWithRoots(onRefused);
      const error = await refusal(git.head(repo.path));
      expect(error.detail).toEqual({ kind: 'writable', gitDir: realpathSync(at()) });
      expect(onRefused).toHaveBeenLastCalledWith(error);
      await expect(git.head(repo.path)).rejects.toBeInstanceOf(GitTrustError);
    },
  );

  it('pins a checkout at its own .git when other checkouts are registered', async () => {
    expect(await gitWithRoots(vi.fn()).currentBranch(repo.path)).toBe('main');
  });

  it("pins and re-trusts a linked worktree whose common dir is another registered checkout's .git", async () => {
    // That .git is denied to every lane of the checkout it belongs to, and no other lane writes there.
    const outside = tempDir('worktree-of-registered');
    try {
      const worktree = join(outside.path, 'wt');
      rawGit('worktree', 'add', '-q', '-b', 'wt', worktree);
      const pins = memoryPinStore();
      const git = createGit({ pins, checkouts: () => [repo.path, worktree] });
      expect(await git.currentBranch(worktree)).toBe('wt');
      // A pin that names other git dirs makes the worktree's own a candidate the re-trust checks.
      const real = realpathSync(worktree);
      const pin = pins.get(real);
      if (!pin) throw new Error('expected the worktree to be pinned');
      pins.set(real, {
        ...pin,
        gitDir: join(scratch.path, 'a'),
        commonDir: join(scratch.path, 'b'),
      });
      const { detail } = await refusal(git.currentBranch(worktree));
      if (detail.kind !== 'moved') throw new Error('expected a moved checkout');
      await git.retrust(worktree, detail.candidate);
      expect(await git.currentBranch(worktree)).toBe('wt');
    } finally {
      outside.cleanup();
    }
  });

  it.each([
    { name: 'trusts it while the nested project is registered', registered: true },
    { name: 'refuses it once the nested project is not', registered: false },
  ])(
    "for a worktree of a project nested in another's checkout, $name: only then is its .git denied to every lane",
    async ({ registered }) => {
      // Project B sits in this checkout, whose lanes can write everything there but a registered
      // checkout's own .git; the worktree's common dir is B/.git.
      const nested = join(repo.path, 'nested');
      execFileSync('git', ['init', '-q', '-b', 'main', nested], { env: isolatedGitEnv() });
      // Its own identity: test repositories read no global config, and CI's machine has none.
      for (const [key, value] of [
        ...Object.entries(TEST_REPO_CONFIG),
        ['user.name', 'nested'] as const,
        ['user.email', 'nested@10db.invalid'] as const,
      ])
        gitIn(nested, 'config', key, value);
      gitIn(nested, 'commit', '-q', '--allow-empty', '-m', 'b');
      const outside = tempDir('worktree-of-nested');
      try {
        const worktree = join(outside.path, 'wt');
        gitIn(nested, 'worktree', 'add', '-q', '-b', 'wt', worktree);
        const pins = memoryPinStore();
        const git = createGit({
          pins,
          checkouts: () => [repo.path, ...(registered ? [nested] : []), worktree],
        });
        if (!registered) {
          expect((await refusal(git.currentBranch(worktree))).detail.kind).toBe('writable');
          return;
        }
        expect(await git.currentBranch(worktree)).toBe('wt');
        const real = realpathSync(worktree);
        const pin = pins.get(real);
        if (!pin) throw new Error('expected the worktree to be pinned');
        pins.set(real, {
          ...pin,
          gitDir: join(scratch.path, 'a'),
          commonDir: join(scratch.path, 'b'),
        });
        const { detail } = await refusal(git.currentBranch(worktree));
        if (detail.kind !== 'moved') throw new Error('expected a moved checkout');
        await git.retrust(worktree, detail.candidate);
        expect(await git.currentBranch(worktree)).toBe('wt');
      } finally {
        outside.cleanup();
      }
    },
  );

  it('re-trusts a changed origin when the pinned git dir is where it was pinned, even if a lane can now write there', async () => {
    // Pinned before the project around its git dir was registered: a new origin must not leave it
    // on a card that offers nothing.
    const other = join(scratch.path, 'other-checkout');
    const at = join(other, 'git');
    mkdirSync(other);
    renameSync(join(repo.path, '.git'), at);
    writeFileSync(join(repo.path, '.git'), `gitdir: ${at}\n`);
    const pins = memoryPinStore();
    await createGit({ pins }).head(repo.path);
    const git = createGit({ pins, checkouts: () => [repo.path, other] });
    rawGit('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
    const { detail } = await refusal(git.pinnedPushUrl(repo.path));
    if (detail.kind !== 'origin') throw new Error('expected a changed origin');
    await git.retrust(repo.path, detail.candidate);
    expect(await git.pinnedPushUrl(repo.path)).toBe('https://github.com/acme/widgets.git');
  });

  it.each(WRITABLE_GIT_DIRS)(
    'refuses to re-trust a git dir $name, which a lane could write',
    async ({ at }) => {
      const onRefused = vi.fn();
      const git = gitWithRoots(onRefused);
      await git.head(repo.path);
      // The repository's own git dir moves where a lane can write, and `.git` becomes a gitfile to it.
      mkdirSync(dirname(at()), { recursive: true });
      renameSync(join(repo.path, '.git'), at());
      writeFileSync(join(repo.path, '.git'), `gitdir: ${at()}\n`);
      const { detail } = await refusal(git.head(repo.path));
      if (detail.kind !== 'moved') throw new Error('expected a moved checkout');
      const error = await refusal(git.retrust(repo.path, detail.candidate));
      expect(error.detail).toEqual({ kind: 'writable', gitDir: realpathSync(at()) });
      expect(onRefused).toHaveBeenLastCalledWith(error);
      await expect(git.head(repo.path)).rejects.toBeInstanceOf(GitTrustError);
    },
  );

  it('pins a checkout by its real path, whatever path names it', async () => {
    const link = join(scratch.path, 'link');
    symlinkSync(repo.path, link);
    const git = createGit();
    await git.head(link);
    replaceGitDir();
    expect((await refusal(git.head(realpathSync(repo.path)))).detail.kind).toBe('moved');
  });

  it.each(ACTS)(
    'refuses $name when the object store borrows from another repository',
    async ({ act }) => {
      const other = tempDir('alternate');
      try {
        writeFileSync(join(repo.path, '.git', 'objects', 'info', 'alternates'), `${other.path}\n`);
        const error = await refusal(act(createGit(), repo.path));
        expect(error.detail.kind).toBe('alternates');
      } finally {
        other.cleanup();
      }
    },
  );
});

describe('a linked worktree', () => {
  let outside: TempDir;
  let worktree: string;
  beforeEach(() => {
    outside = tempDir('linked');
    worktree = join(outside.path, 'wt');
    rawGit('worktree', 'add', '-q', '-b', 'wt', worktree);
  });
  afterEach(() => {
    outside.cleanup();
  });

  it('commits on its own branch, through its own git dir', async () => {
    writeFileSync(join(worktree, 'a.txt'), 'a\n');
    const { sha } = await createGit().commit({
      repo: worktree,
      paths: ['a.txt'],
      message: 'a',
      opId: 'op-wt-1',
      branch: 'wt',
    });
    expect(rawGit('rev-parse', 'refs/heads/wt')).toBe(sha);
    expect(rawGit('rev-parse', 'refs/heads/main')).not.toBe(sha);
  });

  it('runs nothing when a lane swaps the gitfile between the pin check and the next git call', async () => {
    const program = marker('program');
    // An evil git dir: attributes that select a filter its config names, and hooks.
    const evil = join(outside.path, 'evil');
    execFileSync('git', ['init', '-q', '-b', 'main', evil], { env: isolatedGitEnv() });
    const evilGit = join(evil, '.git');
    gitIn(evil, 'config', 'filter.x.clean', program.path);
    gitIn(evil, 'config', 'core.fsmonitor', program.path);
    writeHook(join(evilGit, 'hooks'), ['post-index-change', 'reference-transaction'], program.path);
    writeFileSync(join(worktree, 'a.txt'), 'a\n');
    const git = createGit();
    await git.head(worktree);
    const gitfile = join(worktree, '.git');
    const flag = join(scratch.path, 'swapped');
    // After the pin check's rev-parse, before the status that follows it.
    const wrapper = gitWrapper(
      `case " $* " in *" status "*) if [ ! -e '${flag}' ]; then touch '${flag}'; mkdir -p '${evilGit}/info'; printf '* filter=x\\n' > '${evilGit}/info/attributes'; printf 'gitdir: ${evilGit}\\n' > '${gitfile}'; fi;; esac\nexec "$GIT" "$@"`,
    );
    try {
      vi.stubEnv('PATH', wrapper.path);
      const changed = await git.changedPaths(worktree);
      vi.unstubAllEnvs();
      expect(existsSync(flag)).toBe(true);
      expect(changed).toEqual(['a.txt']);
      expect(program.ran()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      wrapper.cleanup();
    }
  });
});

describe('fetch and push', () => {
  let remote: ReturnType<typeof createTempRepoWithOrigin>;
  beforeEach(() => {
    remote = createTempRepoWithOrigin();
  });
  afterEach(() => {
    remote.cleanup();
  });
  const net = { env: NETWORK_ENV, timeoutMs: 10_000 };
  const local = (...args: string[]) => gitIn(remote.repo.path, ...args);
  const NETWORK = [
    { name: 'fetch', act: (git: Git) => git.fetch(remote.repo.path, 'main', net) },
    { name: 'push', act: (git: Git) => git.push(remote.repo.path, 'main', net) },
  ];

  it.each(
    NETWORK.flatMap((n) =>
      [
        'core.sshCommand',
        'url.https://evil.invalid/.insteadOf',
        'url.https://evil.invalid/.pushInsteadOf',
        'credential.helper',
        'include.path',
        'http.proxy',
        'remote.origin.receivepack',
        'remote.origin.uploadpack',
      ].map((key) => ({ ...n, key })),
    ),
  )('refuses a $name with $key in the local config, running nothing', async ({ act, key }) => {
    const program = marker('program');
    const git = createGit();
    await git.head(remote.repo.path);
    local('config', key, /^include/i.test(key) ? join(scratch.path, 'absent.cfg') : program.path);
    const error = await refusal(act(git));
    expect(error.detail.kind).toBe('config');
    expect(program.ran()).toBe(false);
  });

  it('still sees the local config when GIT_CONFIG in the daemon environment names another file', async () => {
    const empty = join(scratch.path, 'empty.cfg');
    writeFileSync(empty, '');
    const git = createGit();
    await git.head(remote.repo.path);
    local('config', 'core.sshCommand', 'evil');
    vi.stubEnv('GIT_CONFIG', empty);
    expect((await refusal(git.fetch(remote.repo.path, 'main', net))).detail.kind).toBe('config');
  });

  it.each(NETWORK)(
    'refuses a $name once origin points elsewhere, until the builder re-trusts',
    async ({ name, act }) => {
      const elsewhere = tempDir('elsewhere');
      try {
        gitIn(elsewhere.path, 'init', '-q', '--bare', '-b', 'main');
        for (const [key, value] of Object.entries(TEST_REPO_CONFIG))
          gitIn(elsewhere.path, 'config', key, value);
        local('push', '-q', elsewhere.path, 'main');
        const seeded = gitIn(elsewhere.path, 'rev-parse', 'refs/heads/main');
        local('commit', '-q', '--allow-empty', '-m', 'unpushed');
        const git = createGit();
        await git.head(remote.repo.path);
        local('remote', 'set-url', 'origin', elsewhere.path);
        const { detail } = await refusal(act(git));
        expect(detail).toMatchObject({ kind: 'origin', direction: name });
        expect(gitIn(elsewhere.path, 'rev-parse', 'refs/heads/main')).toBe(seeded);
        if (detail.kind !== 'origin') throw new Error('expected a changed origin');
        await git.retrust(remote.repo.path, detail.candidate);
        await act(git);
      } finally {
        elsewhere.cleanup();
      }
    },
  );

  it.each(
    NETWORK.flatMap((n) =>
      [
        ['a token', 'https://x-access-token:tok-s3cret@github.com/acme/widgets.git'],
        ['several @', 'https://user:p@ss-s3cret@github.com/acme/widgets.git'],
        ['a ? before an @', 'https://a?@evil.invalid/x@github.com/acme/widgets'],
        ['a # before an @', 'https://a#@evil.invalid/x@github.com/acme/widgets'],
        ['a backslash', 'https://github.com\\@evil.invalid/acme/widgets'],
      ].map(([name, url]) => ({ ...n, what: name ?? '', url: url ?? '' })),
    ),
  )(
    'refuses a $name to an origin URL with $what, and shows the URL nowhere',
    async ({ act, url }) => {
      const pins = memoryPinStore();
      const stored: unknown[] = [];
      const onRefused = vi.fn();
      const git = createGit({
        onRefused,
        pins: {
          get: (repo) => pins.get(repo),
          set: (repo, pin) => {
            stored.push(pin);
            pins.set(repo, pin);
          },
          delete: (repo) => {
            pins.delete(repo);
          },
        },
      });
      local('remote', 'set-url', 'origin', url);
      const error = await refusal(act(git));
      expect(error.detail.kind).toBe('remote');
      const card = trustCard(error);
      expect(card.body).toContain('gh auth');
      for (const text of [
        error.message,
        JSON.stringify(error.detail),
        card.title,
        card.body,
        card.foldKey,
        JSON.stringify(stored),
      ]) {
        expect(text).not.toContain('s3cret');
        expect(text).not.toContain('evil.invalid');
      }
    },
  );

  it('keeps a token cut off at the start of what it keeps of git output out of the push error', async () => {
    const wrapper = gitWrapper(
      `case " $* " in *" push "*) printf 'fatal: https://user:tok-SECRET-VALUE@example.invalid/x\\n' >&2; head -c 1973 /dev/zero | tr '\\0' x >&2; exit 1;; esac\nexec "$GIT" "$@"`,
    );
    try {
      const git = createGit();
      await git.head(remote.repo.path);
      vi.stubEnv('PATH', wrapper.path);
      const error: unknown = await git
        .push(remote.repo.path, 'main', {
          env: { ...NETWORK_ENV, PATH: wrapper.path },
          timeoutMs: 10_000,
        })
        .catch((caught: unknown) => caught);
      vi.unstubAllEnvs();
      if (!(error instanceof GitNetworkError))
        throw new Error(`expected the push to fail, got ${String(error)}`);
      for (const text of [error.message, error.detail, error.output]) {
        expect(text).not.toContain('SECRET');
        expect(text).not.toContain('tok-');
        expect(text).not.toContain('VALUE');
      }
    } finally {
      vi.unstubAllEnvs();
      wrapper.cleanup();
    }
  });

  /**
   * The credential config a fetch runs with, in git's order, as `git config --get-regexp` prints it
   * with the fetch's own arguments and environment.
   */
  async function fetchCredentials(env: Readonly<Record<string, string>>): Promise<string[]> {
    const out = join(scratch.path, 'credentials');
    const wrapper = gitWrapper(
      [
        'dump() {',
        '  n=0; for a in "$@"; do [ "$a" = fetch ] && break; n=$((n+1)); done',
        '  i=0; for a in "$@"; do shift; [ "$i" -lt "$n" ] && set -- "$@" "$a"; i=$((i+1)); done',
        `  "$GIT" "$@" config --get-regexp '^credential\\.' > '${out}'`,
        '}',
        'case " $* " in *" fetch "*) dump "$@";; esac',
        'exec "$GIT" "$@"',
      ].join('\n'),
    );
    try {
      await createGit({ bin: join(wrapper.path.split(':')[0] ?? '', 'git') }).fetch(
        remote.repo.path,
        'main',
        { env: { ...NETWORK_ENV, ...env }, timeoutMs: 10_000 },
      );
    } finally {
      wrapper.cleanup();
    }
    return readFileSync(out, 'utf8').split('\n').filter(Boolean);
  }

  it("keeps the builder's URL-scoped credential helpers after resetting the list", async () => {
    const global = join(scratch.path, 'gitconfig');
    writeFileSync(
      global,
      '[credential]\n\thelper = osxkeychain\n[credential "https://github.com"]\n\thelper = !gh auth git-credential\n',
    );
    expect(await fetchCredentials({ GIT_CONFIG_GLOBAL: global })).toEqual([
      'credential.helper osxkeychain',
      'credential.https://github.com.helper !gh auth git-credential',
      'credential.helper ',
      'credential.helper osxkeychain',
      'credential.https://github.com.helper !gh auth git-credential',
    ]);
  });

  it("keeps the login environment's own credential helpers, a URL holding = included", async () => {
    expect(
      await fetchCredentials({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.https://host.example/a=b.helper',
        GIT_CONFIG_VALUE_0: 'store',
        GIT_CONFIG_PARAMETERS: "'credential.https://p.example.helper'='cache'",
      }),
    ).toEqual([
      'credential.helper ',
      'credential.https://host.example/a=b.helper store',
      'credential.https://p.example.helper cache',
    ]);
  });

  it.each(
    (['fetch', 'push'] as const).flatMap((name) =>
      [
        { root: "another registered project's checkout", checkouts: true },
        { root: "a lane's temp root", checkouts: false },
      ].map((r) => ({ name, ...r })),
    ),
  )(
    'refuses a $name whose global config includes a file in $root, using none of its programs',
    async ({ name, checkouts }) => {
      const other = tempDir('other-project');
      try {
        const program = marker('program');
        const included = join(other.path, 'shared.gitconfig');
        writeFileSync(
          included,
          `[core]\n\tsshCommand = ${program.path}\n[credential]\n\thelper = ${program.path}\n`,
        );
        const global = join(scratch.path, 'gitconfig');
        writeFileSync(global, `[include]\n\tpath = ${included}\n`);
        const git = checkouts
          ? createGit({ checkouts: () => [remote.repo.path, other.path] })
          : createGit({ laneRoots: [other.path] });
        const call = { env: { ...NETWORK_ENV, GIT_CONFIG_GLOBAL: global }, timeoutMs: 10_000 };
        const error = await refusal(
          name === 'fetch'
            ? git.fetch(remote.repo.path, 'main', call)
            : git.push(remote.repo.path, 'main', call),
        );
        expect(error.detail).toEqual({
          kind: 'config',
          keys: [
            { key: 'core.sshcommand', file: included },
            { key: 'credential.helper', file: included },
          ],
        });
        expect(program.ran()).toBe(false);
      } finally {
        other.cleanup();
      }
    },
  );

  it.each(
    (['fetch', 'push'] as const).flatMap((name) =>
      ['DEVELOPER_DIR', 'SDKROOT', 'TOOLCHAINS'].map((variable) => ({ name, variable })),
    ),
  )('never hands $variable from the login env to a $name', async ({ name, variable }) => {
    const seen = join(scratch.path, 'xcode-env');
    const wrapper = gitWrapper(`echo "\${${variable}-unset}" >> '${seen}'\nexec "$GIT" "$@"`);
    try {
      const git = createGit({ bin: join(wrapper.path.split(':')[0] ?? '', 'git') });
      const call = {
        env: { ...NETWORK_ENV, [variable]: '/nonexistent/Xcode.app' },
        timeoutMs: 10_000,
      };
      await (name === 'fetch'
        ? git.fetch(remote.repo.path, 'main', call)
        : git.push(remote.repo.path, 'main', call));
      const values = readFileSync(seen, 'utf8').split('\n').filter(Boolean);
      expect(new Set(values)).toEqual(new Set(['unset']));
    } finally {
      wrapper.cleanup();
    }
  });

  it('refuses a push to a local origin inside the checkout, where a lane could write its hooks', async () => {
    const inside = join(remote.repo.path, 'nested-origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', inside], { env: isolatedGitEnv() });
    local('remote', 'set-url', 'origin', inside);
    const error = await refusal(createGit().push(remote.repo.path, 'main', net));
    expect(error.detail).toMatchObject({ kind: 'remote', direction: 'push' });
  });

  it.each([
    { name: 'another registered checkout', root: 'checkout' },
    { name: 'a lane root named through a link', root: 'link' },
  ])('refuses a push to a local origin inside $name', async ({ root }) => {
    const other = tempDir('other-checkout');
    try {
      const inside = join(other.path, 'origin.git');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', inside], {
        env: isolatedGitEnv(),
      });
      local('remote', 'set-url', 'origin', inside);
      const link = join(scratch.path, 'lane-root');
      symlinkSync(other.path, link);
      const git =
        root === 'checkout'
          ? createGit({ checkouts: () => [other.path] })
          : createGit({ laneRoots: [link] });
      const error = await refusal(git.push(remote.repo.path, 'main', net));
      expect(error.detail).toMatchObject({ kind: 'remote', direction: 'push' });
    } finally {
      other.cleanup();
    }
  });

  it('refuses to push a branch whose tree selects a filter, which would leave Git LFS objects behind', async () => {
    writeFileSync(
      join(remote.repo.path, '.gitattributes'),
      '*.bin filter=lfs diff=lfs merge=lfs -text\n',
    );
    local('add', '.gitattributes');
    local('commit', '-q', '-m', 'lfs');
    const before = gitIn(remote.origin.path, 'rev-parse', 'refs/heads/main');
    const error = await refusal(createGit().push(remote.repo.path, 'main', net));
    expect(error.detail).toEqual({
      kind: 'filter',
      paths: [{ path: '.gitattributes', filter: 'lfs' }],
    });
    expect(gitIn(remote.origin.path, 'rev-parse', 'refs/heads/main')).toBe(before);
  });
});

describe('resolveGit', () => {
  /** A git that ignores GIT_ATTR_SOURCE, as git before 2.41 does. */
  const oldGit = () => gitWrapper('unset GIT_ATTR_SOURCE\nexec "$GIT" "$@"');
  const binOf = (path: string) => join(path.split(':')[0] ?? '', 'git');

  it('refuses when no candidate reads no attributes when told to, naming the one it found', async () => {
    const old = oldGit();
    try {
      const error: unknown = await resolveGit([binOf(old.path)]).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GitVersionError);
      expect(String(error)).toContain(binOf(old.path));
      expect(String(error)).toContain('brew install git');
    } finally {
      old.cleanup();
    }
  });

  it('takes the first candidate that passes the probe, as the path it was found at', async () => {
    const old = oldGit();
    try {
      // Named git, as a prefix's link is: Xcode's /usr/bin/git picks the tool by the name it runs as.
      mkdirSync(join(scratch.path, 'prefix'));
      const link = join(scratch.path, 'prefix', 'git');
      symlinkSync(realGit(), link);
      expect(await resolveGit([binOf(old.path), link])).toBe(link);
    } finally {
      old.cleanup();
    }
  });

  it('keeps working after an upgrade replaces the git behind the prefix link and deletes the old one', async () => {
    // Homebrew's layout: the prefix holds a link into a versioned Cellar directory, and an upgrade
    // followed by its cleanup repoints the link and removes the old version.
    const cellar = join(scratch.path, 'Cellar');
    const version = (name: string): string => {
      const dir = join(cellar, name);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'git');
      writeFileSync(path, `#!/bin/sh\nexec '${realGit()}' "$@"\n`);
      chmodSync(path, 0o755);
      return path;
    };
    const link = join(scratch.path, 'prefix-git');
    symlinkSync(version('2.50'), link);
    const bin = await resolveGit([link]);
    unlinkSync(link);
    symlinkSync(version('2.51'), link);
    rmSync(join(cellar, '2.50'), { recursive: true, force: true });
    expect(await runGit(scratch.path, ['--version'], { bin })).toMatch(/^git version /);
  });

  it('refuses when no candidate exists', async () => {
    await expect(resolveGit([join(scratch.path, 'git')])).rejects.toBeInstanceOf(GitVersionError);
  });

  it('never runs or takes a git on PATH, only one in a fixed install prefix', async () => {
    const ran = join(scratch.path, 'path-git-ran');
    const wrapper = gitWrapper(`touch '${ran}'\nexec "$GIT" "$@"`);
    try {
      vi.stubEnv('PATH', wrapper.path);
      const bin = await resolveGit();
      const prefixes = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'];
      expect(prefixes).toContain(bin);
      expect(existsSync(ran)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      wrapper.cleanup();
    }
  });
});

describe('every git the daemon spawns', () => {
  it('runs check-attr with the resolved git, never a git on PATH', async () => {
    const ran = join(scratch.path, 'path-git-ran');
    const bin = realGit();
    const wrapper = gitWrapper(`touch '${ran}'\nexec "$GIT" "$@"`);
    try {
      vi.stubEnv('PATH', wrapper.path);
      await commitA(createGit({ bin }));
      expect(existsSync(ran)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      wrapper.cleanup();
    }
  });

  it('reads the pin inside the lock, so a commit queued behind another sees a .git replaced meanwhile', async () => {
    const git = createGit();
    await git.head(repo.path);
    const flag = join(scratch.path, 'replaced');
    const aside = join(scratch.path, 'old-git');
    const config = Object.entries(TEST_REPO_CONFIG)
      .map(
        ([key, value]) =>
          `env -u GIT_DIR -u GIT_WORK_TREE "$GIT" -C '${repo.path}' config ${key} ${value}`,
      )
      .join('; ');
    // While the first commit holds the lock, its commit-tree replaces .git, as a lane could have.
    const wrapper = gitWrapper(
      `case " $* " in *" commit-tree "*) if [ ! -e '${flag}' ]; then touch '${flag}'; mv '${join(repo.path, '.git')}' '${aside}'; env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE "$GIT" init -q -b main '${repo.path}'; ${config}; fi;; esac\nexec "$GIT" "$@"`,
    );
    try {
      vi.stubEnv('PATH', wrapper.path);
      write('b.txt', 'b');
      const first = commitA(git, 'op-lock-1');
      const second = git.commit({
        repo: repo.path,
        paths: ['b.txt'],
        message: 'b',
        opId: 'op-lock-2',
        branch: 'main',
      });
      await first.catch(() => undefined);
      const error = await refusal(second);
      vi.unstubAllEnvs();
      expect(existsSync(flag)).toBe(true);
      expect(error.detail.kind).toBe('moved');
    } finally {
      vi.unstubAllEnvs();
      wrapper.cleanup();
    }
  });

  it("runs check-attr in the pinned git dir, on the commit's private index", async () => {
    const seen = join(scratch.path, 'check-attr-env');
    const wrapper = gitWrapper(
      `case " $* " in *" check-attr "*) printf '%s\\n%s\\n' "$GIT_DIR" "$GIT_INDEX_FILE" > '${seen}';; esac\nexec "$GIT" "$@"`,
    );
    try {
      const git = createGit({ bin: join(wrapper.path.split(':')[0] ?? '', 'git') });
      await commitA(git);
      const [gitDir = '', index = ''] = readFileSync(seen, 'utf8').split('\n');
      expect(gitDir).toBe(join(realpathSync(repo.path), '.git'));
      expect(index).not.toBe('');
      expect(index).not.toBe(join(gitDir, 'index'));
    } finally {
      wrapper.cleanup();
    }
  });

  it.each(['DEVELOPER_DIR', 'SDKROOT', 'TOOLCHAINS'])(
    "never hands %s to git, so Xcode's shim runs the git that was probed",
    async (name) => {
      const seen = join(scratch.path, 'xcode-env');
      const wrapper = gitWrapper(`echo "\${${name}-unset}" >> '${seen}'\nexec "$GIT" "$@"`);
      try {
        const bin = join(wrapper.path.split(':')[0] ?? '', 'git');
        const git = createGit({ bin });
        vi.stubEnv(name, '/nonexistent/Xcode.app');
        await resolveGit([bin]);
        await git.head(repo.path);
        vi.unstubAllEnvs();
        const values = readFileSync(seen, 'utf8').split('\n').filter(Boolean);
        expect(values.length).toBeGreaterThan(0);
        expect(new Set(values)).toEqual(new Set(['unset']));
      } finally {
        vi.unstubAllEnvs();
        wrapper.cleanup();
      }
    },
  );

  it('reads the pin once per operation, not on every git call', async () => {
    const store = memoryPinStore();
    const get = vi.fn((path: string) => store.get(path));
    const git = createGit({ pins: { ...store, get } });
    await git.head(repo.path);
    for (const act of [() => git.changedPaths(repo.path), () => commitA(git)]) {
      get.mockClear();
      await act();
      expect(get).toHaveBeenCalledTimes(1);
    }
  });
});

describe('runGit', () => {
  it('stops a git call that runs past its timeout', async () => {
    const wrapper = gitWrapper('sleep 5\nexec "$GIT" "$@"');
    try {
      const error: unknown = await runGit(repo.path, ['status'], {
        timeoutMs: 200,
        bin: join(wrapper.path.split(':')[0] ?? '', 'git'),
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GitError);
      expect(String(error)).toContain('still running after 0.2 s');
    } finally {
      wrapper.cleanup();
    }
  });
});
