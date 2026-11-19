import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatDto } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { FakeGh } from '../../test/fake-gh';
import { createTempRepo, isolatedGitEnv, type TempDir } from '../../test/fixtures';
import { createGit } from '../git';
import { secretFilesIn } from '../sandbox';
import { createChatWorkStateReader } from './work-state';
import { createTitleRowGit, type TitleRowGit } from './title-row-git';

// The title row's Commit on a real repository, a real store and FakeGh.

let w: ChatWorld;
let repo: TempDir;
let titleRow: TitleRowGit;

afterEach(async () => {
  await w.close();
  repo.cleanup();
});

const gitIn = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();

function write(dir: string, rel: string, text: string): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A project on GitHub, its checkout on `main`, and a session working Here. */
function setup(): ChatDto {
  repo = createTempRepo();
  gitIn(repo.path, 'config', 'remote.origin.url', 'https://github.com/acme/widgets.git');
  const gh = new FakeGh();
  const git = createGit({ worktreeRoot: join(realpathSync(repo.path), '..', 'unused') });
  w = chatWorld({
    checkout: repo.path,
    project: { repoPath: repo.path, delivery: 'pull_request' },
    facts: ({ state, folderHold, clock }) =>
      createChatWorkStateReader({
        state,
        git,
        gh,
        net: () => ({ env: {}, timeoutMs: 5_000 }),
        folderHold,
        clock,
      }),
  });
  titleRow = createTitleRowGit({
    state: w.state,
    folderHold: w.folderHold,
    work: w.work,
    git,
    gh,
    filesDir: () => join(repo.path, '..', 'pr-bodies'),
    secretFilesOf: (root) => secretFilesIn(root),
    net: () => ({ env: {}, timeoutMs: 5_000 }),
  });
  const chat = w.open();
  w.here(chat.id);
  return chat;
}

describe('Commit', () => {
  it('refuses a secret file by name and commits nothing', async () => {
    const chat = setup();
    write(repo.path, '.env.local', 'TOKEN=1\n');
    write(repo.path, 'src/a.ts', 'a\n');
    const before = gitIn(repo.path, 'rev-parse', 'HEAD');
    await expect(
      titleRow.commit(
        chat.id,
        { message: 'x', paths: ['.env.local', 'src/a.ts'] },
        new AbortController().signal,
      ),
    ).rejects.toThrow('.env.local');
    expect(gitIn(repo.path, 'rev-parse', 'HEAD')).toBe(before);
  });
});
