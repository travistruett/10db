import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConflictError,
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  mintId,
  NotFoundError,
} from '@10db/contracts';
import {
  chatOfConversation,
  createTestStore,
  insertChat,
  insertConversation,
  insertTask,
  seedProject,
  setChatWork,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, type TempDir } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { gitTrackedFiles } from '../shape';
import { createConversationFiles, TASK_FILES_LATER } from './conversation-files';

// Sessions spec §10, §11: `@` lists only the files git tracks in the chat's own checkout, which the
// daemon resolves from the conversation, on a real repository and a real SQLite file.

let repo: TempDir;
let close: () => void;
afterEach(() => {
  repo.cleanup();
  close();
});

function world(): {
  state: StateStore;
  chat: ReturnType<typeof insertConversation>;
  task: ReturnType<typeof insertConversation>;
} {
  repo = createTempRepo();
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' });
  mkdirSync(join(repo.path, 'src'));
  mkdirSync(join(repo.path, 'docs'));
  writeFileSync(join(repo.path, 'src', 'login.ts'), 'export {};\n');
  writeFileSync(join(repo.path, 'docs', 'a b.md'), '# a b\n');
  writeFileSync(join(repo.path, '.gitignore'), 'secret-login.log\n');
  git('add', 'src/login.ts', 'docs/a b.md', '.gitignore');
  git('commit', '-q', '-m', 'Add files');
  writeFileSync(join(repo.path, 'src', 'login-draft.ts'), 'untracked\n');
  writeFileSync(join(repo.path, 'secret-login.log'), 'ignored\n');
  const test = createTestStore();
  close = test.close;
  const state = createStateStore(test.store, createEventBus());
  const project = seedProject(test.store, { repoPath: repo.path });
  const chatId = mintId('Chat');
  const chat = state.write((ctx) => {
    const conv = insertConversation(ctx, {
      projectId: project.id,
      owner: { kind: ConversationOwnerKind.Chat, id: chatId },
      profile: ConversationProfile.Explore,
      state: ConversationState.IdleCold,
    });
    insertChat(ctx, {
      id: chatId,
      projectId: project.id,
      conversationId: conv.id,
      title: 'x',
      tabPosition: 0,
    });
    return conv;
  });
  const task = state.write((ctx) => {
    const t = insertTask(ctx, project.id, {
      title: 'T',
      description: '',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    });
    return insertConversation(ctx, {
      projectId: project.id,
      owner: { kind: ConversationOwnerKind.Task, id: t.id },
      profile: ConversationProfile.Lane,
      state: null,
    });
  });
  return { state, chat, task };
}

describe('conversationFiles', () => {
  it("lists the chat checkout's tracked files, never an untracked or ignored one", () => {
    const { state, chat } = world();
    const files = createConversationFiles({ state, now: () => 0, trackedFiles: gitTrackedFiles });
    expect(files(chat.id, 'login').map((m) => m.path)).toEqual(['src/login.ts']);
    expect(files(chat.id, '').map((m) => m.path)).toEqual([
      '.gitignore',
      'README.md',
      'docs/a b.md',
      'src/login.ts',
    ]);
  });

  it("lists a branch session's worktree, not the checkout", () => {
    const { state, chat } = world();
    const row = chatOfConversation(state.db, chat.id);
    if (row === null) throw new Error('no chat');
    state.write((ctx) => {
      setChatWork(ctx, row.id, null, {
        place: 'branch',
        worktreePath: '/worktrees/fix',
        branch: 'fix',
        baseHead: 'abc',
      });
    });
    const asked: string[] = [];
    const files = createConversationFiles({
      state,
      now: () => 0,
      trackedFiles: (path) => {
        asked.push(path);
        return ['only-in-worktree.ts'];
      },
    });
    expect(files(chat.id, 'only').map((m) => m.path)).toEqual(['only-in-worktree.ts']);
    expect(asked).toEqual(['/worktrees/fix']);
  });

  it("refuses a task's conversation, and an unknown one", () => {
    const { state, task } = world();
    const files = createConversationFiles({ state, now: () => 0, trackedFiles: gitTrackedFiles });
    expect(() => files(task.id, 'a')).toThrow(new ConflictError(TASK_FILES_LATER));
    expect(() => files(mintId('Conversation'), 'a')).toThrow(NotFoundError);
  });
});
