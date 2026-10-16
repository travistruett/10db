import type { DaemonEvent } from '@10db/contracts';
import { asc, gt } from 'drizzle-orm';
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
