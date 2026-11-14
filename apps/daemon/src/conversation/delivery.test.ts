import { idUuid, type ConversationId, type ConversationItemId } from '@10db/contracts';
import {
  createTestStore,
  getItem,
  getMessageRow,
  insertBuilderMessage,
  insertItem,
  insertShape,
  insertTask,
  listUndeliveredTaskMessages,
  markItemsTakenUnder,
  seedProject,
  shapeConversation,
  taskConversationOf,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import type { InterruptReceipt } from '../sessions';
import { createDelivery, type DeliveryDeps } from './delivery';
import { readBackAsk } from './delivery-rules';
import { STRICTEST_LIMITS } from './picture-limits';

// Sessions spec §6.2: the delivery rules over any conversation. A Plan conversation here, so the
// library is seen to need no task.

let store: Store;
let close: () => void;
let state: StateStore;
let conversation: ConversationId;
beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  const project = seedProject(store, { name: 'alpha' });
  conversation = store.write((ctx) =>
    shapeConversation(ctx.tx, insertShape(ctx, project.id, { title: 'Plan', origin: 'app' }).id),
  ).value.id;
});
afterEach(() => {
  close();
});

const say = (text: string): ConversationItemId =>
  state.write((ctx) =>
    insertItem(ctx, conversation, { author: 'builder', kind: 'message', body: { text } }),
  ).id;

/** A handle that records each send, with the push uuids its message held when it was sent. */
function recordingHandle(receipt: InterruptReceipt = null) {
  const sent: { uuid: string; keptBefore: boolean }[] = [];
  let interrupts = 0;
  return {
    sent,
    interrupts: () => interrupts,
    handle: {
      send(_text: string, _images: unknown, uuid?: string) {
        const kept =
          uuid !== undefined &&
          store.db.$client
            .prepare(
              'SELECT count(*) FROM conversation_items i, json_each(i.push_uuids) j WHERE j.value = ?',
            )
            .pluck()
            .get(uuid) === 1;
        sent.push({ uuid: uuid ?? '', keptBefore: kept });
      },
      interrupt() {
        interrupts += 1;
        return Promise.resolve(receipt);
      },
    },
  };
}

const delivery = (handle: DeliveryDeps['handle'], over: Partial<DeliveryDeps> = {}) =>
  createDelivery({
    state,
    conversation: () => conversation,
    handle,
    limits: STRICTEST_LIMITS,
    messageText: (m) => m.body,
    ...over,
  });

describe('a conversation’s delivery', () => {
  it('keeps the uuid before the session is handed the message, and delivers it when consumed', () => {
    const rec = recordingHandle();
    const d = delivery(rec.handle);
    const id = say('Hello');
    d.push(getMessageRow(state.db, id));
    expect(rec.sent).toEqual([{ uuid: idUuid(id), keptBefore: true }]);
    expect(d.consumed([idUuid(id)])).toEqual([id]);
    expect(getItem(state.db, id).deliveredAt).not.toBeNull();
  });

  it('hands back a dropped message: no longer pushed', () => {
    const rec = recordingHandle();
    const d = delivery(rec.handle);
    const id = say('Hello');
    d.push(getMessageRow(state.db, id));
    expect(d.handBack([idUuid(id)])).toEqual([id]);
    expect(getItem(state.db, id).pushedAt).toBeNull();
  });

  it('pushes again, under a fresh uuid, a message the interrupt’s receipt does not name', async () => {
    const first = say('One');
    const second = say('Two');
    const rec = recordingHandle({ stillQueued: [idUuid(first)] });
    const d = delivery(rec.handle);
    d.pushUntaken();
    await d.interrupt();
    expect(rec.interrupts()).toBe(1);
    expect(rec.sent.map((s) => s.uuid).slice(0, 2)).toEqual([idUuid(first), idUuid(second)]);
    expect(rec.sent).toHaveLength(3);
    const again = rec.sent[2]?.uuid ?? '';
    expect(again).not.toBe(idUuid(second));
    expect(getItem(state.db, second).pushUuids).toEqual([idUuid(second), again]);
  });

  it('pushes a message again later when the write that kept its uuid failed', () => {
    const rec = recordingHandle();
    const d = delivery(rec.handle);
    const id = say('Hello');
    store.db.$client.exec(
      "CREATE TRIGGER refuse_push BEFORE UPDATE ON conversation_items BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    expect(() => {
      d.push(getMessageRow(state.db, id));
    }).toThrow('disk full');
    store.db.$client.exec('DROP TRIGGER refuse_push');
    d.pushUntaken();
    expect(rec.sent.map((s) => s.uuid)).toEqual([idUuid(id)]);
  });

  it('sends nothing while the owner has no conversation yet', () => {
    say('Waiting');
    const rec = recordingHandle();
    delivery(rec.handle, { conversation: () => null }).pushUntaken();
    expect(rec.sent).toEqual([]);
  });
});

// Sessions spec §6.1, §6.2: a task's conversation takes its builder messages by the same rules, and
// after a restart rule 5 reads back what the agent took of them.
describe('a task conversation’s delivery', () => {
  it('pushes again what an interrupt may have lost, and rule 5 delivers what the agent shows it took', async () => {
    const project = seedProject(store, { name: 'beta' });
    const task = store.write((ctx) =>
      insertTask(ctx, project.id, {
        title: 'Settings page',
        acceptanceCriteria: ['x'],
        areas: ['ui'],
      }),
    ).value;
    const write = (body: string) =>
      state.write((ctx) => insertBuilderMessage(ctx, task.id, { body, files: [] })).id;
    const first = write('Make it smaller');
    const second = write('And darker');
    const rec = recordingHandle(null);
    const d = delivery(rec.handle, {
      conversation: () => taskConversationOf(state.db, task.id)?.id ?? null,
    });
    d.pushUntaken();
    expect(d.consumed([idUuid(first)])).toEqual([first]);
    // No receipt: the second may have been lost with the turn, so it goes again under a fresh uuid.
    await d.interrupt();
    const again = rec.sent.at(-1)?.uuid ?? '';
    expect(rec.sent.map((s) => s.uuid)).toEqual([idUuid(first), idUuid(second), again]);

    // The daemon restarts: the agent's conversation holds the fresh uuid, so the second was taken.
    const inDoubt = listUndeliveredTaskMessages(state.db, task.id);
    expect(readBackAsk(inDoubt)).toEqual({
      wanted: [idUuid(second), again],
      since: getItem(state.db, second).createdAt,
    });
    const conversationId = taskConversationOf(state.db, task.id)?.id;
    if (conversationId === undefined) throw new Error('no conversation');
    expect(state.write((ctx) => markItemsTakenUnder(ctx, conversationId, [again]))).toEqual([
      second,
    ]);
    expect(listUndeliveredTaskMessages(state.db, task.id)).toEqual([]);
  });
});
