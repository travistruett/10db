import { BatchId } from '@10db/contracts';

/** Where a local copy's teardown commits are kept; one ref per batch under it. */
export const COPY_REFS_PREFIX = 'refs/10db/copies/';

/** Keeps the commit a copy's teardown runs from reachable until the copy is retired. */
export function teardownRef(batchId: BatchId): string {
  return `${COPY_REFS_PREFIX}${batchId}/teardown`;
}

/** The batch a teardown ref belongs to; null for a ref that isn't one. */
export function batchOfTeardownRef(ref: string): BatchId | null {
  if (!ref.startsWith(COPY_REFS_PREFIX) || !ref.endsWith('/teardown')) return null;
  const parsed = BatchId.safeParse(ref.slice(COPY_REFS_PREFIX.length, -'/teardown'.length));
  return parsed.success ? parsed.data : null;
}
