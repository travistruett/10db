import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkPlace, type ChatId } from '@10db/contracts';
import { getChat, setChatWork } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import {
  createTempRepo,
  isolatedGitEnv,
  tempDir,
  waitFor,
  type TempDir,
} from '../../test/fixtures';
import { createChatMove } from '../daemon';
import { chatWorktreeLockReason, type DeliveryContext } from '../delivery';
import { createGit, type Git } from '../git';
import { silentLogger } from '../log';

// A restart in the middle of a move finishes it: each state a crash leaves is built directly, then a new daemon
// (a new engine, hold and service over the same store, git and folders) runs `holdMoving` and `finishMoves`.
// Rows 25-27 and 38 of the state and event table.

let before: ChatWorld;
let after: ChatWorld | null = null;
let checkout: TempDir;
let root: TempDir;
let git: Git;
let installs: number;
afterEach(async () => {
  if (after !== null) await after.close();
  await before.engine.close();
  checkout.cleanup();
  root.cleanup();
  after = null;
});

const gitIn = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();

const dependencies: DeliveryContext['dependencies'] = {
  refresh: () => {
    installs += 1;
    return Promise.resolve({ kind: 'skipped' });
  },
};

function options(over?: ChatWorld) {
  const worktreeRoot = join(realpathSync(root.path), 'level');
  return {
    checkout: checkout.path,
    project: { repoPath: checkout.path },
    move: ({ state }: { state: ChatWorld['state'] }) =>
      createChatMove({
        state,
        signal: new AbortController().signal,
        delivery: { state, git, logger: silentLogger, dependencies, worktreeRoot },
      }),
    ...(over === undefined ? {} : { over }),
  };
}

function crashed(): { chat: ChatId; path: string; head: string } {
  installs = 0;
  checkout = createTempRepo();
  root = tempDir('recovery-root');
  git = createGit({ worktreeRoot: join(realpathSync(root.path), 'level') });
  before = chatWorld(options());
  const chat = before.open();
  const path = join(realpathSync(root.path), 'level', 'alpha', 'chat-fix');
  before.state.write((ctx) => {
    setChatWork(ctx, chat.id, null, {
      place: WorkPlace.Moving,
      branch: 'fix',
      worktreePath: path,
    });
  });
  return { chat: chat.id, path, head: gitIn(checkout.path, 'rev-parse', 'HEAD') };
}

/** A daemon restart: the old engine is gone with its process, and the new one recovers, then finishes moves. */
async function restart(): Promise<ChatWorld> {
  await before.engine.close();
  const next = chatWorld(options(before));
  after = next;
  next.work.holdMoving();
  await next.engine.recover();
  await next.work.finishMoves();
  return next;
}

describe('a restart in the middle of a move', () => {
  it('cuts the worktree of a moving row that has none, and records the branch (row 25)', async () => {
    const { chat, path, head } = crashed();
    const next = await restart();
    expect(getChat(next.state.db, chat)).toMatchObject({
      workPlace: 'branch',
      baseHead: head,
      worktreePath: path,
    });
    expect(gitIn(path, 'branch', '--show-current')).toBe('fix');
    expect(installs).toBe(1);
  });

  it('finishes a locked, unseeded worktree the crash left, without cutting again (row 26)', async () => {
    const { chat, path, head } = crashed();
    const row = getChat(before.state.db, chat);
    await git.addWorktree({
      repo: checkout.path,
      path,
      branch: 'fix',
      startPoint: head,
      lockReason: chatWorktreeLockReason(row),
    });
    const next = await restart();
    expect(getChat(next.state.db, chat)).toMatchObject({ workPlace: 'branch', baseHead: head });
    expect(gitIn(checkout.path, 'worktree', 'list', '--porcelain').split('\n')).toContain(
      `worktree ${realpathSync(path)}`,
    );
    expect(installs).toBe(1);
  });

  it('runs the install again for a worktree whose seed finished and whose install did not (row 26)', async () => {
    const { chat, path } = crashed();
    writeFileSync(join(checkout.path, '.gitignore'), 'node_modules/\n');
    gitIn(checkout.path, 'add', '.gitignore');
    gitIn(checkout.path, 'commit', '-q', '-m', 'Ignore');
    mkdirSync(join(checkout.path, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(checkout.path, 'node_modules', 'pkg', 'index.js'), 'x\n');
    const base = gitIn(checkout.path, 'rev-parse', 'HEAD');
    const row = getChat(before.state.db, chat);
    await git.addWorktree({
      repo: checkout.path,
      path,
      branch: 'fix',
      startPoint: base,
      lockReason: chatWorktreeLockReason(row),
    });
    // The seed had finished: its directory is in the worktree, and the install had not run.
    mkdirSync(join(path, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(path, 'node_modules', 'pkg', 'index.js'), 'x\n');
    const next = await restart();
    expect(getChat(next.state.db, chat).workPlace).toBe('branch');
    expect(installs).toBe(1);
  });

  it('leaves a session whose branch was recorded alone, and it works in the worktree (row 27)', async () => {
    const { chat, path, head } = crashed();
    const row = getChat(before.state.db, chat);
    await git.addWorktree({
      repo: checkout.path,
      path,
      branch: 'fix',
      startPoint: head,
      lockReason: chatWorktreeLockReason(row),
    });
    before.state.write((ctx) => {
      setChatWork(ctx, chat, WorkPlace.Moving, { place: WorkPlace.Branch, baseHead: head });
    });
    const next = await restart();
    expect(installs).toBe(0);
    const conv = getChat(next.state.db, chat).conversationId;
    next.chat.send(conv, { text: 'carry on', mentions: [], pictures: [] });
    await waitFor(() => next.adapter.shapeSessions.length === 1);
    expect(next.adapter.shapeSessions[0]?.spec.cwd).toBe(path);
  });

  it('returns to choosing when the path holds a foreign directory (row 24)', async () => {
    const { chat, path } = crashed();
    mkdirSync(path, { recursive: true });
    const next = await restart();
    expect(getChat(next.state.db, chat)).toMatchObject({
      workPlace: 'choosing',
      branch: null,
      worktreePath: null,
    });
    expect(next.work.moveFailure(chat)).toMatch(/already exists/);
    expect(existsSync(path)).toBe(true);
    expect(gitIn(checkout.path, 'branch', '--list', 'fix')).toBe('');
  });

  it('remakes the worktree of a reopen from its branch, with no notice, carry-on or new base (row 38)', async () => {
    const { chat, path, head } = crashed();
    gitIn(checkout.path, 'branch', 'fix', head);
    before.state.write((ctx) => {
      setChatWork(ctx, chat, WorkPlace.Moving, {
        place: WorkPlace.Moving,
        baseHead: head,
      });
    });
    const next = await restart();
    expect(getChat(next.state.db, chat)).toMatchObject({
      workPlace: 'branch',
      baseHead: head,
      worktreePath: path,
    });
    expect(gitIn(path, 'branch', '--show-current')).toBe('fix');
    expect(next.adapter.shapeSessions).toHaveLength(0);
  });
});
