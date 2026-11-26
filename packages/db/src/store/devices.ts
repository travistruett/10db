import {
  DeviceChange,
  EventType,
  type DeviceDto,
  type DeviceId,
  type DevicePlatform,
} from '@10db/contracts';
import { and, asc, eq, isNull } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export interface DeviceInput {
  readonly label: string;
  readonly platform: DevicePlatform;
  /** Lower-case hex SHA-256 of the token's secret. */
  readonly tokenHash: string;
}

export interface DeviceRow extends DeviceDto {
  readonly tokenHash: string;
  readonly revokedAt: string | null;
}

type Row = typeof schema.devices.$inferSelect;

function toDto(row: Row): DeviceDto {
  return {
    id: row.id,
    label: row.label,
    platform: row.platform,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

function emitChange(ctx: WriteContext, id: DeviceId, change: DeviceChange): void {
  ctx.emit({ type: EventType.DeviceChanged, entityType: 'device', entityId: id, data: { change } });
}

/** Inserts the device and emits device.changed { change: 'paired' } in the same write. */
export function insertDevice(ctx: WriteContext, id: DeviceId, input: DeviceInput): DeviceDto {
  const row: Row = {
    id,
    label: input.label,
    platform: input.platform,
    tokenHash: input.tokenHash,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    lastUsedAt: null,
    revokedAt: null,
  };
  ctx.tx.insert(schema.devices).values(row).run();
  emitChange(ctx, id, DeviceChange.Paired);
  return toDto(row);
}

export function getDevice(db: DbReader, id: DeviceId): DeviceRow | undefined {
  const row = db.select().from(schema.devices).where(eq(schema.devices.id, id)).get();
  return row ? { ...toDto(row), tokenHash: row.tokenHash, revokedAt: row.revokedAt } : undefined;
}

/** Devices not revoked, oldest first. */
export function listDevices(db: DbReader): DeviceDto[] {
  return db
    .select()
    .from(schema.devices)
    .where(isNull(schema.devices.revokedAt))
    .orderBy(asc(schema.devices.createdAt), asc(schema.devices.id))
    .all()
    .map(toDto);
}

/** Sets last_used_at and emits device.changed { change: 'used' }. */
export function touchDevice(ctx: WriteContext, id: DeviceId): void {
  const done = ctx.tx
    .update(schema.devices)
    .set({ lastUsedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(schema.devices.id, id))
    .run();
  if (done.changes > 0) emitChange(ctx, id, DeviceChange.Used);
}

/** Sets revoked_at, deletes the device's push subscriptions, emits device.changed { change: 'revoked' }; false if already revoked or unknown. */
export function revokeDevice(ctx: WriteContext, id: DeviceId): boolean {
  const done = ctx.tx
    .update(schema.devices)
    .set({ revokedAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(schema.devices.id, id), isNull(schema.devices.revokedAt)))
    .run();
  if (done.changes === 0) return false;
  ctx.tx.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.deviceId, id)).run();
  emitChange(ctx, id, DeviceChange.Revoked);
  return true;
}
