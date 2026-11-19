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
function setUp(): void {
  repo = createTempRepo();
  scratch = tempDir('git-operation');
  log = join(scratch.path, 'calls');
  writeFileSync(log, '');
  // Every call's subcommand words, one line per spawn.
  wrapper = gitWrapper(`printf '%s\\n' "$*" >> '${log}'\nexec "$GIT" "$@"`);
}
function tearDown(): void {
  wrapper.cleanup();
  repo.cleanup();
  scratch.cleanup();
}
beforeEach(setUp);
afterEach(tearDown);

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
  it('reads the git dirs once for every call in it and per checkout, nesting into the one around it, until its function settles', async () => {
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

    // It resolves with what its function does, and a call that fails passes through.
    expect(await git.operation(() => git.currentBranch(repo.path))).toBe('main');
    await expect(
      git.operation(async () => {
        await git.head(repo.path);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Each checkout is kept separate, and an operation nests into the one around it.
    const other = createTempRepo();
    try {
      writeFileSync(log, '');
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

    // It ends when its function settles: a callback it scheduled reads the git dirs again.
    let later: Promise<void> = Promise.resolve();
    await git.operation(async () => {
      await git.head(repo.path);
      // As a bus listener or a timer started inside it would: it keeps the async context.
      later = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          writeFileSync(log, '');
          git
            .operation(async () => {
              await git.head(repo.path);
              await git.currentBranch(repo.path);
            })
            .then(() => git.head(repo.path))
            .then(() => {
              resolve();
            }, reject);
        }, 0);
      });
    });
    await later;
    // One for the fresh operation's first call, one for the call outside any operation.
    expect(spawned('--absolute-git-dir')).toBe(2);
  });

  it('refuses a call that finds .git replaced before, during or after it, caching nothing of a refusal', async () => {
    const rows: { name: string; run: (git: ReturnType<typeof createGit>) => Promise<void> }[] = [
      {
        name: 'a call in it that finds .git replaced since the operation read it',
        run: (git) =>
          git.operation(async () => {
            await git.currentBranch(repo.path);
            replaceGitDir();
            const error: unknown = await git.head(repo.path).catch((caught: unknown) => caught);
            expect.soft(error, 'a call in it').toBeInstanceOf(GitTrustError);
          }),
      },
      {
        name: 'the call after it that finds .git replaced, as a call outside one does',
        run: async (git) => {
          await git.operation(async () => {
            await git.head(repo.path);
            replaceGitDir();
          });
          const error: unknown = await git.head(repo.path).catch((caught: unknown) => caught);
          expect.soft(error, 'the call after it').toBeInstanceOf(GitTrustError);
        },
      },
      {
        name: 'a .git replaced before its first call',
        run: async (git) => {
          await git.head(repo.path);
          replaceGitDir();
          await git.operation(async () => {
            for (let i = 0; i < 2; i++) {
              const error: unknown = await git.head(repo.path).catch((caught: unknown) => caught);
              expect
                .soft(error, `before its first call, call ${String(i)}`)
                .toBeInstanceOf(GitTrustError);
            }
          });
        },
      },
    ];
    for (const row of rows) {
      tearDown();
      setUp();
      await row.run(createGit({ bin: bin() }));
    }
  });

  it('honours a retrust made between two of its calls', async () => {
    execFileSync(
      'git',
      ['-C', repo.path, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git'],
      { env: isolatedGitEnv() },
    );
    const trusted: string[] = [];
    const git = createGit({
      bin: bin(),
      onTrusted: (real) => {
        trusted.push(real);
      },
    });
    await git.operation(async () => {
      await git.pinnedPushUrl(repo.path);
      execFileSync(
        'git',
        ['-C', repo.path, 'remote', 'set-url', 'origin', 'https://github.com/acme/moved.git'],
        { env: isolatedGitEnv() },
      );
      const refused: unknown = await git
        .pinnedPushUrl(repo.path)
        .catch((caught: unknown) => caught);
      expect(refused).toBeInstanceOf(GitTrustError);
      const { detail } = refused as GitTrustError;
      if (detail.kind !== 'origin') throw new Error('expected a changed origin');
      await git.retrust(repo.path, detail.candidate);
      expect(await git.pinnedPushUrl(repo.path)).toBe('https://github.com/acme/moved.git');
    });
    expect(trusted).toHaveLength(1);
  });

  it("reads origin's URL once for the calls in it that ask for it, and again when the config changed meanwhile", async () => {
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

    const changed = await git.operation(async () => {
      const before = await git.remoteUrl(repo.path, 'origin');
      execFileSync(
        'git',
        ['-C', repo.path, 'remote', 'set-url', 'origin', 'https://github.com/evil/widgets.git'],
        { env: isolatedGitEnv() },
      );
      return [before, await git.remoteUrl(repo.path, 'origin')];
    });
    expect(changed).toEqual([
      'https://github.com/acme/widgets.git',
      'https://github.com/evil/widgets.git',
    ]);
  });
});
