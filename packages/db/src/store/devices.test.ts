import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { getDevice, insertDevice, listDevices, revokeDevice } from './devices';
import type { Store } from './store';
import { createTestStore } from './test-support';

let store: Store;
let close: () => void;

beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

describe('revoking a device', () => {
  it('drops it from the list, deletes its push subscriptions and emits once', () => {
    const id = mintId('Device');
    store.write((ctx) => {
      insertDevice(ctx, id, { label: 'Pixel', platform: 'android', tokenHash: 'ab'.repeat(32) });
      ctx.tx
        .insert(schema.pushSubscriptions)
        .values({
          id: mintId('PushSubscription'),
          deviceId: id,
          endpoint: 'https://push.example/1',
          p256dh: 'k',
          auth: 'a',
          createdAt: ctx.now,
          updatedAt: ctx.now,
        })
        .run();
    });

    expect(store.write((ctx) => revokeDevice(ctx, id)).value).toBe(true);
    expect(store.write((ctx) => revokeDevice(ctx, id)).value).toBe(false);

    expect(listDevices(store.db)).toEqual([]);
    expect(getDevice(store.db, id)?.revokedAt).not.toBeNull();
    expect(store.db.select().from(schema.pushSubscriptions).all()).toEqual([]);
    const changes = store.db
      .select()
      .from(schema.events)
      .all()
      .filter((e) => e.type === 'device.changed')
      .map((e) => e.data);
    expect(changes).toEqual([{ change: 'paired' }, { change: 'revoked' }]);
  });
});
