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

/** What `act` threw, or a note that it did not, so a soft check names the row. */
const caught = (act: Promise<unknown>) =>
  act.then(
    () => 'no refusal',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

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
  it('keeps the changes in the folder, staged and not, and runs no hook', async () => {
    write('README.md', '# changed\n');
    write('staged.txt', 'staged\n');
    rg('add', 'staged.txt');
    write('untracked.txt', 'u\n');
    const marker = plantHooks();
    await git.makeBranchHere(repo, 'topic');
    expect(rg('branch', '--show-current')).toBe('topic');
    expect(rg('diff', '--name-only')).toBe('README.md');
    expect(rg('diff', '--cached', '--name-only')).toBe('staged.txt');
    expect(rg('ls-files', '--others', '--exclude-standard')).toBe('untracked.txt');
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a name that exists, reads as an option, is no valid ref or holds a space', async () => {
    for (const [what, name] of [
      ['an existing name', 'main'],
      ['a name that reads as an option', '-c'],
      ['an invalid ref name', 'a..b'],
      ['a name with a space', 'a b'],
    ] as const) {
      expect.soft(await caught(git.makeBranchHere(repo, name)), what).not.toBe('no refusal');
      expect.soft(rg('branch', '--show-current'), what).toBe('main');
    }
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

  it('makes the branch at HEAD, switches to it and puts main back at the origin, keeping uncommitted work and running no hook', async () => {
    const { origin, tip } = twoAhead();
    write('wip.txt', 'wip\n');
    const marker = plantHooks();
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
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses, writing nothing, a taken or option-like name, or a checkout not as the caller saw it', async () => {
    const snapshot = () => [
      rg('branch', '--show-current'),
      rg('rev-parse', 'HEAD'),
      rg('branch', '--format=%(refname) %(objectname)'),
    ];
    const commit = (file: string) => {
      write(file, `${file}\n`);
      rg('add', file);
      rg('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', file);
    };
    // One folder two commits ahead; each row changes it from where the last left it, and only the
    // condition the row names differs from a call that would go through.
    const rows: readonly {
      name: string;
      /** Sets the checkout up; answers the call's input. */
      arrange: (seen: { origin: string; tip: string }) => {
        name?: string;
        to?: string;
        expectedOld?: string;
      };
      error: RegExp;
      /** Puts the checkout back for the rows after. */
      after?: () => void;
    }[] = [
      {
        name: 'main is not where the caller saw it',
        arrange: ({ origin }) => ({ expectedOld: origin }),
        error: /moved/,
      },
      { name: 'an existing branch name', arrange: () => ({ name: 'main' }), error: /./ },
      { name: 'a name that reads as an option', arrange: () => ({ name: '-c' }), error: /./ },
      {
        name: 'the checkout is on another branch',
        arrange: () => {
          rg('switch', '-q', '-c', 'other');
          commit('x.txt');
          return {};
        },
        error: /not on main/,
        after: () => {
          rg('switch', '-q', 'main');
        },
      },
      {
        name: 'HEAD has moved past the commit the caller saw',
        arrange: () => {
          commit('late.txt');
          return {};
        },
        error: /moved/,
      },
      {
        name: 'the target is not an ancestor of the commit the caller saw',
        arrange: () => {
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
          // Main is where the caller saw it: only the target is wrong.
          return { to: unrelated, expectedOld: rg('rev-parse', 'main') };
        },
        error: /ancestor/,
      },
    ];
    const seen = twoAhead();
    for (const { name, arrange, error, after } of rows) {
      const input = arrange(seen);
      const before = snapshot();
      const moved = git.moveCommitsToBranch(repo, {
        name: input.name ?? 'topic',
        base: 'main',
        to: input.to ?? seen.origin,
        expectedOld: input.expectedOld ?? seen.tip,
      });
      const refusal = await caught(moved);
      expect.soft(refusal, name).not.toBe('no refusal');
      expect.soft(refusal, name).toMatch(error);
      expect.soft(snapshot(), `nothing written: ${name}`).toEqual(before);
      after?.();
    }
  });
});

describe('commitInFolder', () => {
  it('commits the named paths, an untracked one too, leaves another staged file staged, and runs no hook', async () => {
    write('staged.txt', 'staged\n');
    rg('add', 'staged.txt');
    write('README.md', '# edited\n');
    write('fresh.txt', 'fresh\n');
    write('other.txt', 'other\n');
    const marker = plantHooks();
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
    expect(existsSync(marker)).toBe(false);
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
    // The refusal comes before anything is staged: a staged file is an object in .git, which the
    // session reads. The named files that are not secret still commit beside one.
    it('refuses each secret, names it, commits nothing and leaves no object of it, but commits a file beside it', async () => {
      for (const [what, secret, listed] of [
        ['an env file the folder does not ignore', '.env.local', undefined],
        ['an env file in a folder', 'app/.env.prod', undefined],
        ['a file the session lists as secret', 'config/prod.txt', ['config/prod.txt']],
        ['a file under a folder the session lists as secret', 'vault/deep/a.txt', ['vault']],
      ] as const) {
        write(secret, `TOKEN=only-here-${what}\n`);
        write('README.md', `# edited beside ${secret}\n`);
        const oid = rg('hash-object', secret);
        const before = rg('rev-parse', 'HEAD');
        const input = {
          message: 'x',
          ...(listed === undefined ? {} : { secretFiles: listed.map((f) => join(repo, f)) }),
        };
        expect.soft(await caught(git.commitInFolder(repo, input)), what).toContain(secret);
        expect
          .soft(await caught(git.commitInFolder(repo, { ...input, paths: [secret] })), what)
          .toContain(secret);
        expect.soft(rg('rev-parse', 'HEAD'), `nothing committed: ${what}`).toBe(before);
        expect.soft(rg('diff', '--cached', '--name-only'), `nothing staged: ${what}`).toBe('');
        expect.soft(() => rg('cat-file', '-e', oid), `no object: ${what}`).toThrow();
        await git.commitInFolder(repo, { ...input, message: 'readme', paths: ['README.md'] });
        expect
          .soft(rg('show', '--name-only', '--format=', 'HEAD'), `beside: ${what}`)
          .toBe('README.md');
        // The next row's secret is the only one in the folder.
        rmSync(join(repo, secret));
      }
    });
  });

  it('refuses a path outside the folder, git state, an empty message, nothing changed, a filter and a merge in progress', async () => {
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

    // A path whose attributes ask for a filter: nothing is committed.
    write('.gitattributes', '*.bin filter=lfs\n');
    write('big.bin', 'pointer?\n');
    const before = rg('rev-parse', 'HEAD');
    await expect(git.commitInFolder(repo, { message: 'x' })).rejects.toThrow('filter');
    await expect(git.commitInFolder(repo, { message: 'x', paths: ['big.bin'] })).rejects.toThrow(
      'filter',
    );
    expect(rg('rev-parse', 'HEAD')).toBe(before);
    rmSync(join(repo, '.gitattributes'));
    rmSync(join(repo, 'big.bin'));

    // A merge in progress.
    write('b.txt', 'b\n');
    writeFileSync(join(repo, '.git', 'MERGE_HEAD'), `${rg('rev-parse', 'HEAD')}\n`);
    await expect(git.commitInFolder(repo, { message: 'b' })).rejects.toThrow('in progress');
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

  // Naming the gitlink as a path is how an add reaches it: git then reads its status to stage it.
  it('is never asked for its status by a commit, one that names it too, a switch or a branch', async () => {
    const markers = plantNested();
    rg('branch', 'other');
    write('named.txt', 'mine\n');
    await git.commitInFolder(repo, { message: 'Named', paths: ['sub', 'named.txt'] });
    for (const name of MARKERS)
      expect.soft(existsSync(markers[name]), `commit naming it: ${name}`).toBe(false);
    write('mine.txt', 'mine\n');
    await git.commitInFolder(repo, { message: 'Mine' });
    await git.switchBranch(repo, 'other');
    await git.makeBranchHere(repo, 'topic');
    for (const name of MARKERS)
      expect.soft(existsSync(markers[name]), `commit, switch, branch: ${name}`).toBe(false);
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

  it('carries changes git can carry, and runs no hook', async () => {
    write('mine.txt', 'mine\n');
    const marker = plantHooks();
    await git.switchBranch(repo, 'other');
    expect(rg('branch', '--show-current')).toBe('other');
    expect(readFileSync(join(repo, 'mine.txt'), 'utf8')).toBe('mine\n');
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses, moving nothing, a missing or option-like name, one git expands, a change it would overwrite and a tree that asks for a filter', async () => {
    await expect(git.switchBranch(repo, 'nowhere')).rejects.toThrow('no local branch');
    await expect(git.switchBranch(repo, '--detach')).rejects.toThrow();
    expect(rg('branch', '--show-current')).toBe('main');

    // `@{-1}` names the branch the folder was on before; a chat's name check reads the text it was
    // given, so git must not act on what the name expands to.
    rg('switch', '-q', '-c', '10db/batch-x');
    rg('switch', '-q', 'main');
    for (const method of ['makeBranchHere', 'switchBranch'] as const) {
      expect.soft(await caught(git[method](repo, '@{-1}')), method).toMatch(/@\{/);
      expect.soft(rg('branch', '--show-current'), method).toBe('main');
    }

    // A change it would overwrite, refused in git's words.
    write('README.md', '# mine\n');
    await expect(git.switchBranch(repo, 'other')).rejects.toThrow(/overwritten|local changes/);
    expect(rg('branch', '--show-current')).toBe('main');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# mine\n');
    rg('checkout', '-q', '--', 'README.md');

    rg('switch', '-q', 'other');
    write('.gitattributes', '*.bin filter=lfs\n');
    rg('add', '-A');
    rg('commit', '-q', '-m', 'Filter');
    rg('switch', '-q', 'main');
    await expect(git.switchBranch(repo, 'other')).rejects.toThrow('filter');
    expect(rg('branch', '--show-current')).toBe('main');
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

  it('fast-forwards from a differently named upstream, running no hook', async () => {
    advanceOrigin(2);
    const marker = plantHooks();
    const result = await git.pullFastForward(repo, NET);
    expect(result.kind).toBe('pulled');
    expect(readFileSync(join(repo, 'remote.txt'), 'utf8')).toBe('remote 1\n');
    expect(rg('status', '--porcelain')).toBe('');
    expect(rg('rev-parse', 'topic')).toBe(rg('rev-parse', 'origin/feature'));
    expect(existsSync(marker)).toBe(false);
  });

  it('says it is up to date, then ahead, and refuses a diverged branch, moving nothing', async () => {
    expect((await git.pullFastForward(repo, NET)).kind).toBe('up_to_date');
    write('a.txt', 'a\n');
    await git.commitInFolder(repo, { message: 'local' });
    expect((await git.pullFastForward(repo, NET)).kind).toBe('ahead');
    advanceOrigin(1);
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
});
