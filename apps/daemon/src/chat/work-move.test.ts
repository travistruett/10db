import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationItemKind, parseItemBody, WorkPlace } from '@10db/contracts';
import { getChat, listInbox, listItems, setChatWork } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import { gate } from '../../test/explore-world';
import {
  createTempRepo,
  isolatedGitEnv,
  tempDir,
  waitFor,
  type TempDir,
} from '../../test/fixtures';
import { createChatMove } from '../daemon';
import { createGit } from '../git';
import { silentLogger } from '../log';
import { EMPTY_SETUP } from '../sandbox';
import type { ShapePrepareInput, ShapePrepared } from '../shape';

// A session on its own branch works in its worktree: the same conversation, resumed there. The rows are those of
// the state and event table in the sessions plan.

let w: ChatWorld;
let repo: TempDir;
afterEach(async () => {
  await w.close();
  repo.cleanup();
});

const prepares: ShapePrepareInput[] = [];
const prepared = (input: ShapePrepareInput): Promise<ShapePrepared> => {
  prepares.push(input);
  return Promise.resolve({
    sandbox: null,
    projectMcpServers: {},
    yourMcpServers: {},
    note: null,
    credentialsExpireAt: null,
    instructions: null,
    setup: EMPTY_SETUP,
    canUseTool: () => Promise.reject(new Error('no card here')),
    trackProcesses: () => undefined,
    markOwn: () => undefined,
    endJobs: () => Promise.resolve(),
    release: () => Promise.resolve(),
  });
};

function world(): { chat: ChatWorld['open'] extends () => infer C ? C : never; worktree: string } {
  prepares.length = 0;
  repo = tempDir('move-repo');
  const worktree = join(repo.path, 'wt', 'fix');
  mkdirSync(worktree, { recursive: true });
  w = chatWorld({ checkout: join(repo.path, 'checkout'), prepare: prepared });
  const chat = w.open();
  w.state.write((ctx) => {
    setChatWork(ctx, chat.id, null, {
      place: WorkPlace.Branch,
      worktreePath: worktree,
      branch: 'fix',
      baseHead: 'abc1234',
    });
  });
  return { chat, worktree };
}

describe('a session on its own branch', () => {
  it('starts in its worktree with the same conversation, holds nothing, and keeps its warm session (rows 28)', async () => {
    const { chat, worktree } = world();
    w.chat.send(chat.conversationId, { text: 'one', mentions: [], pictures: [] });
    await waitFor(() => w.adapter.shapeSessions.length === 1);
    await w.engine.settled(chat.conversationId);
    w.chat.send(chat.conversationId, { text: 'two', mentions: [], pictures: [] });
    await w.engine.settled(chat.conversationId);
    await waitFor(() => (w.adapter.shapeSessions[0]?.sent.length ?? 0) >= 1);
    expect(w.adapter.shapeSessions).toHaveLength(1);
    const spec = w.adapter.shapeSessions[0]?.spec;
    expect(spec?.cwd).toBe(worktree);
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
    expect(prepares[0]).toMatchObject({ checkout: worktree, writes: true });
  });

  it("lets a branch session read and search its own worktree, and not the builder's checkout", async () => {
    const { chat, worktree } = world();
    writeFileSync(join(worktree, 'a.ts'), 'x');
    const verdicts: string[] = [];
    w.adapter.shapeBehaviour = (turn) => {
      const asked = (toolName: string, input: Record<string, unknown>) =>
        verdicts.push(turn.spec.preToolUse({ toolName, input }).decision);
      asked('Read', { file_path: join(worktree, 'a.ts') });
      asked('Grep', { pattern: 'x', path: worktree });
      asked('Read', { file_path: join(repo.path, 'checkout', 'a.ts') });
      return Promise.resolve({ text: 'Done.' });
    };
    w.chat.send(chat.conversationId, { text: 'one', mentions: [], pictures: [] });
    await waitFor(() => verdicts.length === 3);
    expect(verdicts).toEqual(['allow', 'allow', 'deny']);
  });

  it('opens each session with where it works, and says once that it moved (call 11)', async () => {
    const { chat, worktree } = world();
    w.firstStartAfterMove.add(chat.id);
    w.chat.send(chat.conversationId, { text: 'one', mentions: [], pictures: [] });
    await waitFor(() => w.adapter.shapeSessions.length === 1);
    await w.engine.settled(chat.conversationId);
    const first = w.adapter.shapeSessions[0]?.spec.prompt ?? '';
    expect(first).toContain(`You work in ${worktree} on the branch fix`);
    expect(first).toContain('Redo it here');
    // A later start (a restart, a new session) keeps the standing note and drops the one-off line.
    await w.engine.close();
    expect(w.firstStartAfterMove.has(chat.id)).toBe(false);
  });
});

// The move itself, on a real repository: the worktree is cut by git, the row and the engine follow.

let checkout: TempDir;
let root: TempDir;
const gitIn = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();

/** The real move over a real checkout; `cutGate` holds the cut until the test lets it, as a slow install would. */
function moveWorld(cutGate?: Promise<void>): void {
  prepares.length = 0;
  checkout = createTempRepo();
  root = tempDir('move-root');
  w = chatWorld({
    checkout: checkout.path,
    project: { repoPath: checkout.path },
    prepare: prepared,
    move: ({ state }) => {
      const real = createChatMove({
        state,
        signal: new AbortController().signal,
        delivery: {
          state,
          git: createGit({ worktreeRoot: join(realpathSync(root.path), 'level') }),
          logger: silentLogger,
          dependencies: { refresh: () => Promise.resolve({ kind: 'skipped' }) },
          worktreeRoot: join(realpathSync(root.path), 'level'),
        },
      });
      return {
        ...real,
        cut: async (chat, project, signal) => {
          await cutGate;
          return await real.cut(chat, project, signal);
        },
      };
    },
  });
}

/** A session that read, asked its first change and is choosing; its turn was stopped by that. */
async function choosingAfterARead() {
  const chat = w.open();
  w.adapter.shapeBehaviour = async (turn) => {
    turn.spec.preToolUse({
      toolName: 'Write',
      input: { file_path: join(checkout.path, 'a.ts'), content: 'x' },
    });
    await new Promise<void>((resolve) => {
      turn.signal.addEventListener('abort', () => {
        resolve();
      });
    });
    return { text: 'Stopped.' };
  };
  w.chat.send(chat.conversationId, { text: 'fix login', mentions: [], pictures: [] });
  await waitFor(() => getChat(w.state.db, chat.id).workPlace === 'choosing');
  await w.engine.settled(chat.conversationId);
  w.adapter.shapeBehaviour = () => Promise.resolve({ text: 'Done.' });
  return chat;
}

const noticesOf = (conversationId: Parameters<typeof listItems>[1]) =>
  listItems(w.state.db, conversationId, {})
    .filter((i) => i.kind === ConversationItemKind.Notice)
    .map((i) => JSON.stringify(parseItemBody(i.kind, i.body)));
const carryOns = (conversationId: Parameters<typeof listItems>[1]) =>
  listItems(w.state.db, conversationId, {}).filter(
    (i) =>
      i.kind === ConversationItemKind.Message &&
      parseItemBody(i.kind, i.body).purpose === 'carry_on',
  );
const openCards = () =>
  listInbox(w.state.db, { states: ['OPEN'] }).filter((c) => c.detail?.['chatWork'] !== undefined);

describe('moving a session to a new branch', () => {
  it('cuts the worktree, resumes the same conversation in it, and carries on (row 11)', async () => {
    moveWorld();
    const chat = await choosingAfterARead();
    const head = gitIn(checkout.path, 'rev-parse', 'HEAD');
    const first = w.adapter.shapeSessions[0]?.spec.resumeProviderSessionId;
    const chosen = await w.work.choose(chat.id, 'branch');
    expect(chosen.place).toBe('moving');
    expect(openCards()).toEqual([]);
    await w.work.moveSettled(chat.id);
    await waitFor(() => w.adapter.shapeSessions.length === 2);
    await w.engine.settled(chat.conversationId);
    const row = getChat(w.state.db, chat.id);
    expect(row).toMatchObject({ workPlace: 'branch', baseHead: head, branch: 'fix-login' });
    const worktree = row.worktreePath ?? '';
    expect(existsSync(worktree)).toBe(true);
    expect(gitIn(worktree, 'branch', '--show-current')).toBe('fix-login');
    expect(gitIn(checkout.path, 'branch', '--show-current')).toBe('main');
    const second = w.adapter.shapeSessions[1]?.spec;
    expect(second?.cwd).toBe(worktree);
    expect(second?.resumeProviderSessionId).not.toBeNull();
    expect(second?.resumeProviderSessionId).toBe(
      first === null ? second?.resumeProviderSessionId : first,
    );
    expect(second?.prompt).toContain(`You work in ${worktree} on the branch fix-login`);
    expect(second?.prompt).toContain('Redo it here');
    expect(noticesOf(chat.conversationId).join()).toContain(
      'Moved to a new branch, fix-login, from main.',
    );
    expect(carryOns(chat.conversationId)).toHaveLength(1);
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
  });

  it('parks a message sent mid-move, and Stop answers at once while Redo is refused (rows 19, 20)', async () => {
    const cut = gate();
    moveWorld(cut.promise);
    const chat = await choosingAfterARead();
    await w.work.choose(chat.id, 'branch');
    expect(getChat(w.state.db, chat.id).workPlace).toBe('moving');
    w.chat.send(chat.conversationId, { text: 'meanwhile', mentions: [], pictures: [] });
    expect(w.adapter.shapeSessions).toHaveLength(1);
    // Stop gives no starts back, and Redo waits for the move.
    await w.chat.stop(chat.conversationId);
    expect(w.adapter.shapeSessions).toHaveLength(1);
    await expect(
      w.chat.redo(chat.conversationId, { text: 'again', mentions: [], pictures: [] }, 'wait'),
    ).rejects.toThrow(/Wait for the move to finish/);
    cut.release();
    await w.work.moveSettled(chat.id);
    await waitFor(() => w.adapter.shapeSessions.length === 2);
    await w.engine.settled(chat.conversationId);
    expect(w.adapter.shapeSessions[1]?.spec.cwd).toBe(getChat(w.state.db, chat.id).worktreePath);
  });

  it('stops a reading turn that runs at the choice, and closes the warm session after the cut (row 22)', async () => {
    const cut = gate();
    moveWorld(cut.promise);
    const chat = await choosingAfterARead();
    let interrupted = false;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    w.adapter.shapeBehaviour = async (turn) => {
      started();
      await new Promise<void>((resolve) => {
        turn.signal.addEventListener('abort', () => {
          interrupted = true;
          resolve();
        });
      });
      return { text: 'Stopped.' };
    };
    w.chat.send(chat.conversationId, { text: 'and the tests?', mentions: [], pictures: [] });
    await running;
    await w.work.choose(chat.id, 'branch');
    await waitFor(() => interrupted);
    cut.release();
    await w.work.moveSettled(chat.id);
    expect(getChat(w.state.db, chat.id).workPlace).toBe('branch');
    expect(w.engine.view(chat.conversationId).state).not.toBe('running');
  });

  it('goes back to choosing when the worktree cannot be made, with the error and the card again (row 24)', async () => {
    moveWorld();
    writeFileSync(
      join(checkout.path, '.gitattributes'),
      '*.bin filter=lfs diff=lfs merge=lfs -text\n',
    );
    gitIn(checkout.path, 'add', '.gitattributes');
    gitIn(checkout.path, 'commit', '-q', '-m', 'Use LFS');
    const chat = await choosingAfterARead();
    await w.work.choose(chat.id, 'branch');
    w.chat.send(chat.conversationId, { text: 'still reading', mentions: [], pictures: [] });
    await w.work.moveSettled(chat.id);
    const row = getChat(w.state.db, chat.id);
    expect(row).toMatchObject({ workPlace: 'choosing', branch: null, worktreePath: null });
    expect(w.work.moveFailure(chat.id)).toMatch(/filter/);
    expect(openCards()).toHaveLength(1);
    expect(gitIn(checkout.path, 'branch', '--list', 'fix-login')).toBe('');
    // The parked message then runs in the session as it was: reading, in the checkout.
    await waitFor(() => (w.adapter.shapeSessions[0]?.sent.length ?? 0) >= 1);
    await w.engine.settled(chat.conversationId);
    expect(w.adapter.shapeSessions).toHaveLength(1);
    expect(w.adapter.shapeSessions[0]?.spec.cwd).toBe(checkout.path);
    expect(w.folderHold.holdsTurn(chat.id)).toBe(false);
  });
});
