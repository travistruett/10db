import { eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { Json } from '../json';
import type { DbReader, WriteContext } from './store';

function isJson(value: unknown): value is Json {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value === 'object') return Object.values(value).every(isJson);
  return false;
}

/** Returns the stored value, or undefined when the key is unset or its stored text is not JSON. */
export function getAppSetting(db: DbReader, key: string): Json | undefined {
  const row = db
    .select({ value: schema.appSettings.value })
    .from(schema.appSettings)
    .where(eq(schema.appSettings.key, key))
    .get();
  return isJson(row?.value) ? row.value : undefined;
}

export function setAppSetting(ctx: WriteContext, key: string, value: Json): void {
  ctx.tx
    .insert(schema.appSettings)
    .values({ key, value, updatedAt: ctx.now })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: ctx.now } })
    .run();
}

export function deleteAppSetting(ctx: WriteContext, key: string): void {
  ctx.tx.delete(schema.appSettings).where(eq(schema.appSettings.key, key)).run();
}
