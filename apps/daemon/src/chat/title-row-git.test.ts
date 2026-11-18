import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ChatWorkStateDto, type ChatDto } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { chatRequest } from '../../test/chat-app';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { FakeGh } from '../../test/fake-gh';
import { createTempRepo, isolatedGitEnv, type TempDir } from '../../test/fixtures';
import { gate } from '../../test/explore-world';
import { createGit } from '../git';
import { secretFilesIn } from '../sandbox';
import { createChatWorkStateReader } from './work-state';
import { createTitleRowGit, type TitleRowGit } from './title-row-git';

// The title row's git steps on a real repository, a real store and FakeGh: what each step does, who it waits for,
// and that a second click is the first's result.

let w: ChatWorld;
let repo: TempDir;
let gh: FakeGh;
let titleRow: TitleRowGit;
/** Held by a test that needs a step to stay inside its work while something else is tried. */
let inStep: Promise<void> = Promise.resolve();

afterEach(async () => {
  await w.close();
  repo.cleanup();
  inStep = Promise.resolve();
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
  gh = new FakeGh();
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
    secretFilesOf: async (root) => {
      await inStep;
      return secretFilesIn(root);
    },
    net: () => ({ env: {}, timeoutMs: 5_000 }),
  });
  const chat = w.open();
  w.here(chat.id);
  return chat;
}

const signal = new AbortController().signal;
const headSha = (dir = repo.path): string => gitIn(dir, 'rev-parse', 'HEAD');
const commitCount = (dir = repo.path): number => Number(gitIn(dir, 'rev-list', '--count', 'HEAD'));

describe('Commit', () => {
  it('commits only the files it is given, and answers the session’s state', async () => {
    const chat = setup();
    write(repo.path, 'src/a.ts', 'a\n');
    write(repo.path, 'src/b.ts', 'b\n');
    const before = commitCount();
    const state = await titleRow.commit(chat.id, { message: 'Add a', paths: ['src/a.ts'] }, signal);
    expect(commitCount()).toBe(before + 1);
    expect(gitIn(repo.path, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/a.ts');
    expect(gitIn(repo.path, 'ls-files', '--others', '--exclude-standard')).toBe('src/b.ts');
    expect(ChatWorkStateDto.parse(state)).toMatchObject({ place: 'here', dirtyFiles: 1 });
  });

  it('refuses a secret file by name and commits nothing', async () => {
    const chat = setup();
    write(repo.path, '.env.local', 'TOKEN=1\n');
    write(repo.path, 'src/a.ts', 'a\n');
    const before = headSha();
    await expect(
      titleRow.commit(chat.id, { message: 'x', paths: ['.env.local', 'src/a.ts'] }, signal),
    ).rejects.toThrow('.env.local');
    expect(headSha()).toBe(before);
  });

  it('answers a second click on the same step with the first’s result, and commits once (row 45)', async () => {
    const chat = setup();
    write(repo.path, 'a.ts', 'a\n');
    const held = gate();
    inStep = held.promise;
    const before = commitCount();
    const first = titleRow.commit(chat.id, { message: 'Add a', paths: ['a.ts'] }, signal);
    const second = titleRow.commit(chat.id, { message: 'Add a', paths: ['a.ts'] }, signal);
    held.release();
    const [one, two] = await Promise.all([first, second]);
    expect(commitCount()).toBe(before + 1);
    expect(two).toEqual(one);
  });

  it('is served by POST /chats/:chatId/commit', async () => {
    const chat = setup();
    write(repo.path, 'a.ts', 'a\n');
    const answer = await chatRequest(
      w,
      `/chats/${chat.id}/commit`,
      'POST',
      {
        message: 'Add a',
        paths: ['a.ts'],
      },
      { titleRow },
    );
    expect(answer.status).toBe(200);
    expect(ChatWorkStateDto.parse(await answer.json())).toMatchObject({ dirtyFiles: 0 });
    const bad = await chatRequest(
      w,
      `/chats/${chat.id}/commit`,
      'POST',
      { message: '', paths: [] },
      { titleRow },
    );
    expect(bad.status).toBe(400);
  });
});
