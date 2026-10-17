import type { DaemonEvent } from '@10db/contracts';
import { asc, gt, max } from 'drizzle-orm';
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

export function latestEventSeq(db: DbReader): number {
  return (
    db
      .select({ seq: max(schema.events.seq) })
      .from(schema.events)
      .get()?.seq ?? 0
  );
}
