import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ChatWorkStateDto, WorkPlace, type ChatDto } from '@10db/contracts';
import { setChatWork } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { chatRequest } from '../../test/chat-app';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { FakeGh } from '../../test/fake-gh';
import {
  createTempRepo,
  isolatedGitEnv,
  tempDir,
  waitFor,
  type TempDir,
} from '../../test/fixtures';
import { gate } from '../../test/explore-world';
import { createGit } from '../git';
import { secretFilesIn } from '../sandbox';
import { createChatWorkStateReader } from './work-state';
import { createTitleRowGit, type TitleRowGit } from './title-row-git';

// The title row's git steps on a real repository, a real store and FakeGh: what each step does, who it waits for,
// and that a second click is the first's result.

let w: ChatWorld;
let repo: TempDir;
let extra: TempDir | null = null;
let gh: FakeGh;
let titleRow: TitleRowGit;
/** Held by a test that needs a step to stay inside its work while something else is tried. */
let inStep: Promise<void> = Promise.resolve();

afterEach(async () => {
  await w.close();
  repo.cleanup();
  extra?.cleanup();
  extra = null;
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

describe('who has the checkout', () => {
  const say = { mentions: [], pictures: [] };
  const request = { message: 'Add a', paths: ['a.ts'] };
  const unsettled = (p: Promise<unknown>) => {
    let settled = false;
    void p.then(
      () => (settled = true),
      () => (settled = true),
    );
    return () => settled;
  };

  it('refuses at once while another session’s terminal has the checkout, with its words (row 41)', async () => {
    const chat = setup();
    write(repo.path, 'a.ts', 'a\n');
    const other = w.open(1);
    const token = w.folderHold.reserveGit(w.project.id, 'warming up');
    w.chat.send(other.conversationId, { text: 'Hello', ...say });
    await w.engine.settled(other.conversationId);
    if (token.reserved) w.folderHold.releaseGit(token.token);
    await w.takeover.open(other.conversationId);
    await expect(titleRow.commit(chat.id, request, signal)).rejects.toThrow(
      /is in your terminal, on `main`\./,
    );
    expect(commitCount()).toBe(1);
  });

  it('waits for another session’s turn to end, and stops waiting when the request aborts (row 42)', async () => {
    const chat = setup();
    write(repo.path, 'a.ts', 'a\n');
    const other = w.open(1);
    w.here(other.id);
    expect(w.folderHold.takeTurn(w.project.id, other.id).taken).toBe(true);
    const aborting = new AbortController();
    const abandoned = titleRow.commit(chat.id, request, aborting.signal);
    const abandonedRejected = expect(abandoned).rejects.toThrow();
    aborting.abort();
    await abandonedRejected;
    expect(commitCount()).toBe(1);
    const waiting = titleRow.commit(chat.id, request, signal);
    const done = unsettled(waiting);
    // The turn still has the checkout, so the step has not run.
    await w.engine.settled(other.conversationId);
    expect(done()).toBe(false);
    expect(commitCount()).toBe(1);
    w.folderHold.releaseTurn(other.id);
    await waiting;
    expect(commitCount()).toBe(2);
    expect(w.folderHold.reserveGit(w.project.id, 'free again').reserved).toBe(true);
  });

  it('waits for the session’s own turn to end (row 43)', async () => {
    const chat = setup();
    write(repo.path, 'a.ts', 'a\n');
    expect(w.folderHold.takeTurn(w.project.id, chat.id).taken).toBe(true);
    const waiting = titleRow.commit(chat.id, request, signal);
    const done = unsettled(waiting);
    await w.engine.settled(chat.conversationId);
    expect(done()).toBe(false);
    w.folderHold.releaseTurn(chat.id);
    await waiting;
    expect(commitCount()).toBe(2);
  });

  it('keeps a session’s turn from holding the checkout while a step runs, and names the step (row 44)', async () => {
    const chat = setup();
    write(repo.path, 'a.ts', 'a\n');
    const held = gate();
    inStep = held.promise;
    const running = titleRow.commit(chat.id, request, signal);
    await waitFor(() => w.folderHold.holders(w.project.id).length > 0);
    expect(w.folderHold.takeTurn(w.project.id, chat.id).taken).toBe(false);
    expect(w.folderHold.holders(w.project.id).map((h) => h.what)).toEqual([
      'committing for the session ‘New session’',
    ]);
    held.release();
    await running;
  });
});

describe('a session on its own branch', () => {
  function onBranch(
    chatId: Parameters<typeof setChatWork>[1],
    place: WorkPlace = WorkPlace.Branch,
  ) {
    extra = tempDir('title-row-wt');
    const path = join(realpathSync(extra.path), 'wt');
    gitIn(repo.path, 'worktree', 'add', '-q', '-b', 'fix', path, 'HEAD');
    w.state.write((ctx) =>
      setChatWork(ctx, chatId, 'here', {
        place,
        branch: 'fix',
        worktreePath: path,
        baseHead: headSha(),
      }),
    );
    return path;
  }

  it('commits in its worktree while its turn runs, and holds nothing of the checkout (row 32)', async () => {
    const chat = setup();
    const path = onBranch(chat.id);
    write(path, 'a.ts', 'a\n');
    const running = gate();
    w.adapter.shapeBehaviour = async () => {
      await running.promise;
      return { text: 'Done.' };
    };
    w.chat.send(chat.conversationId, { text: 'go', mentions: [], pictures: [] });
    await waitFor(() => w.engine.view(chat.conversationId).state === 'running');
    // The checkout is busy with someone else's step; a branch session's step does not wait for it.
    expect(w.folderHold.reserveGit(w.project.id, 'someone else').reserved).toBe(true);
    const state = await titleRow.commit(chat.id, { message: 'Add a', paths: ['a.ts'] }, signal);
    expect(gitIn(path, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.ts');
    expect(ChatWorkStateDto.parse(state)).toMatchObject({ place: 'branch', dirtyFiles: 0 });
    running.release();
    await w.engine.settled(chat.conversationId);
  });

  it('is refused while it moves, and for a session that has changed nothing (row 21)', async () => {
    const chat = setup();
    onBranch(chat.id, WorkPlace.Moving);
    await expect(
      titleRow.commit(chat.id, { message: 'x', paths: ['a.ts'] }, signal),
    ).rejects.toThrow('Wait for the move to finish.');
    const reading = w.open(1);
    await expect(
      titleRow.commit(reading.id, { message: 'x', paths: ['a.ts'] }, signal),
    ).rejects.toThrow('has not changed any files');
  });
});
