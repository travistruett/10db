import { idUuid, type ConversationId, type ConversationItemId } from '@10db/contracts';
import {
  createTestStore,
  getItem,
  getMessageRow,
  insertItem,
  insertShape,
  seedProject,
  shapeConversation,
  type Store,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import type { InterruptReceipt } from '../sessions';
import { createDelivery, type DeliveryDeps } from './delivery';
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

  it('sends nothing while the owner has no conversation yet', () => {
    say('Waiting');
    const rec = recordingHandle();
    delivery(rec.handle, { conversation: () => null }).pushUntaken();
    expect(rec.sent).toEqual([]);
  });
});
