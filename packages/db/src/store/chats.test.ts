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
  type WorkPlace,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  archiveChat,
  chatMadeTask,
  chatsInPlace,
  chatView,
  findChatByWorktreePath,
  getChat,
  insertChat,
  moveChatTab,
  openChats,
  recentChats,
  recordChatTask,
  searchChats,
  setChatWork,
  takenBranchesAndPaths,
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

type Place = WorkPlace | null;

describe('setChatWork', () => {
  const none = { place: null } as const;
  it.each<{ name: string; at: Place; expect: Place; next: Place; wins: boolean }>([
    { name: 'reading to choosing', at: null, expect: null, next: 'choosing', wins: true },
    { name: 'choosing to here', at: 'choosing', expect: 'choosing', next: 'here', wins: true },
    { name: 'choosing to moving', at: 'choosing', expect: 'choosing', next: 'moving', wins: true },
    { name: 'moving to branch', at: 'moving', expect: 'moving', next: 'branch', wins: true },
    {
      name: 'a branch back to moving for a reopen',
      at: 'branch',
      expect: 'branch',
      next: 'moving',
      wins: true,
    },
    {
      name: 'a write expecting reading on a choosing row',
      at: 'choosing',
      expect: null,
      next: 'here',
      wins: false,
    },
    {
      name: 'a write expecting choosing on a reading row',
      at: null,
      expect: 'choosing',
      next: 'here',
      wins: false,
    },
    {
      name: 'a write expecting here on a branch row',
      at: 'branch',
      expect: 'here',
      next: 'choosing',
      wins: false,
    },
  ])('$name', (row) => {
    const id = newChat(0);
    if (row.at !== null) store.write((ctx) => setChatWork(ctx, id, null, { place: row.at }));
    const before = latestEventSeq(store.db);
    const won = store.write((ctx) => setChatWork(ctx, id, row.expect, { place: row.next })).value;
    expect(won).toBe(row.wins);
    expect(getChat(store.db, id).workPlace).toBe(row.wins ? row.next : row.at);
    const events = listEventsAfter(store.db, before, 10).filter(
      (e) => e.type === EventType.ChatChanged,
    );
    expect(events).toHaveLength(row.wins ? 1 : 0);
  });

  it('records the fields it is given, keeps the ones it is not, and clears the ones set to null', () => {
    const id = newChat(0);
    store.write((ctx) =>
      setChatWork(ctx, id, null, {
        place: 'moving',
        worktreePath: '/w/a',
        branch: 'fix-a',
        askedAt: '2026-11-17T10:00:00.000Z',
      }),
    );
    store.write((ctx) => setChatWork(ctx, id, 'moving', { place: 'branch', baseHead: 'abc' }));
    expect(chatView(store.db, id).work).toEqual({
      place: 'branch',
      branch: 'fix-a',
      base: 'abc',
      worktree: '/w/a',
      askedAt: '2026-11-17T10:00:00.000Z',
    });
    store.write((ctx) =>
      setChatWork(ctx, id, 'branch', { ...none, worktreePath: null, branch: null, baseHead: null }),
    );
    expect(chatView(store.db, id).work).toBeNull();
  });

  it('lets one of two writers racing on the same row win, and the other see false', () => {
    const id = newChat(0);
    const results = [
      store.write((ctx) => setChatWork(ctx, id, null, { place: 'choosing' })).value,
      store.write((ctx) => setChatWork(ctx, id, null, { place: 'here' })).value,
    ];
    expect(results).toEqual([true, false]);
    expect(getChat(store.db, id).workPlace).toBe('choosing');
  });

  it('refuses two chats on one worktree path', () => {
    const [a, b] = [newChat(0), newChat(1)];
    store.write((ctx) => setChatWork(ctx, a, null, { place: 'moving', worktreePath: '/w/x' }));
    expect(() =>
      store.write((ctx) => setChatWork(ctx, b, null, { place: 'moving', worktreePath: '/w/x' })),
    ).toThrow();
  });
});

describe('lookups', () => {
  it('finds a chat by its worktree path, and chats by place, archived ones included', () => {
    const [live, archived, reading] = [newChat(0), newChat(1), newChat(2)];
    store.write((ctx) => {
      setChatWork(ctx, live, null, { place: 'branch', worktreePath: '/w/live', branch: 'live' });
      setChatWork(ctx, archived, null, { place: 'branch', worktreePath: '/w/old', branch: 'old' });
      archiveChat(ctx, archived, '2026-11-17T10:00:00.000Z');
    });
    expect(findChatByWorktreePath(store.db, '/w/live')?.id).toBe(live);
    expect(findChatByWorktreePath(store.db, '/w/old')?.id).toBe(archived);
    expect(findChatByWorktreePath(store.db, '/w/none')).toBeUndefined();
    expect(chatsInPlace(store.db, 'branch').map((c) => c.id)).toEqual([live, archived]);
    expect(chatsInPlace(store.db, 'here')).toEqual([]);
    expect(reading).toBeDefined();
  });

  it('lists the names in use for the project, a cleared path no longer counted but its branch kept', () => {
    const [a, b, c] = [newChat(0), newChat(1), newChat(2)];
    store.write((ctx) => {
      setChatWork(ctx, a, null, { place: 'branch', worktreePath: '/w/a', branch: 'a' });
      setChatWork(ctx, b, null, { place: 'branch', worktreePath: '/w/b', branch: 'b' });
      setChatWork(ctx, b, 'branch', { place: 'branch', worktreePath: null });
    });
    const taken = takenBranchesAndPaths(store.db, projectId);
    expect(taken.branches.toSorted()).toEqual(['a', 'b']);
    expect(taken.paths).toEqual(['/w/a']);
    expect(takenBranchesAndPaths(store.db, mintId('Project'))).toEqual({ branches: [], paths: [] });
    expect(c).toBeDefined();
  });
});

describe('searchChats', () => {
  const at = (n: number): string => `2026-11-17T10:00:0${String(n)}.000Z`;
  const page = (text: string, after: string | null = null, limit = 50) =>
    searchChats(store.db, { text, after, limit });

  it('matches titles across open, closed and archived chats, ignoring case and wildcards', () => {
    const [open, closed, archived, other] = [
      newChat(0, 'Fix login'),
      newChat(1, 'login page'),
      newChat(2, 'Old LOGIN bug'),
      newChat(3, '100% login'),
    ];
    store.write((ctx) => {
      moveChatTab(ctx, closed, null);
      archiveChat(ctx, archived, at(1));
    });
    expect(
      page('login')
        .rows.map((r) => r.id)
        .toSorted(),
    ).toEqual([open, closed, archived, other].toSorted());
    expect(page('%').rows.map((r) => r.id)).toEqual([other]);
    expect(page('_ogin').rows).toEqual([]);
    expect(page('nothing').rows).toEqual([]);
  });

  it('pages newest first with ties and chats that have no activity last, without skips or repeats', () => {
    const [m0, m1, m2, m3, m4, m5] = [
      newChat(0, 'Match 0'),
      newChat(1, 'Match 1'),
      newChat(2, 'Match 2'),
      newChat(3, 'Match 3'),
      newChat(4, 'Match 4'),
      newChat(5, 'Match 5'),
    ];
    store.write((ctx) => {
      touchChat(ctx, m0, at(3));
      touchChat(ctx, m1, at(5));
      touchChat(ctx, m2, at(3));
    });
    const seen: ChatId[] = [];
    let after: string | null = null;
    do {
      const p = page('Match', after, 2);
      seen.push(...p.rows.map((r) => r.id));
      after = p.next;
    } while (after !== null);
    const tied = [m0, m2].toSorted().reverse();
    const idle = [m3, m4, m5].toSorted().reverse();
    expect(seen).toEqual([m1, ...tied, ...idle]);
    expect(new Set(seen).size).toBe(6);
    expect(page('Match', null, 6).next).toBeNull();
  });

  it('refuses a cursor it did not make', () => {
    expect(() => page('x', 'garbage')).toThrow();
  });
});

describe('takenOverChats and branch sessions', () => {
  it('leaves out a taken-over branch chat that has a worktree and keeps one that has none', () => {
    const [withTree, noTree, here] = [newChat(0), newChat(1), newChat(2)];
    store.write((ctx) => {
      setChatWork(ctx, withTree, null, { place: 'branch', worktreePath: '/w/x', branch: 'x' });
      setChatWork(ctx, noTree, null, { place: 'branch', branch: 'y' });
      setChatWork(ctx, here, null, { place: 'here' });
      for (const id of [withTree, noTree, here]) {
        ctx.tx
          .update(schema.conversations)
          .set({ state: ConversationState.TakenOver })
          .where(eq(schema.conversations.id, getChat(ctx.tx, id).conversationId))
          .run();
      }
    });
    expect(takenOverChats(store.db, projectId).map((c) => c.id)).toEqual([noTree, here]);
  });
});
