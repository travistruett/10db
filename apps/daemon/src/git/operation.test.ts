import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTempRepo,
  isolatedGitEnv,
  tempDir,
  TEST_REPO_CONFIG,
  type TempDir,
} from '../../test/fixtures';
import { gitWrapper } from '../../test/git-wrapper';
import { createGit, GitTrustError } from './index';

let repo: TempDir;
let scratch: TempDir;
let wrapper: ReturnType<typeof gitWrapper>;
let log: string;
beforeEach(() => {
  repo = createTempRepo();
  scratch = tempDir('git-operation');
  log = join(scratch.path, 'calls');
  writeFileSync(log, '');
  // Every call's subcommand words, one line per spawn.
  wrapper = gitWrapper(`printf '%s\\n' "$*" >> '${log}'\nexec "$GIT" "$@"`);
});
afterEach(() => {
  wrapper.cleanup();
  repo.cleanup();
  scratch.cleanup();
});

const bin = () => join(wrapper.path.split(':')[0] ?? '', 'git');
const spawned = (word: string): number =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.includes(word)).length;

/** Moves `.git` aside and makes a new repository in its place, as a lane could. */
function replaceGitDir(): void {
  renameSync(join(repo.path, '.git'), join(scratch.path, 'old-git'));
  const env = isolatedGitEnv();
  execFileSync('git', ['-C', repo.path, 'init', '-q', '-b', 'main'], { env });
  for (const [key, value] of [
    ...Object.entries(TEST_REPO_CONFIG),
    ['user.name', 'lane'],
    ['user.email', 'lane@10db.invalid'],
  ] as const)
    execFileSync('git', ['-C', repo.path, 'config', key, value], { env });
  execFileSync('git', ['-C', repo.path, 'commit', '-q', '--allow-empty', '-m', 'swapped'], { env });
}

describe('a git operation', () => {
  it('reads the git dirs once for every call in it, where each call outside one reads them', async () => {
    const git = createGit({ bin: bin() });
    await git.head(repo.path);
    await git.currentBranch(repo.path);
    await git.changedPaths(repo.path);
    expect(spawned('--absolute-git-dir')).toBe(3);

    writeFileSync(log, '');
    await git.operation(async () => {
      await git.head(repo.path);
      await git.currentBranch(repo.path);
      await git.changedPaths(repo.path);
    });
    expect(spawned('--absolute-git-dir')).toBe(1);
  });

  it('resolves with what its function does, and a call that fails passes through', async () => {
    const git = createGit({ bin: bin() });
    expect(await git.operation(() => git.currentBranch(repo.path))).toBe('main');
    await expect(
      git.operation(async () => {
        await git.head(repo.path);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('keeps each checkout separate and nests into the operation around it', async () => {
    const other = createTempRepo();
    try {
      const git = createGit({ bin: bin() });
      await git.operation(async () => {
        await git.head(repo.path);
        await git.operation(async () => {
          await git.head(repo.path);
          await git.head(other.path);
        });
        await git.head(other.path);
      });
      expect(spawned('--absolute-git-dir')).toBe(2);
    } finally {
      other.cleanup();
    }
  });

  it('refuses a call in it that finds .git replaced since the operation read it, without reading it', async () => {
    const git = createGit({ bin: bin() });
    await git.operation(async () => {
      await git.currentBranch(repo.path);
      replaceGitDir();
      const error: unknown = await git.head(repo.path).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GitTrustError);
    });
  });

  it('refuses the call after it that finds .git replaced, as a call outside one does', async () => {
    const git = createGit({ bin: bin() });
    await git.operation(async () => {
      await git.head(repo.path);
      replaceGitDir();
    });
    const error: unknown = await git.head(repo.path).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitTrustError);
  });

  it('refuses a .git replaced before its first call, and caches nothing of a refusal', async () => {
    const git = createGit({ bin: bin() });
    await git.head(repo.path);
    replaceGitDir();
    await git.operation(async () => {
      for (let i = 0; i < 2; i++) {
        const error: unknown = await git.head(repo.path).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(GitTrustError);
      }
    });
  });

  it("reads origin's URL once for the calls in it that ask for it", async () => {
    execFileSync(
      'git',
      ['-C', repo.path, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git'],
      { env: isolatedGitEnv() },
    );
    const git = createGit({ bin: bin() });
    await git.head(repo.path);
    writeFileSync(log, '');
    await git.remoteUrl(repo.path, 'origin');
    await git.remoteUrl(repo.path, 'origin');
    expect(spawned('get-url')).toBe(2);

    writeFileSync(log, '');
    const urls = await git.operation(async () => [
      await git.remoteUrl(repo.path, 'origin'),
      await git.remoteUrl(repo.path, 'origin'),
    ]);
    expect(urls).toEqual([
      'https://github.com/acme/widgets.git',
      'https://github.com/acme/widgets.git',
    ]);
    expect(spawned('get-url')).toBe(1);
  });

  it("reads origin's URL again when the config changed meanwhile", async () => {
    execFileSync(
      'git',
      ['-C', repo.path, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git'],
      { env: isolatedGitEnv() },
    );
    const git = createGit({ bin: bin() });
    await git.head(repo.path);
    const urls = await git.operation(async () => {
      const before = await git.remoteUrl(repo.path, 'origin');
      execFileSync(
        'git',
        ['-C', repo.path, 'remote', 'set-url', 'origin', 'https://github.com/evil/widgets.git'],
        { env: isolatedGitEnv() },
      );
      return [before, await git.remoteUrl(repo.path, 'origin')];
    });
    expect(urls).toEqual([
      'https://github.com/acme/widgets.git',
      'https://github.com/evil/widgets.git',
    ]);
  });
});
