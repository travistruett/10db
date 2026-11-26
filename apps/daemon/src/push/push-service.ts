import { deletePushSubscriptionsOf, upsertPushSubscription } from '@10db/db';
import type { PushRoutes } from '../api';
import type { StateStore } from '../events';
import type { VapidKeyStore } from './vapid-keys';

/** The push routes' service: the key to subscribe with, and a device keeping or dropping its subscription. */
export function createPushService(deps: {
  readonly state: StateStore;
  readonly keys: VapidKeyStore;
}): PushRoutes {
  return {
    async key() {
      return { key: (await deps.keys.ensure()).publicKey };
    },
    async subscribe(deviceId, input) {
      // The key exists before the first subscription, so the sender can read it.
      await deps.keys.ensure();
      deps.state.write((ctx) => {
        upsertPushSubscription(ctx, deviceId, input);
      });
    },
    unsubscribe(deviceId) {
      deps.state.write((ctx) => {
        deletePushSubscriptionsOf(ctx, deviceId);
      });
    },
  };
}
