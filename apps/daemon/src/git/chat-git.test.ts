import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTempRepoWithOrigin,
  isolatedGitEnv,
  NETWORK_ENV,
  tempDir,
  TEST_REPO_CONFIG,
  type TempDir,
} from '../../test/fixtures';
import { writeHook } from '../../test/git-hooks';
import { createGit } from './index';

// Sessions spec §7.3: the git changes a chat's tools make in Your folder run nothing from it and take only
// what they were asked.

const git = createGit();
const NET = { env: NETWORK_ENV, timeoutMs: 20_000 };
let pair: ReturnType<typeof createTempRepoWithOrigin>;
let repo: string;
let scratch: TempDir;

beforeEach(() => {
  pair = createTempRepoWithOrigin();
  repo = pair.repo.path;
  scratch = tempDir('chat-git');
});
afterEach(() => {
  pair.cleanup();
  scratch.cleanup();
});

const raw = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();
const rg = (...args: string[]) => raw(repo, ...args);

function write(rel: string, text: string, root = repo): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A hook program that leaves a marker file, written for every hook git might run in a commit or a switch. */
function plantHooks(): string {
  const marker = join(scratch.path, 'hook-ran');
  const program = join(scratch.path, 'mark.sh');
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(program, 0o755);
  writeHook(
    join(repo, '.git', 'hooks'),
    [
      'pre-commit',
      'prepare-commit-msg',
      'commit-msg',
      'post-commit',
      'post-checkout',
      'post-merge',
      'reference-transaction',
    ],
    program,
  );
  return marker;
}

describe('makeBranchHere', () => {
  it('keeps the changes in the folder, staged and not', async () => {
    write('README.md', '# changed\n');
    write('staged.txt', 'staged\n');
    rg('add', 'staged.txt');
    write('untracked.txt', 'u\n');
    await git.makeBranchHere(repo, 'topic');
    expect(rg('branch', '--show-current')).toBe('topic');
    expect(rg('diff', '--name-only')).toBe('README.md');
    expect(rg('diff', '--cached', '--name-only')).toBe('staged.txt');
    expect(rg('ls-files', '--others', '--exclude-standard')).toBe('untracked.txt');
  });

  it.each([
    ['an existing name', 'main'],
    ['a name that reads as an option', '-c'],
    ['an invalid ref name', 'a..b'],
    ['a name with a space', 'a b'],
  ])('refuses %s', async (_what, name) => {
    await expect(git.makeBranchHere(repo, name)).rejects.toThrow();
    expect(rg('branch', '--show-current')).toBe('main');
  });

  it('runs no hook', async () => {
    const marker = plantHooks();
    await git.makeBranchHere(repo, 'topic');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('moveCommitsToBranch', () => {
  /** Two local commits on main, with origin/main still at the first. */
  function twoAhead(): { origin: string; tip: string } {
    const origin = rg('rev-parse', 'HEAD');
    for (const name of ['a.txt', 'b.txt']) {
      write(name, `${name}\n`);
      rg('add', name);
      rg('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', `add ${name}`);
    }
    return { origin, tip: rg('rev-parse', 'HEAD') };
  }

  it('makes the branch at HEAD, switches to it and puts main back at the origin, keeping uncommitted work', async () => {
    const { origin, tip } = twoAhead();
    write('wip.txt', 'wip\n');
    await git.moveCommitsToBranch(repo, {
      name: 'topic',
      base: 'main',
      to: origin,
      expectedOld: tip,
    });
    expect(rg('branch', '--show-current')).toBe('topic');
    expect(rg('rev-parse', 'topic')).toBe(tip);
    expect(rg('rev-parse', 'main')).toBe(origin);
    expect(rg('ls-files', '--others', '--exclude-standard')).toBe('wip.txt');
    expect(rg('status', '--porcelain')).toBe('?? wip.txt');
  });

  it('writes nothing when main is not where the caller saw it', async () => {
    const { origin, tip } = twoAhead();
    await expect(
      git.moveCommitsToBranch(repo, {
        name: 'topic',
        base: 'main',
        to: origin,
        expectedOld: origin,
      }),
    ).rejects.toThrow(/moved/);
    expect(rg('rev-parse', 'main')).toBe(tip);
    expect(rg('branch', '--show-current')).toBe('main');
    expect(rg('branch', '--list', 'topic')).toBe('');
  });

  it.each([
    ['an existing branch name', 'main'],
    ['a name that reads as an option', '-c'],
  ])('refuses %s without moving main', async (_what, name) => {
    const { origin, tip } = twoAhead();
    await expect(
      git.moveCommitsToBranch(repo, { name, base: 'main', to: origin, expectedOld: tip }),
    ).rejects.toThrow();
    expect(rg('rev-parse', 'main')).toBe(tip);
    expect(rg('branch', '--show-current')).toBe('main');
  });

  describe('refuses, writing nothing, unless the checkout is as the caller saw it', () => {
    const snapshot = () => [
      rg('branch', '--show-current'),
      rg('rev-parse', 'HEAD'),
      rg('branch', '--format=%(refname) %(objectname)'),
    ];

    it('the checkout is on another branch', async () => {
      const { origin, tip } = twoAhead();
      rg('switch', '-q', '-c', 'other');
      write('x.txt', 'x\n');
      rg('add', 'x.txt');
      rg('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'x');
      const before = snapshot();
      await expect(
        git.moveCommitsToBranch(repo, {
          name: 'topic',
          base: 'main',
          to: origin,
          expectedOld: tip,
        }),
      ).rejects.toThrow(/not on main/);
      expect(snapshot()).toEqual(before);
    });

    it('HEAD has moved past the commit the caller saw', async () => {
      const { origin, tip } = twoAhead();
      write('late.txt', 'late\n');
      rg('add', 'late.txt');
      rg('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'late');
      const before = snapshot();
      await expect(
        git.moveCommitsToBranch(repo, {
          name: 'topic',
          base: 'main',
          to: origin,
          expectedOld: tip,
        }),
      ).rejects.toThrow(/moved/);
      expect(snapshot()).toEqual(before);
    });

    it('the target is not an ancestor of the commit the caller saw', async () => {
      const { tip } = twoAhead();
      // A commit made on a side branch from the root: unrelated to main's tip.
      rg('switch', '-q', '--orphan', 'side');
      rg(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'orphan',
      );
      const unrelated = rg('rev-parse', 'HEAD');
      rg('switch', '-q', 'main');
      const before = snapshot();
      await expect(
        git.moveCommitsToBranch(repo, {
          name: 'topic',
          base: 'main',
          to: unrelated,
          expectedOld: tip,
        }),
      ).rejects.toThrow(/ancestor/);
      expect(snapshot()).toEqual(before);
    });
  });

  it('runs no hook', async () => {
    const { origin, tip } = twoAhead();
    const marker = plantHooks();
    await git.moveCommitsToBranch(repo, {
      name: 'topic',
      base: 'main',
      to: origin,
      expectedOld: tip,
    });
    expect(existsSync(marker)).toBe(false);
  });
});

describe('commitInFolder', () => {
  it('commits the named paths, an untracked one too, and leaves another staged file staged', async () => {
    write('staged.txt', 'staged\n');
    rg('add', 'staged.txt');
    write('README.md', '# edited\n');
    write('fresh.txt', 'fresh\n');
    write('other.txt', 'other\n');
    const { sha } = await git.commitInFolder(repo, {
      message: 'Edit the readme',
      paths: ['README.md', 'fresh.txt'],
    });
    expect(rg('rev-parse', 'HEAD')).toBe(sha);
    expect(rg('show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
      'README.md',
      'fresh.txt',
    ]);
    expect(rg('status', '--porcelain').split('\n').sort()).toEqual([
      '?? other.txt',
      'A  staged.txt',
    ]);
    expect(rg('log', '-1', '--format=%an <%ae>')).toBe('10db test <test@10db.invalid>');
  });

  it('commits every change when no path is named', async () => {
    write('README.md', '# edited\n');
    write('fresh.txt', 'fresh\n');
    await git.commitInFolder(repo, { message: 'Everything' });
    expect(rg('status', '--porcelain')).toBe('');
    expect(rg('show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
      'README.md',
      'fresh.txt',
    ]);
  });

  it('takes an option-like path and message as text', async () => {
    write('--amend', 'a file named like an option\n');
    const message = '--amend this is not an option';
    await git.commitInFolder(repo, { message, paths: ['--amend'] });
    expect(rg('log', '-1', '--format=%s')).toBe(message);
    expect(rg('show', '--name-only', '--format=', 'HEAD')).toBe('--amend');
    expect(rg('rev-list', '--count', 'HEAD')).toBe('2');
  });

  // Git's objects stay readable to a sandboxed session though the kernel denies it the file, so a commit of a
  // secret would hand it over.
  describe('with files the session may not read', () => {
    it.each([
      ['an env file the folder does not ignore', '.env.local', undefined],
      ['an env file in a folder', 'app/.env.prod', undefined],
      ['a file the session lists as secret', 'config/prod.txt', ['config/prod.txt']],
      ['a file under a folder the session lists as secret', 'vault/deep/a.txt', ['vault']],
    ])('refuses %s, names it and commits nothing', async (_what, secret, listed) => {
      write(secret, 'TOKEN=1\n');
      write('README.md', '# edited\n');
      const before = rg('rev-parse', 'HEAD');
      const input = {
        message: 'x',
        ...(listed === undefined ? {} : { secretFiles: listed.map((f) => join(repo, f)) }),
      };
      await expect(git.commitInFolder(repo, input)).rejects.toThrow(secret);
      await expect(git.commitInFolder(repo, { ...input, paths: [secret] })).rejects.toThrow(secret);
      expect(rg('rev-parse', 'HEAD')).toBe(before);
      expect(rg('diff', '--cached', '--name-only')).toBe('');
    });

    // The refusal comes before anything is staged: a staged file is an object in .git, which the session reads.
    it('leaves no object for a refused secret, with a path named or not', async () => {
      write('.env.local', 'TOKEN=only-here-4f2a\n');
      const oid = rg('hash-object', '.env.local');
      await expect(git.commitInFolder(repo, { message: 'x' })).rejects.toThrow('.env.local');
      await expect(
        git.commitInFolder(repo, { message: 'x', paths: ['.env.local'] }),
      ).rejects.toThrow('.env.local');
      expect(() => rg('cat-file', '-e', oid)).toThrow();
    });

    it('commits the named files that are not secret even when a secret sits beside them', async () => {
      write('.env.local', 'TOKEN=1\n');
      write('README.md', '# edited\n');
      await git.commitInFolder(repo, { message: 'readme', paths: ['README.md'] });
      expect(rg('show', '--name-only', '--format=', 'HEAD')).toBe('README.md');
    });
  });

  it('refuses a path outside the folder, git state, an empty message and nothing changed', async () => {
    write('a.txt', 'a\n');
    for (const paths of [['../outside.txt'], ['/etc/hosts'], ['.git/config'], ['sub/.GIT/x']])
      await expect(git.commitInFolder(repo, { message: 'x', paths })).rejects.toThrow();
    await expect(git.commitInFolder(repo, { message: '  ', paths: ['a.txt'] })).rejects.toThrow(
      'message',
    );
    await git.commitInFolder(repo, { message: 'a', paths: ['a.txt'] });
    await expect(git.commitInFolder(repo, { message: 'again' })).rejects.toThrow('Nothing');
    await expect(git.commitInFolder(repo, { message: 'again', paths: ['a.txt'] })).rejects.toThrow(
      'Nothing',
    );
  });

  it('refuses a path whose attributes ask for a filter, and commits nothing', async () => {
    write('.gitattributes', '*.bin filter=lfs\n');
    write('big.bin', 'pointer?\n');
    const before = rg('rev-parse', 'HEAD');
    await expect(git.commitInFolder(repo, { message: 'x' })).rejects.toThrow('filter');
    await expect(git.commitInFolder(repo, { message: 'x', paths: ['big.bin'] })).rejects.toThrow(
      'filter',
    );
    expect(rg('rev-parse', 'HEAD')).toBe(before);
  });

  it('runs no hook', async () => {
    const marker = plantHooks();
    write('a.txt', 'a\n');
    await git.commitInFolder(repo, { message: 'a' });
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses while a merge is in progress', async () => {
    write('a.txt', 'a\n');
    writeFileSync(join(repo, '.git', 'MERGE_HEAD'), `${rg('rev-parse', 'HEAD')}\n`);
    await expect(git.commitInFolder(repo, { message: 'a' })).rejects.toThrow('in progress');
  });
});

// A repository the agent made inside the folder is its own: its config is the agent's to write, so no call here
// may run a git in it, whatever `.gitmodules` says about ignoring it.
describe('a nested repository the agent controls', () => {
  const MARKERS = ['fsmonitor', 'hook', 'filter'] as const;

  /**
   * A committed gitlink whose `.gitmodules` says `ignore = none`, and whose own config runs a marker program as
   * an fsmonitor, as a `post-index-change` hook and as a clean filter on every file, with a change inside it.
   */
  function plantNested(): Record<(typeof MARKERS)[number], string> {
    const marker = (name: string) => join(scratch.path, `${name}-ran`);
    const sub = join(repo, 'sub');
    mkdirSync(sub);
    raw(sub, 'init', '-q');
    raw(sub, 'config', 'user.email', 'a@b.invalid');
    raw(sub, 'config', 'user.name', 'a');
    raw(sub, 'config', 'commit.gpgsign', 'false');
    write('f.txt', 'one\n', sub);
    raw(sub, 'add', '-A');
    raw(sub, 'commit', '-q', '-m', 'one');
    write('.gitmodules', '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = none\n');
    rg('add', 'sub', '.gitmodules');
    rg('commit', '-q', '-m', 'Add the gitlink');
    const script = (name: string, body: string) => {
      const file = join(scratch.path, `${name}.sh`);
      writeFileSync(file, `#!/bin/sh\ntouch '${marker(name)}'\n${body}`);
      chmodSync(file, 0o755);
      return file;
    };
    raw(sub, 'config', 'core.fsmonitor', script('fsmonitor', ''));
    const hooks = join(scratch.path, 'hooks');
    mkdirSync(hooks);
    const hook = script('hook', '');
    writeFileSync(join(hooks, 'post-index-change'), readFileSync(hook));
    chmodSync(join(hooks, 'post-index-change'), 0o755);
    raw(sub, 'config', 'core.hooksPath', hooks);
    raw(sub, 'config', 'filter.x.clean', script('filter', 'cat\n'));
    write('.gitattributes', '* filter=x\n', sub);
    write('f.txt', 'two\n', sub);
    return { fsmonitor: marker('fsmonitor'), hook: marker('hook'), filter: marker('filter') };
  }

  // The control: plain git, as the builder's own would run it, does run the planted programs, so the row below
  // would catch a call that reached the nested repository.
  it('is read by an unpinned git status, which is what the fixture is for', () => {
    const markers = plantNested();
    rg('status', '--porcelain');
    expect(MARKERS.some((name) => existsSync(markers[name]))).toBe(true);
  });

  it('is never asked for its status by a commit, a switch or a branch', async () => {
    const markers = plantNested();
    rg('branch', 'other');
    write('mine.txt', 'mine\n');
    await git.commitInFolder(repo, { message: 'Mine' });
    await git.switchBranch(repo, 'other');
    await git.makeBranchHere(repo, 'topic');
    for (const name of MARKERS) expect(existsSync(markers[name])).toBe(false);
  });

  // Naming the gitlink as a path is how an add reaches it: git then reads its status to stage it.
  it('is never asked for its status when the commit names it', async () => {
    const markers = plantNested();
    write('mine.txt', 'mine\n');
    await git.commitInFolder(repo, { message: 'Mine', paths: ['sub', 'mine.txt'] });
    for (const name of MARKERS) expect(existsSync(markers[name])).toBe(false);
  });
});

describe('switchBranch', () => {
  beforeEach(() => {
    rg('switch', '-q', '-c', 'other');
    write('README.md', '# other\n');
    write('other.txt', 'other\n');
    rg('add', '-A');
    rg('commit', '-q', '-m', 'Other');
    rg('switch', '-q', 'main');
  });

  it('carries changes git can carry', async () => {
    write('mine.txt', 'mine\n');
    await git.switchBranch(repo, 'other');
    expect(rg('branch', '--show-current')).toBe('other');
    expect(readFileSync(join(repo, 'mine.txt'), 'utf8')).toBe('mine\n');
  });

  it('refuses a change it would overwrite, in git’s words, and moves nothing', async () => {
    write('README.md', '# mine\n');
    await expect(git.switchBranch(repo, 'other')).rejects.toThrow(/overwritten|local changes/);
    expect(rg('branch', '--show-current')).toBe('main');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# mine\n');
  });

  it('refuses a name with no local branch, and one that reads as an option', async () => {
    await expect(git.switchBranch(repo, 'nowhere')).rejects.toThrow('no local branch');
    await expect(git.switchBranch(repo, '--detach')).rejects.toThrow();
    expect(rg('branch', '--show-current')).toBe('main');
  });

  // `@{-1}` names the branch the folder was on before; a chat's name check reads the text it was given, so git
  // must not act on what the name expands to.
  it.each([['makeBranchHere'], ['switchBranch']] as const)(
    '%s refuses a name that git expands to another branch',
    async (method) => {
      rg('switch', '-q', '-c', '10db/batch-x');
      rg('switch', '-q', 'main');
      await expect(git[method](repo, '@{-1}')).rejects.toThrow(/@\{/);
      expect(rg('branch', '--show-current')).toBe('main');
    },
  );

  it('refuses a branch whose tree asks for a filter', async () => {
    rg('switch', '-q', 'other');
    write('.gitattributes', '*.bin filter=lfs\n');
    rg('add', '-A');
    rg('commit', '-q', '-m', 'Filter');
    rg('switch', '-q', 'main');
    await expect(git.switchBranch(repo, 'other')).rejects.toThrow('filter');
    expect(rg('branch', '--show-current')).toBe('main');
  });

  it('runs no hook', async () => {
    const marker = plantHooks();
    await git.switchBranch(repo, 'other');
    expect(existsSync(marker)).toBe(false);
  });

  it('leaves a submodule where it is even when the builder’s config recurses', async () => {
    const sub = join(scratch.path, 'sub');
    mkdirSync(sub);
    raw(sub, 'init', '-q', '-b', 'main');
    for (const [key, value] of Object.entries(TEST_REPO_CONFIG)) raw(sub, 'config', key, value);
    raw(sub, 'config', 'user.name', 'sub');
    raw(sub, 'config', 'user.email', 'sub@10db.invalid');
    write('a', '1\n', sub);
    raw(sub, 'add', '-A');
    raw(sub, 'commit', '-q', '-m', 'one');
    rg('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor');
    rg('commit', '-q', '-m', 'Add vendor');
    rg('switch', '-q', '-c', 'moves');
    write('a', '2\n', sub);
    raw(sub, 'commit', '-q', '-am', 'two');
    rg('-c', 'protocol.file.allow=always', 'submodule', 'update', '--remote', '-q');
    rg('add', 'vendor');
    rg('commit', '-q', '-m', 'Move vendor');
    rg('switch', '-q', 'main');
    rg('config', 'submodule.recurse', 'true');
    const at = raw(join(repo, 'vendor'), 'rev-parse', 'HEAD');
    await git.switchBranch(repo, 'moves');
    expect(rg('branch', '--show-current')).toBe('moves');
    expect(raw(join(repo, 'vendor'), 'rev-parse', 'HEAD')).toBe(at);
  });
});

describe('pullFastForward', () => {
  /** A second clone pushes `count` commits to origin's `feature`. */
  function advanceOrigin(count: number, file = 'remote.txt'): void {
    const clone = join(scratch.path, 'clone');
    if (!existsSync(clone)) {
      raw(scratch.path, 'clone', '-q', pair.origin.path, clone);
      raw(clone, 'config', 'user.name', 'someone');
      raw(clone, 'config', 'user.email', 'someone@10db.invalid');
      for (const [key, value] of Object.entries(TEST_REPO_CONFIG)) raw(clone, 'config', key, value);
      raw(clone, 'switch', '-q', 'feature');
    }
    for (let i = 0; i < count; i += 1) {
      write(file, `remote ${String(i)}\n`, clone);
      raw(clone, 'add', '-A');
      raw(clone, 'commit', '-q', '-m', `Remote ${String(i)}`);
    }
    raw(clone, 'push', '-q', 'origin', 'feature');
  }

  beforeEach(() => {
    // `feature` exists at origin; the folder's `topic` follows it under another name.
    rg('push', '-q', 'origin', 'main:refs/heads/feature');
    const clone = join(scratch.path, 'seed');
    raw(scratch.path, 'clone', '-q', pair.origin.path, clone);
    rg('switch', '-q', '-c', 'topic');
    rg('config', 'branch.topic.remote', 'origin');
    rg('config', 'branch.topic.merge', 'refs/heads/feature');
    rmSync(clone, { recursive: true, force: true });
  });

  it('fast-forwards from a differently named upstream', async () => {
    advanceOrigin(2);
    const result = await git.pullFastForward(repo, NET);
    expect(result.kind).toBe('pulled');
    expect(readFileSync(join(repo, 'remote.txt'), 'utf8')).toBe('remote 1\n');
    expect(rg('status', '--porcelain')).toBe('');
    expect(rg('rev-parse', 'topic')).toBe(rg('rev-parse', 'origin/feature'));
  });

  it('says it is up to date, and ahead', async () => {
    expect((await git.pullFastForward(repo, NET)).kind).toBe('up_to_date');
    write('a.txt', 'a\n');
    await git.commitInFolder(repo, { message: 'local' });
    expect((await git.pullFastForward(repo, NET)).kind).toBe('ahead');
  });

  it('refuses a diverged branch and moves nothing', async () => {
    advanceOrigin(1);
    write('a.txt', 'a\n');
    await git.commitInFolder(repo, { message: 'local' });
    const before = rg('rev-parse', 'HEAD');
    expect((await git.pullFastForward(repo, NET)).kind).toBe('diverged');
    expect(rg('rev-parse', 'HEAD')).toBe(before);
  });

  it('carries an unrelated change and stops at one the pull would overwrite', async () => {
    advanceOrigin(1);
    write('mine.txt', 'mine\n');
    expect((await git.pullFastForward(repo, NET)).kind).toBe('pulled');
    expect(readFileSync(join(repo, 'mine.txt'), 'utf8')).toBe('mine\n');
    advanceOrigin(1, 'mine.txt');
    const result = await git.pullFastForward(repo, NET);
    expect(result).toEqual({ kind: 'dirty', paths: ['mine.txt'] });
  });

  it('refuses a detached HEAD, a branch with no upstream and a tree that asks for a filter', async () => {
    rg('switch', '-q', '-c', 'loose');
    await expect(git.pullFastForward(repo, NET)).rejects.toThrow('no upstream');
    rg('switch', '-q', '--detach', 'HEAD');
    await expect(git.pullFastForward(repo, NET)).rejects.toThrow('detached');
    rg('switch', '-q', 'topic');
    const clone = join(scratch.path, 'clone');
    advanceOrigin(1);
    write('.gitattributes', '*.bin filter=lfs\n', clone);
    raw(clone, 'add', '-A');
    raw(clone, 'commit', '-q', '-m', 'Filter');
    raw(clone, 'push', '-q', 'origin', 'feature');
    await expect(git.pullFastForward(repo, NET)).rejects.toThrow('filter');
  });

  it('runs no hook', async () => {
    advanceOrigin(1);
    const marker = plantHooks();
    await git.pullFastForward(repo, NET);
    expect(existsSync(marker)).toBe(false);
  });
});
