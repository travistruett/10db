import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  mintId,
  WorkPlace,
} from '@10db/contracts';
import { getChat, insertChat, insertConversation, setChatWork, type ChatRow } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { isolatedGitEnv } from '../../test/fixtures';
import { chatWorktreeLockReason, ChatWorktreeError, cutChatWorktree } from './chat-worktree-cut';

// A session's worktree is cut at the checkout's HEAD, seeded and installed, or fully undone. Real git, a real
// store, a fake pnpm.

let h: DeliveryHarness;
beforeEach(() => {
  h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
});
afterEach(() => {
  h.close();
});

const gitIn = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();
const branchExists = (branch: string): boolean => gitIn(h.repo, 'branch', '--list', branch) !== '';

/** A chat that has recorded where its move goes: the branch and the path, no base yet. */
function moving(name: string, baseHead: string | null = null): ChatRow {
  const id = mintId('Chat');
  const conversationId = h.state.write(
    (ctx) =>
      insertConversation(ctx, {
        projectId: h.project.id,
        owner: { kind: ConversationOwnerKind.Chat, id },
        profile: ConversationProfile.Explore,
        state: ConversationState.IdleCold,
      }).id,
  );
  h.state.write((ctx) => {
    insertChat(ctx, { id, projectId: h.project.id, conversationId, title: name, tabPosition: 0 });
    setChatWork(ctx, id, null, {
      place: WorkPlace.Moving,
      worktreePath: join(h.worktreeRoot, name),
      branch: name,
      baseHead,
    });
  });
  return getChat(h.state.db, id);
}

const cut = (chat: ChatRow) =>
  cutChatWorktree(h.ctx, chat, h.project, new AbortController().signal);

describe('cutting a session’s worktree', () => {
  it('cuts at HEAD, leaves uncommitted files in the checkout, and locks the worktree for the chat', async () => {
    const head = gitIn(h.repo, 'rev-parse', 'HEAD');
    writeFileSync(join(h.repo, 'draft.txt'), 'uncommitted\n');
    const chat = moving('first');
    const made = await cut(chat);
    expect(made).toEqual({ baseHead: head });
    expect(gitIn(chat.worktreePath ?? '', 'rev-parse', 'HEAD')).toBe(head);
    expect(gitIn(chat.worktreePath ?? '', 'branch', '--show-current')).toBe('first');
    expect(existsSync(join(chat.worktreePath ?? '', 'draft.txt'))).toBe(false);
    expect(readFileSync(join(h.repo, 'draft.txt'), 'utf8')).toBe('uncommitted\n');
    expect(gitIn(h.repo, 'worktree', 'list', '--porcelain')).toContain(
      `locked ${chatWorktreeLockReason(chat)}`,
    );
  });

  it('refuses a repository that uses filters, and makes nothing', async () => {
    h.commit('.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    const chat = moving('lfs');
    await expect(cut(chat)).rejects.toThrow(ChatWorktreeError);
    await expect(cut(chat)).rejects.toThrow(/filter/);
    expect(existsSync(chat.worktreePath ?? '')).toBe(false);
    expect(branchExists('lfs')).toBe(false);
  });

  it('undoes the worktree and the branch when the seed fails', async () => {
    h.commit('.gitignore', 'node_modules/\n');
    mkdirSync(join(h.repo, 'node_modules', 'locked'), { recursive: true });
    chmodSync(join(h.repo, 'node_modules', 'locked'), 0o000);
    const chat = moving('seedless');
    try {
      await expect(cut(chat)).rejects.toThrow(/Copying/);
    } finally {
      chmodSync(join(h.repo, 'node_modules', 'locked'), 0o700);
    }
    expect(existsSync(chat.worktreePath ?? '')).toBe(false);
    expect(branchExists('seedless')).toBe(false);
    expect(gitIn(h.repo, 'worktree', 'list')).not.toContain('seedless');
  });

  it('undoes the worktree and the branch when the install fails', async () => {
    h.commit('.gitignore', 'node_modules/\n');
    h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(h.repo, 'node_modules', 'pkg', 'index.js'), 'x\n');
    h.pnpm.failWith(1, 'boom');
    const chat = moving('installless');
    await expect(cut(chat)).rejects.toThrow(/Installing the packages failed/);
    expect(existsSync(chat.worktreePath ?? '')).toBe(false);
    expect(branchExists('installless')).toBe(false);
  });

  it('is idempotent by path: a second call finds the worktree and runs the seed and install again', async () => {
    h.commit('.gitignore', 'node_modules/\n');
    h.commit('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    mkdirSync(join(h.repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(h.repo, 'node_modules', 'pkg', 'index.js'), 'x\n');
    const chat = moving('twice');
    const first = await cut(chat);
    const installs = h.pnpm.calls().length;
    const second = await cut(chat);
    expect(second).toEqual(first);
    expect(h.pnpm.calls().length).toBe(installs + 1);
    expect(gitIn(h.repo, 'worktree', 'list')).toContain('twice');
  });

  it('keeps the branch of a reopen when its worktree cannot be remade', async () => {
    h.commit('.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    const head = gitIn(h.repo, 'rev-parse', 'HEAD');
    gitIn(h.repo, 'branch', 'mine', head);
    const chat = moving('mine', head);
    await expect(cut(chat)).rejects.toThrow(ChatWorktreeError);
    expect(branchExists('mine')).toBe(true);
  });
});
