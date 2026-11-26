import type { DeviceId, PushKeyDto, PushSubscriptionInput } from '@10db/contracts';
import { deletePushSubscriptionsOf, upsertPushSubscription } from '@10db/db';
import type { StateStore } from '../events';
import type { VapidKeyStore } from './vapid-keys';

/** What a paired device does about push: reads the key to subscribe with, keeps or drops its subscription. */
export interface PushService {
  key(): Promise<PushKeyDto>;
  subscribe(deviceId: DeviceId, input: PushSubscriptionInput): Promise<void>;
  unsubscribe(deviceId: DeviceId): void;
}

export function createPushService(deps: {
  readonly state: StateStore;
  readonly keys: VapidKeyStore;
}): PushService {
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
