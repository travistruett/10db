import {
  mintId,
  WorkstreamState,
  type InboxItemId,
  type SkippedActionId,
  type WorkstreamId,
} from '@10db/contracts';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

// Trust line §5: the marks of each ended unattended run's Skipped while you were away item, so a
// crash or a retry neither loses one nor repeats it.

/**
 * Marks the run checked through `through`, the newest skip the item covered, and its config through
 * the commit `configHead` (null when the check read none), in the caller's write: the item's own, or
 * alone when there was nothing new to say (`inboxId` null).
 */
export function markListed(
  ctx: WriteContext,
  workstreamId: WorkstreamId,
  through: SkippedActionId | null,
  inboxId: InboxItemId | null,
  configHead: string | null,
): void {
  ctx.tx
    .insert(schema.skipListings)
    .values({
      id: mintId('SkipListing'),
      workstreamId,
      throughSkipId: through,
      inboxItemId: inboxId,
      configHead,
      createdAt: ctx.now,
    })
    .run();
}

/**
 * The commit the run's config was last read through, by its newest listing that read one; null when
 * none did, so the next check reads the run's config from its base.
 */
export function lastConfigHead(db: DbReader, workstreamId: WorkstreamId): string | null {
  const row = db
    .select({ head: schema.skipListings.configHead })
    .from(schema.skipListings)
    .where(
      and(
        eq(schema.skipListings.workstreamId, workstreamId),
        isNotNull(schema.skipListings.configHead),
      ),
    )
    .orderBy(desc(sql`rowid`))
    .limit(1)
    .get();
  return row?.head ?? null;
}

/** The newest skip the run's last listing covered; null when it covered none, undefined when the run has none. */
export function lastListed(
  db: DbReader,
  workstreamId: WorkstreamId,
): SkippedActionId | null | undefined {
  const row = db
    .select({ through: schema.skipListings.throughSkipId })
    .from(schema.skipListings)
    .where(eq(schema.skipListings.workstreamId, workstreamId))
    .orderBy(desc(sql`rowid`))
    .limit(1)
    .get();
  return row === undefined ? undefined : row.through;
}

/**
 * The runs that ended (`DONE` or `FAILED`) and were never checked, or that have skips after their
 * last listing: what the start-up sweep raises. A cancelled run is never listed.
 */
export function unlistedEndedRuns(db: DbReader): WorkstreamId[] {
  return db
    .select({ id: schema.workstreams.id })
    .from(schema.workstreams)
    .where(
      sql`${schema.workstreams.state} IN (${WorkstreamState.Done}, ${WorkstreamState.Failed}) AND (
        NOT EXISTS (SELECT 1 FROM skip_listings l WHERE l.workstream_id = ${schema.workstreams.id})
        OR EXISTS (
          SELECT 1 FROM skipped_actions s
          WHERE s.workstream_id = ${schema.workstreams.id}
          AND s.rowid > COALESCE((
            SELECT a.rowid FROM skip_listings l
            JOIN skipped_actions a ON a.id = l.through_skip_id
            WHERE l.workstream_id = ${schema.workstreams.id}
            ORDER BY l.rowid DESC LIMIT 1
          ), 0)
        )
      )`,
    )
    .orderBy(schema.workstreams.id)
    .all()
    .map((r) => r.id);
}
