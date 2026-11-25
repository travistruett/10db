import { EventType, type BatchId, type ProjectId, type WorkstreamId } from '@10db/contracts';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader } from './store';

/**
 * How long a project's recent passing runs of `command` took, newest first, from the `gate.finished`
 * events of its lanes' gates and its batches' shipping gates. A run that failed, timed out or was
 * stopped says nothing of how long a pass takes.
 */
export function passingGateDurations(
  db: DbReader,
  projectId: ProjectId,
  command: string,
  limit: number,
): number[] {
  const rows = db
    .select({ durationMs: sql<number>`json_extract(${schema.events.data}, '$.durationMs')` })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.type, EventType.GateFinished),
        sql`json_extract(${schema.events.data}, '$.projectId') = ${projectId}`,
        sql`json_extract(${schema.events.data}, '$.command') = ${command}`,
        sql`json_extract(${schema.events.data}, '$.exitCode') = 0`,
        sql`json_extract(${schema.events.data}, '$.aborted') = 0`,
      ),
    )
    .orderBy(desc(schema.events.seq))
    .limit(limit)
    .all();
  return rows.map((r) => r.durationMs).filter((ms) => typeof ms === 'number' && ms > 0);
}

/** A gate process that is running now: whose it is, for a line that says what an update waits for. */
export interface RunningGate {
  readonly kind: 'task' | 'batch';
  readonly id: WorkstreamId | BatchId;
  readonly title: string;
}

/** The gates with a live process: a lane's verify gate and a batch's shipping gate. */
export function listRunningGates(db: DbReader): RunningGate[] {
  const lanes = db
    .select({ id: schema.workstreams.id, title: schema.tasks.title })
    .from(schema.workstreams)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.workstreams.taskId))
    .where(isNotNull(schema.workstreams.gatePid))
    .all()
    .map((r): RunningGate => ({ kind: 'task', id: r.id, title: r.title }));
  const batches = db
    .select({ id: schema.batches.id, title: schema.batches.title })
    .from(schema.batches)
    .where(isNotNull(schema.batches.gatePid))
    .all()
    .map((r): RunningGate => ({ kind: 'batch', id: r.id, title: r.title }));
  return [...lanes, ...batches];
}
