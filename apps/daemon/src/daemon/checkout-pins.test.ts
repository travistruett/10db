import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  mintId,
  type BatchDto,
  type ProjectDto,
} from '@10db/contracts';
import {
  clearWorktreePath,
  createTestStore,
  getAppSetting,
  insertBatch,
  insertChat,
  insertConversation,
  schema,
  setChatWork,
  seedProject,
  type Store,
} from '@10db/db';
import { createTempRepoWithOrigin, tempDir } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit, memoryPinStore, type CheckoutPin, type PinStore } from '../git';
import { chatWorktreePinKey, worktreePinKey } from '../git';
import { createProjectPinStore, projectAt } from './checkout-pins';

const pin = (id: string): CheckoutPin => ({
  gitDir: `/g/${id}`,
  commonDir: '/g/main',
  id,
  fetchUrl: 'https://github.com/acme/widgets.git',
  pushUrl: 'https://github.com/acme/widgets.git',
});

const WORKTREE = '/worktrees/ab/10db-feature';

let testStore: Store;
let close: () => void;
let state: StateStore;
let project: ProjectDto;
let batch: BatchDto;
let fallback: PinStore;
let pins: PinStore;

beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  testStore = test.store;
  project = seedProject(test.store, {
    repoPath: '/not/a/real/checkout',
    prTitlePrefix: 'feat(app)',
    delivery: 'pull_request',
    workspaceMode: 'worktree',
  });
  state = createStateStore(test.store, createEventBus());
  batch = state.write((ctx) =>
    insertBatch(ctx, {
      projectId: project.id,
      title: 'Feature',
      baseBranch: 'main',
      worktreePath: WORKTREE,
    }),
  );
  fallback = memoryPinStore();
  pins = createProjectPinStore(state, fallback);
});
afterEach(() => {
  close();
});

describe("a worktree's pin", () => {
  it('is stored under checkout_pin.<batchId>', () => {
    pins.set(WORKTREE, pin('1:2/3:4'));
    expect(worktreePinKey(batch.id)).toBe(`checkout_pin.${batch.id}`);
    expect(getAppSetting(state.db, worktreePinKey(batch.id))).toEqual({ ...pin('1:2/3:4') });
    expect(pins.get(WORKTREE)).toEqual(pin('1:2/3:4'));
    expect(fallback.get(WORKTREE)).toBeUndefined();
  });

  it('is deleted with the worktree', () => {
    pins.set(WORKTREE, pin('1:2/3:4'));
    pins.delete(WORKTREE);
    expect(pins.get(WORKTREE)).toBeUndefined();
    expect(getAppSetting(state.db, worktreePinKey(batch.id))).toBeUndefined();
  });

  it('resolves a live worktree path to its project', () => {
    expect(projectAt(state.db, WORKTREE)?.id).toBe(project.id);
  });

  it('resolves a cleared worktree path to no project and no pin', () => {
    pins.set(WORKTREE, pin('1:2/3:4'));
    state.write((ctx) => clearWorktreePath(ctx, batch.id));
    expect(projectAt(state.db, WORKTREE)).toBeUndefined();
    expect(pins.get(WORKTREE)).toBeUndefined();
  });
});

describe("a chat's worktree's pin", () => {
  const CHAT_WORKTREE = '/worktrees/cd/chat-topic';
  function chatAt(path: string) {
    const id = mintId('Chat');
    const conversationId = state.write(
      (ctx) =>
        insertConversation(ctx, {
          projectId: project.id,
          owner: { kind: ConversationOwnerKind.Chat, id },
          profile: ConversationProfile.Explore,
          state: ConversationState.IdleCold,
        }).id,
    );
    state.write((ctx) => {
      insertChat(ctx, {
        id,
        projectId: project.id,
        conversationId,
        title: 'Topic',
        tabPosition: 0,
      });
      setChatWork(ctx, id, null, { place: 'moving', worktreePath: path, branch: 'topic' });
    });
    return id;
  }

  it('is stored under checkout_pin.<chatId> and read back by a fresh store after a restart', () => {
    const id = chatAt(CHAT_WORKTREE);
    pins.set(CHAT_WORKTREE, pin('9:9/9:9'));
    expect(chatWorktreePinKey(id)).toBe(`checkout_pin.${id}`);
    expect(getAppSetting(state.db, chatWorktreePinKey(id))).toEqual({ ...pin('9:9/9:9') });
    expect(fallback.get(CHAT_WORKTREE)).toBeUndefined();
    const restarted = createProjectPinStore(state, memoryPinStore());
    expect(restarted.get(CHAT_WORKTREE)).toEqual(pin('9:9/9:9'));
    expect(projectAt(state.db, CHAT_WORKTREE)?.id).toBe(project.id);
  });

  it('keeps a cut worktree usable for a git that starts over the same store', async () => {
    const pair = createTempRepoWithOrigin();
    const root = tempDir('chat-worktrees');
    try {
      const real = seedProject(testStore, { repoPath: pair.repo.path });
      const path = join(realpathSync(root.path), 'topic');
      const id = chatAt(path);
      testStore.write((ctx) => {
        ctx.tx
          .update(schema.chats)
          .set({ projectId: real.id })
          .where(eq(schema.chats.id, id))
          .run();
      });
      const first = createGit({
        worktreeRoot: root.path,
        pins: createProjectPinStore(state, memoryPinStore()),
      });
      await first.addWorktree({
        repo: pair.repo.path,
        path,
        branch: 'chat/topic',
        startPoint: 'main',
        lockReason: `10db ${id}`,
      });
      // A restart: a new git, with pins read from the database alone.
      const second = createGit({
        worktreeRoot: root.path,
        pins: createProjectPinStore(state, memoryPinStore()),
      });
      await expect(second.currentBranch(path)).resolves.toBe('chat/topic');
    } finally {
      root.cleanup();
      pair.cleanup();
    }
  });

  it('is deleted with the worktree', () => {
    const id = chatAt(CHAT_WORKTREE);
    pins.set(CHAT_WORKTREE, pin('9:9/9:9'));
    pins.delete(CHAT_WORKTREE);
    expect(getAppSetting(state.db, chatWorktreePinKey(id))).toBeUndefined();
  });
});

describe("a project's own checkout", () => {
  it('keeps checkout_pin.<projectId>', () => {
    const checkout = tempDir('pin-checkout');
    try {
      const real = realpathSync(checkout.path);
      const own = seedProject(testStore, { repoPath: checkout.path });
      pins.set(real, pin('5:6/7:8'));
      expect(getAppSetting(state.db, `checkout_pin.${own.id}`)).toEqual({ ...pin('5:6/7:8') });
      expect(pins.get(real)).toEqual(pin('5:6/7:8'));
      expect(projectAt(state.db, real)?.id).toBe(own.id);
    } finally {
      checkout.cleanup();
    }
  });

  it('keeps the pin of a checkout no project uses in the fallback', () => {
    pins.set('/unused', pin('9:9/9:9'));
    expect(fallback.get('/unused')).toEqual(pin('9:9/9:9'));
  });
});
