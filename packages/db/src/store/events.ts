import { EventType, type DaemonEvent } from '@10db/contracts';
import { and, asc, eq, gt, max, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { toDaemonEvent, type DbReader, type WriteContext } from './store';

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

/**
 * Deletes up to `limit` session.context and session.activity rows of sessions whose task was done or cancelled
 * before `cutoff` (ISO) and that ended before it or never ended; answers how many. A row is also kept unless
 * `e.at < cutoff`, so no young event goes whatever the task and session rows say. The joins are `CROSS JOIN`
 * from `tasks` to pin the order (tasks, workstreams, sessions, then `events_entity_idx`) without table
 * statistics, so the planner never scans `events` first inside the write lock.
 */
export function deleteSessionEventsEndedBefore(
  ctx: WriteContext,
  cutoff: string,
  limit: number,
): number {
  return ctx.tx.run(sql`
    DELETE FROM events WHERE seq IN (
      SELECT e.seq FROM tasks t
      CROSS JOIN workstreams w ON w.task_id = t.id
      CROSS JOIN sessions s ON s.workstream_id = w.id
      CROSS JOIN events e ON e.entity_type = 'session' AND e.entity_id = s.id
        AND e.type IN (${EventType.SessionContext}, ${EventType.SessionActivity})
      WHERE t.status IN ('done', 'cancelled') AND t.updated_at < ${cutoff}
        AND (s.ended_at IS NULL OR s.ended_at < ${cutoff})
        AND e.at < ${cutoff}
      LIMIT ${limit}
    )`).changes;
}
