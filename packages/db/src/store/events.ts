import { EventType, type DaemonEvent } from '@10db/contracts';
import { and, asc, eq, gt, max } from 'drizzle-orm';
import * as schema from '../schema';
import { toDaemonEvent, type DbReader } from './store';

export function listEventsAfter(db: DbReader, afterSeq: number, limit: number): DaemonEvent[] {
  return db
    .select()
    .from(schema.events)
    .where(gt(schema.events.seq, afterSeq))
    .orderBy(asc(schema.events.seq))
    .limit(limit)
    .all()
    .map(toDaemonEvent);
}

/**
 * The commits a workstream made through the commit tool, oldest first: the `sha` of each `commit.recorded`
 * event for it. A commit that was already there (`alreadyCommitted`) is listed too, once per recording.
 */
export function listWorkstreamCommitShas(db: DbReader, workstreamId: string): string[] {
  return db
    .select({ data: schema.events.data })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.type, EventType.CommitRecorded),
        eq(schema.events.entityType, 'workstream'),
        eq(schema.events.entityId, workstreamId),
      ),
    )
    .orderBy(asc(schema.events.seq))
    .all()
    .flatMap(({ data }) => (typeof data['sha'] === 'string' ? [data['sha']] : []));
}

export function latestEventSeq(db: DbReader): number {
  return (
    db
      .select({ seq: max(schema.events.seq) })
      .from(schema.events)
      .get()?.seq ?? 0
  );
}
