import {
  EventType,
  InvalidError,
  idUuid,
  mintId,
  ConversationItemId,
  type ConversationId,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestStore,
  findItemByPushUuid,
  getConversation,
  getItem,
  insertItem,
  insertShape,
  listItems,
  listPushedTurnStarters,
  listQueuedTurnStarters,
  patchConversation,
  putItem,
  updateItem,
  markItemPushedUnder,
  markItemsDelivered,
  markItemsHandedBack,
  seedProject,
  shapeConversation,
  type Store,
} from './index';

// Sessions spec §9.1: a conversation's items are numbered by seq whatever their id's prefix, and a
// uuid a push went under, or a migrated row's own, finds its item.

let store: Store;
let close: () => void;
let conversation: ConversationId;
let other: ConversationId;
beforeEach(() => {
  ({ store, close } = createTestStore());
  const project = seedProject(store, { name: 'alpha' });
  const owned = () =>
    store.write(
      (ctx) =>
        shapeConversation(ctx.tx, insertShape(ctx, project.id, { title: 'Plan', origin: 'app' }).id)
          .id,
    ).value;
  conversation = owned();
  other = owned();
});
afterEach(() => {
  close();
});

const message = (text: string) => ({ author: 'builder', kind: 'message', body: { text } }) as const;
const add = (into: ConversationId, text: string) =>
  store.write((ctx) => insertItem(ctx, into, message(text))).value;

/** An item written as the copy leaves a migrated row: its old id, at `seq`, with `next_seq` past it. */
function migrated(prefix: 'shm' | 'tmg', seq: number, pushUuids: readonly string[] = []) {
  const id = ConversationItemId.parse(`${prefix}_${idUuid(mintId('ConversationItem'))}`);
  store.db.$client
    .prepare(
      `INSERT INTO conversation_items (id, conversation_id, seq, author, kind, body, push_uuids, created_at,
         updated_at)
       VALUES (?, ?, ?, 'builder', 'message', '{"text":"old"}', ?, '2026-11-01T00:00:00.000Z',
         '2026-11-01T00:00:00.000Z')`,
    )
    .run(id, conversation, seq, JSON.stringify(pushUuids));
  store.db.$client
    .prepare('UPDATE conversations SET next_seq = ? WHERE id = ?')
    .run(seq + 1, conversation);
  return id;
}

describe('conversation items', () => {
  it('numbers each new item one past the last and moves next_seq on', () => {
    expect(
      [add(conversation, 'a'), add(conversation, 'b'), add(conversation, 'c')].map((i) => i.seq),
    ).toEqual([1, 2, 3]);
    expect(getConversation(store.db, conversation).nextSeq).toBe(4);
  });

  it('lists a migrated row before a new one, though the new id sorts first as text', () => {
    const old = migrated('shm', 1);
    const fresh = add(conversation, 'new');
    expect([old, fresh.id].sort()).toEqual([fresh.id, old]);
    expect(fresh.seq).toBe(2);
    expect(listItems(store.db, conversation).map((i) => i.id)).toEqual([old, fresh.id]);
  });

  it('lists the items after a seq', () => {
    add(conversation, 'a');
    const second = add(conversation, 'b');
    expect(listItems(store.db, conversation, { afterSeq: 1 }).map((i) => i.id)).toEqual([
      second.id,
    ]);
  });

  it.each<{ name: string; lookup: () => { uuid: string; expected: ConversationItemId | null } }>([
    {
      name: 'a uuid a push went under finds its item',
      lookup: () => {
        const item = add(conversation, 'a');
        store.write((ctx) => {
          markItemPushedUnder(ctx, item.id, 'c0ffee00-0000-4000-8000-000000000001');
        });
        return { uuid: 'c0ffee00-0000-4000-8000-000000000001', expected: item.id };
      },
    },
    {
      name: 'a migrated tmg_ row with no push uuids is found by its own uuid',
      lookup: () => {
        const id = migrated('tmg', 1);
        return { uuid: idUuid(id), expected: id };
      },
    },
    {
      name: 'another conversation’s item is not found',
      lookup: () => {
        const item = add(other, 'elsewhere');
        return { uuid: idUuid(item.id), expected: null };
      },
    },
    {
      name: 'text that is no uuid finds nothing',
      lookup: () => {
        add(conversation, 'a');
        return { uuid: 'not-a-uuid', expected: null };
      },
    },
  ])('$name', ({ lookup }) => {
    const { uuid, expected } = lookup();
    expect(findItemByPushUuid(store.db, conversation, uuid)).toBe(expected);
  });

  it('hands back a pushed item: no longer pushed, handed back, its uuids kept; a delivered one stays', () => {
    const pushed = add(conversation, 'a');
    const delivered = add(conversation, 'b');
    store.write((ctx) => {
      markItemPushedUnder(ctx, pushed.id, 'u-1');
      markItemPushedUnder(ctx, delivered.id, 'u-2');
      markItemsDelivered(ctx, conversation, [delivered.id]);
    });
    const handed = store.write((ctx) =>
      markItemsHandedBack(ctx, conversation, [pushed.id, delivered.id]),
    ).value;
    expect(handed).toEqual([pushed.id]);
    const back = getItem(store.db, pushed.id);
    expect(back).toMatchObject({ pushedAt: null, pushUuids: ['u-1'] });
    expect(back.handedBackAt).not.toBeNull();
    const kept = getItem(store.db, delivered.id);
    expect(kept.pushedAt).not.toBeNull();
    expect(kept.handedBackAt).toBeNull();
  });

  it('refuses a tool call whose body is not a tool call view', () => {
    expect(() =>
      store.write((ctx) =>
        insertItem(ctx, conversation, { author: 'agent', kind: 'tool_call', body: { text: 'x' } }),
      ),
    ).toThrow(InvalidError);
    expect(listItems(store.db, conversation)).toEqual([]);
  });
});

describe('conversation item events and the queue', () => {
  const types = (events: readonly { type: string }[]) => events.map((e) => e.type);

  it('announces an insert with its id, seq and kind, and keeps a given id', () => {
    const id = mintId('ConversationItem');
    const { value, events } = store.write((ctx) =>
      insertItem(ctx, conversation, { id, ...message('hi') }),
    );
    expect(value.id).toBe(id);
    expect(events.map((e) => [e.type, e.entityId, e.data])).toEqual([
      [EventType.ConversationItemAdded, conversation, { id, seq: 1, kind: 'message' }],
    ]);
  });

  it('stores one row for an item put twice, announced once added and once updated', () => {
    const id = mintId('ConversationItem');
    const put = (text: string) =>
      store.write((ctx) =>
        putItem(ctx, conversation, { id, author: 'agent', kind: 'agent_message', body: { text } }),
      ).events;
    const events = [...put('Hal'), ...put('Half')];
    expect(types(events)).toEqual([
      EventType.ConversationItemAdded,
      EventType.ConversationItemUpdated,
    ]);
    expect(listItems(store.db, conversation).map((i) => i.body)).toEqual([{ text: 'Half' }]);
  });

  it('announces an update', () => {
    const item = add(conversation, 'a');
    const { events } = store.write((ctx) => {
      updateItem(ctx, item.id, { partial: true });
    });
    expect(types(events)).toEqual([EventType.ConversationItemUpdated]);
    expect(getItem(store.db, item.id).partial).toBe(true);
  });

  it('announces a state change, and no patch that leaves the state', () => {
    const changed = store.write((ctx) =>
      patchConversation(ctx, conversation, { state: 'running' }),
    );
    const same = store.write((ctx) => patchConversation(ctx, conversation, { state: 'running' }));
    expect(changed.events.map((e) => [e.type, e.data])).toEqual([
      [EventType.ConversationState, { state: 'running' }],
    ]);
    expect(same.events).toEqual([]);
  });

  it('queues the builder messages and prompted presses neither pushed nor delivered, by seq, and lists the pushed apart', () => {
    const waiting = add(conversation, 'waiting');
    const pushed = add(conversation, 'pushed');
    const delivered = add(conversation, 'delivered');
    const press = (prompt?: string) =>
      store.write((ctx) =>
        insertItem(ctx, conversation, {
          author: 'system',
          kind: 'shape_event',
          body: { kind: 'propose', text: 'Propose', ...(prompt === undefined ? {} : { prompt }) },
        }),
      ).value;
    const propose = press('Propose a plan.');
    press();
    const rehearse = press('Rehearse the tasks.');
    const unprompted = press();
    store.write((ctx) => {
      markItemPushedUnder(ctx, pushed.id, 'u-1');
      markItemPushedUnder(ctx, rehearse.id, 'u-2');
      markItemPushedUnder(ctx, unprompted.id, 'u-3');
      markItemsDelivered(ctx, conversation, [delivered.id]);
    });
    expect(listQueuedTurnStarters(store.db, conversation).map((i) => i.id)).toEqual([
      waiting.id,
      propose.id,
    ]);
    expect(listPushedTurnStarters(store.db, conversation).map((i) => i.id)).toEqual([
      pushed.id,
      rehearse.id,
    ]);
  });
});
