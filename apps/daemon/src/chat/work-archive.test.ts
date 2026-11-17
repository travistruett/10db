import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArchivePreviewDto } from '@10db/contracts';
import {
  getAppSetting,
  getChat,
  listItems,
  moveChatTab,
  setChatWork,
  unarchiveChat,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { chatRequest } from '../../test/chat-app';
import { chatWorld, type ChatWorld } from '../../test/chat-world';
import {
  createTempRepo,
  isolatedGitEnv,
  tempDir,
  waitFor,
  type TempDir,
} from '../../test/fixtures';
import { createChatMove, createChatWorktrees } from '../daemon';
import { createGit, chatWorktreePinKey } from '../git';
import { silentLogger } from '../log';

// Archive on a session with its own branch: the preview lists what removing the worktree would lose, and the
// request carries what the builder was warned about. Real git and a real store (row 33).

let w: ChatWorld;
let checkout: TempDir;
let root: TempDir;
afterEach(async () => {
  await w.close();
  checkout.cleanup();
  root.cleanup();
});

const gitIn = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();

/** A session that has moved to its branch: the worktree is cut and the row is `branch`. */
async function onABranch() {
  checkout = createTempRepo();
  root = tempDir('archive-root');
  const worktreeRoot = join(realpathSync(root.path), 'level');
  const git = createGit({ worktreeRoot });
  w = chatWorld({
    checkout: checkout.path,
    project: { repoPath: checkout.path },
    move: ({ state }) =>
      createChatMove({
        state,
        signal: new AbortController().signal,
        delivery: {
          state,
          git,
          logger: silentLogger,
          dependencies: { refresh: () => Promise.resolve({ kind: 'skipped' }) },
          worktreeRoot,
        },
      }),
    worktrees: ({ state }) => createChatWorktrees({ state, git }),
  });
  const chat = w.open();
  w.state.write((ctx) => {
    setChatWork(ctx, chat.id, null, { place: 'choosing' });
  });
  await w.work.choose(chat.id, 'branch');
  await w.work.moveSettled(chat.id);
  const row = getChat(w.state.db, chat.id);
  expect(row.workPlace).toBe('branch');
  return { chat, path: row.worktreePath ?? '', branch: row.branch ?? '' };
}

const preview = async (chatId: string) =>
  ArchivePreviewDto.parse(
    await (await chatRequest(w, `/chats/${chatId}/archive-preview`, 'GET')).json(),
  );

describe('archiving a session on its own branch', () => {
  it('previews what it would lose, removes the worktree and its pin, and keeps the branch (row 33)', async () => {
    const { chat, path, branch } = await onABranch();
    writeFileSync(join(path, 'draft.txt'), 'x\n');
    const shown = await preview(chat.id);
    expect(shown).toMatchObject({
      worktree: path,
      branch,
      uncommitted: ['draft.txt'],
      ignored: [],
    });
    const done = await chatRequest(w, `/chats/${chat.id}/archive`, 'POST', {
      uncommitted: shown.uncommitted,
      ignored: shown.ignored,
    });
    expect(done.status).toBe(200);
    expect(existsSync(path)).toBe(false);
    expect(getChat(w.state.db, chat.id)).toMatchObject({ worktreePath: null, branch });
    expect(getChat(w.state.db, chat.id).archivedAt).not.toBeNull();
    expect(getAppSetting(w.state.db, chatWorktreePinKey(chat.id))).toBeUndefined();
    expect(gitIn(checkout.path, 'branch', '--list', branch)).toContain(branch);
  });

  it('refuses with the fresh list when files were written after the preview, and changes nothing', async () => {
    const { chat, path } = await onABranch();
    const shown = await preview(chat.id);
    writeFileSync(join(path, 'late.txt'), 'x\n');
    const refused = await chatRequest(w, `/chats/${chat.id}/archive`, 'POST', {
      uncommitted: shown.uncommitted,
      ignored: shown.ignored,
    });
    expect(refused.status).toBe(409);
    expect(ArchivePreviewDto.parse(await refused.json()).uncommitted).toEqual(['late.txt']);
    expect(existsSync(path)).toBe(true);
    expect(getChat(w.state.db, chat.id).archivedAt).toBeNull();
    // A request that names it archives.
    const again = await chatRequest(w, `/chats/${chat.id}/archive`, 'POST', {
      uncommitted: ['late.txt'],
    });
    expect(again.status).toBe(200);
    expect(existsSync(path)).toBe(false);
  });

  it('archives a session with no worktree as before, with no body', async () => {
    await onABranch();
    const plain = w.open(1);
    const done = await chatRequest(w, `/chats/${plain.id}/archive`, 'POST');
    expect(done.status).toBe(200);
    await waitFor(() => getChat(w.state.db, plain.id).archivedAt !== null);
  });
});

describe('reopening a branch session whose worktree was removed', () => {
  /** Archives a session that moved, with nothing at risk. */
  async function archived() {
    const made = await onABranch();
    const done = await chatRequest(w, `/chats/${made.chat.id}/archive`, 'POST');
    expect(done.status).toBe(200);
    return made;
  }
  const counts = (conversationId: Parameters<typeof listItems>[1]) =>
    listItems(w.state.db, conversationId, {}).length;

  it('remakes the worktree from the branch on unarchive, with no turn, notice or carry-on, keeping base_head (row 36)', async () => {
    const { chat, branch } = await archived();
    const before = getChat(w.state.db, chat.id);
    const items = counts(chat.conversationId);
    const sessions = w.adapter.shapeSessions.length;
    await chatRequest(w, `/chats/${chat.id}/unarchive`, 'POST');
    await waitFor(
      () =>
        getChat(w.state.db, chat.id).worktreePath !== null &&
        getChat(w.state.db, chat.id).workPlace === 'branch',
    );
    await w.work.moveSettled(chat.id);
    const row = getChat(w.state.db, chat.id);
    expect(row).toMatchObject({ workPlace: 'branch', baseHead: before.baseHead, branch });
    expect(gitIn(row.worktreePath ?? '', 'branch', '--show-current')).toBe(branch);
    expect(counts(chat.conversationId)).toBe(items);
    expect(w.adapter.shapeSessions).toHaveLength(sessions);
  });

  it('remakes it when the chat is reopened from Recently closed (row 36)', async () => {
    const { chat } = await onABranch();
    await chatRequest(w, `/chats/${chat.id}/archive`, 'POST');
    // Closed, not archived, with its worktree gone (as a sweep leaves it): placed in a tab again.
    w.state.write((ctx) => {
      unarchiveChat(ctx, chat.id);
      moveChatTab(ctx, chat.id, null);
    });
    await w.chat.patch(chat.id, { tabPosition: 0 });
    await waitFor(() => getChat(w.state.db, chat.id).worktreePath !== null);
    await w.work.moveSettled(chat.id);
    expect(existsSync(getChat(w.state.db, chat.id).worktreePath ?? '')).toBe(true);
  });

  it('stays with no worktree, reading only, when the branch is gone, and says why (row 37)', async () => {
    const { chat, branch } = await archived();
    gitIn(checkout.path, 'branch', '-D', branch);
    await chatRequest(w, `/chats/${chat.id}/unarchive`, 'POST');
    await waitFor(() => w.work.moveFailure(chat.id) !== null);
    await w.work.moveSettled(chat.id);
    expect(getChat(w.state.db, chat.id)).toMatchObject({ workPlace: 'branch', worktreePath: null });
    const notices = listItems(w.state.db, chat.conversationId, {}).map((i) =>
      JSON.stringify(i.body),
    );
    expect(notices.join()).toContain('could not be made again');
  });
});
