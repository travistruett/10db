import type { BatchId } from '@10db/contracts';
import {
  deleteAppSetting,
  getAppSetting,
  setAppSetting,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';

// The fix tasks 10db has filed for one batch's failing ship gate, and how many it may file before it
// asks the builder.

export const gateFixKey = (batchId: BatchId): string => `gate_fix.${batchId}`;

export const GateFix = z.object({
  /** Fix tasks filed for this batch's gate. */
  count: z.number().int().nonnegative(),
  allowed: z.number().int().nonnegative(),
  /** The failure the last fix task was filed for. */
  signature: z.string().nullable(),
  /** The builder asked for a fix of an outside failure. */
  forceInside: z.boolean(),
});
export type GateFix = z.infer<typeof GateFix>;

/** The batch's gate fixes; unset or unreadable reads as none filed and `maxFixAttempts` allowed. */
export function readGateFix(db: DbReader, batchId: BatchId, maxFixAttempts: number): GateFix {
  // Read from the database: parsed, as at every boundary.
  const stored = GateFix.safeParse(getAppSetting(db, gateFixKey(batchId)));
  if (stored.success) return stored.data;
  return { count: 0, allowed: maxFixAttempts, signature: null, forceInside: false };
}

/** Counts one more fix task, filed for the failure `signature`. */
export function recordFix(
  w: WriteContext,
  batchId: BatchId,
  signature: string | null,
  max: number,
): void {
  const cur = readGateFix(w.tx, batchId, max);
  setAppSetting(w, gateFixKey(batchId), {
    ...cur,
    count: cur.count + 1,
    signature,
    forceInside: false,
  });
}

/** Allows `max` more fix tasks, as the builder asked. */
export function grantMore(
  w: WriteContext,
  batchId: BatchId,
  max: number,
  forceInside: boolean,
): void {
  const cur = readGateFix(w.tx, batchId, max);
  // The builder asked for more, so the next failure gets a fix even when it is the one that stopped the loop.
  setAppSetting(w, gateFixKey(batchId), {
    ...cur,
    allowed: cur.allowed + max,
    signature: null,
    forceInside,
  });
}

/** Forgets the batch's gate fixes, once the batch ships or is abandoned. */
export function clearGateFix(w: WriteContext, batchId: BatchId): void {
  deleteAppSetting(w, gateFixKey(batchId));
}
