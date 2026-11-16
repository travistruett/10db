import {
  ConversationItemAuthor,
  ConversationItemKind,
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  EventType,
  mintId,
  TaskStatus,
  type ChatId,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  archiveChat,
  chatMadeTask,
  chatView,
  getChat,
  insertChat,
  moveChatTab,
  openChats,
  recentChats,
  recordChatTask,
  takenOverChats,
  setChatTitle,
  touchChat,
  unarchiveChat,
} from './chats';
import { insertItem } from './conversation-items';
import { insertConversation } from './conversations';
import { listEventsAfter, latestEventSeq } from './events';
import * as schema from '../schema';
import type { Store } from './store';
import { insertTask, setTaskStatus } from './tasks';
import { createTestStore, seedProject } from './test-support';

// Sessions spec §7.1, §9.1: a chat's row, its tab's place in the strip, its title, and the tasks it
// filed, on a real SQLite file.

let store: Store;
let close: () => void;
let projectId: ProjectId;
beforeEach(() => {
  ({ store, close } = createTestStore());
  projectId = seedProject(store).id;
});
afterEach(() => {
  close();
});

function newChat(tabPosition: number, title = 'New session'): ChatId {
  return store.write((ctx) => {
    const id = mintId('Chat');
    const conv = insertConversation(ctx, {
      projectId,
      owner: { kind: ConversationOwnerKind.Chat, id },
      profile: ConversationProfile.Explore,
      state: ConversationState.IdleCold,
    });
    return insertChat(ctx, { id, projectId, conversationId: conv.id, title, tabPosition }).id;
  }).value;
}

/** The open tabs' ids by position, which must be exactly 0..n-1. */
function strip(): ChatId[] {
  const open = openChats(store.db);
  expect(open.map((c) => c.tabPosition)).toEqual(open.map((_, i) => i));
  return open.map((c) => c.id);
}

function taskOf(title: string): TaskId {
  return store.write((ctx) =>
    insertTask(ctx, projectId, {
      title,
      description: '',
      acceptanceCriteria: ['x'],
      areas: ['api'],
    }),
  ).value.id;
}

describe('the strip', () => {
  it('inserting at a position shifts the tabs at or after it', () => {
    const [a, b, c] = [newChat(0), newChat(1), newChat(2)];
    const d = newChat(1);
    expect(strip()).toEqual([a, d, b, c]);
  });

  it('moves, closes and reopens keep positions unique and gap-free', () => {
    const [a, b, c, d] = [newChat(0), newChat(1), newChat(2), newChat(3)];
    store.write((ctx) => {
      moveChatTab(ctx, d, 0);
    });
    expect(strip()).toEqual([d, a, b, c]);
    store.write((ctx) => {
      moveChatTab(ctx, a, null);
    });
    expect(strip()).toEqual([d, b, c]);
    expect(chatView(store.db, a).tabPosition).toBeNull();
    store.write((ctx) => {
      moveChatTab(ctx, a, 2);
    });
    expect(strip()).toEqual([d, b, a, c]);
    store.write((ctx) => {
      moveChatTab(ctx, b, 99);
    });
    expect(strip()).toEqual([d, a, c, b]);
  });
});

describe('takenOverChats', () => {
  it('lists a taken-over chat, and not one that is archived', () => {
    const open = newChat(0, 'In terminal');
    const archived = newChat(1, 'Archived in terminal');
    store.write((ctx) => {
      for (const id of [open, archived]) {
        const row = getChat(ctx.tx, id);
        ctx.tx
          .update(schema.conversations)
          .set({ state: ConversationState.TakenOver })
          .where(eq(schema.conversations.id, row.conversationId))
          .run();
      }
      archiveChat(ctx, archived, '2026-11-13T13:00:00.000Z');
    });
    expect(takenOverChats(store.db, projectId).map((c) => c.id)).toEqual([open]);
  });
});

describe('titles', () => {
  it("an agent's title never replaces the builder's, and the builder's always wins", () => {
    const id = newChat(0);
    expect(store.write((ctx) => setChatTitle(ctx, id, 'Login', 'builder')).value).toBe(true);
    expect(store.write((ctx) => setChatTitle(ctx, id, 'Agent', 'agent')).value).toBe(false);
    expect(chatView(store.db, id).title).toBe('Login');
    const other = newChat(1);
    store.write((ctx) => setChatTitle(ctx, other, 'Agent', 'agent'));
    store.write((ctx) => setChatTitle(ctx, other, 'Mine', 'builder'));
    expect(chatView(store.db, other)).toMatchObject({ title: 'Mine', titleSource: 'builder' });
  });
});

describe('archive and recent', () => {
  it('lists only touched chats, newest first, within the limit, and archive takes one out', () => {
    const [a, b, c] = [newChat(0), newChat(1), newChat(2)];
    expect(recentChats(store.db, projectId, 6)).toEqual([]);
    store.write((ctx) => {
      touchChat(ctx, a, '2026-11-13T10:00:00.000Z');
      touchChat(ctx, b, '2026-11-13T12:00:00.000Z');
      touchChat(ctx, c, '2026-11-13T11:00:00.000Z');
    });
    expect(recentChats(store.db, projectId, 6).map((r) => r.id)).toEqual([b, c, a]);
    expect(recentChats(store.db, projectId, 2).map((r) => r.id)).toEqual([b, c]);
    store.write((ctx) => {
      archiveChat(ctx, b, '2026-11-13T13:00:00.000Z');
    });
    expect(recentChats(store.db, projectId, 6).map((r) => r.id)).toEqual([c, a]);
    expect(strip()).toEqual([a, c]);
    expect(chatView(store.db, b).archivedAt).toBe('2026-11-13T13:00:00.000Z');
    store.write((ctx) => {
      unarchiveChat(ctx, b);
    });
    expect(chatView(store.db, b).archivedAt).toBeNull();
  });
});

describe('chatView', () => {
  it('counts the filed tasks not cancelled, and reads the latest reply', () => {
    const id = newChat(0);
    const [t1, t2] = [taskOf('One'), taskOf('Two')];
    store.write((ctx) => {
      recordChatTask(ctx, id, t1);
      recordChatTask(ctx, id, t2);
    });
    expect(chatView(store.db, id).tasksFiled).toBe(2);
    expect(chatMadeTask(store.db, id, t1)).toBe(true);
    expect(chatMadeTask(store.db, id, taskOf('Builder'))).toBe(false);
    store.write((ctx) => {
      setTaskStatus(ctx, t2, TaskStatus.Cancelled);
    });
    expect(chatView(store.db, id).tasksFiled).toBe(1);

    const conversationId = chatView(store.db, id).conversationId;
    expect(chatView(store.db, id).lastReplyAt).toBeNull();
    const reply = store.write((ctx) =>
      insertItem(ctx, conversationId, {
        author: ConversationItemAuthor.Agent,
        kind: ConversationItemKind.AgentMessage,
        body: { text: 'Hello' },
      }),
    ).value;
    expect(chatView(store.db, id).lastReplyAt).toBe(reply.createdAt);
  });
});

describe('events', () => {
  it('every write emits one chat.changed in its transaction', () => {
    const id = newChat(0);
    const task = taskOf('One');
    const writes: ((ctx: Parameters<Parameters<Store['write']>[0]>[0]) => unknown)[] = [
      (ctx) => {
        moveChatTab(ctx, id, null);
      },
      (ctx) => setChatTitle(ctx, id, 'Login', 'builder'),
      (ctx) => {
        touchChat(ctx, id, '2026-11-13T10:00:00.000Z');
      },
      (ctx) => {
        recordChatTask(ctx, id, task);
      },
      (ctx) => {
        archiveChat(ctx, id, '2026-11-13T11:00:00.000Z');
      },
      (ctx) => {
        unarchiveChat(ctx, id);
      },
    ];
    for (const write of writes) {
      const before = latestEventSeq(store.db);
      store.write((ctx) => write(ctx));
      const events = listEventsAfter(store.db, before, 10).filter(
        (e) => e.type === EventType.ChatChanged,
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ entityType: 'chat', entityId: id });
    }
  });
});
