import { mintId, type DeviceId, type PushSubscriptionId } from '@10db/contracts';
import { eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export interface PushSubscriptionRow {
  readonly id: PushSubscriptionId;
  readonly deviceId: DeviceId;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

export interface PushSubscriptionValues {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/** Keeps one subscription per endpoint: a browser that subscribes again, as another device, takes it over. */
export function upsertPushSubscription(
  ctx: WriteContext,
  deviceId: DeviceId,
  input: PushSubscriptionValues,
): void {
  ctx.tx
    .insert(schema.pushSubscriptions)
    .values({
      id: mintId('PushSubscription'),
      deviceId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoUpdate({
      target: schema.pushSubscriptions.endpoint,
      set: { deviceId, p256dh: input.p256dh, auth: input.auth, updatedAt: ctx.now },
    })
    .run();
}

/** Removes every subscription of one device (it turned push off). */
export function deletePushSubscriptionsOf(ctx: WriteContext, deviceId: DeviceId): void {
  ctx.tx
    .delete(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.deviceId, deviceId))
    .run();
}

/** Removes one subscription the push service reported gone. */
export function deletePushSubscriptionByEndpoint(ctx: WriteContext, endpoint: string): void {
  ctx.tx
    .delete(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.endpoint, endpoint))
    .run();
}

/** Every subscription of a device that is not revoked (revoking deletes a device's own). */
export function listPushSubscriptions(db: DbReader): PushSubscriptionRow[] {
  return db
    .select({
      id: schema.pushSubscriptions.id,
      deviceId: schema.pushSubscriptions.deviceId,
      endpoint: schema.pushSubscriptions.endpoint,
      p256dh: schema.pushSubscriptions.p256dh,
      auth: schema.pushSubscriptions.auth,
    })
    .from(schema.pushSubscriptions)
    .all();
}
