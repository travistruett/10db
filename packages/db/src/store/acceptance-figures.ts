import {
  EventType,
  InboxKind,
  TaskStatus,
  type ProjectId,
  type WorkstreamId,
} from '@10db/contracts';
import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader } from './store';

// The counts the Board shows for acceptance, recomputed from the logs on each read.

const DAY_MS = 86_400_000;

/** What `step.changed` records as `sentBackBy` when the builder, not a check, sent the work back. */
const BUILDER_SENT_BACK = 'builder';

/**
 * What acceptance did for the project in the last `days` days: tasks that finished without an acceptance
 * card, runs sent back by a check (acceptance, review or QA), and acceptance cards that came to the builder.
 * Work in a Workbench pass is left out of the first two, as in the rigor figures.
 */
export function acceptanceFigures(
  db: DbReader,
  projectId: ProjectId,
  days: number,
  now: Date,
): { completed: number; sentBack: number; sentToYou: number } {
  const from = now.getTime() - days * DAY_MS;
  const inWindow = (iso: string): boolean => {
    const at = Date.parse(iso);
    return at >= from && at <= now.getTime();
  };

  const cards = db
    .select({ targets: schema.inboxItems.targets, createdAt: schema.inboxItems.createdAt })
    .from(schema.inboxItems)
    .where(
      and(
        eq(schema.inboxItems.projectId, projectId),
        eq(schema.inboxItems.kind, InboxKind.Acceptance),
      ),
    )
    .all();
  const sentToYou = cards.filter((c) => inWindow(c.createdAt)).length;
  const carded = new Set<WorkstreamId>(cards.flatMap((c) => c.targets.map((t) => t.workstreamId)));

  // The last change to done per task, and only for tasks that are done now.
  const doneTasks = db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.projectId, projectId),
        eq(schema.tasks.status, TaskStatus.Done),
        isNull(schema.tasks.passId),
        gte(schema.tasks.updatedAt, new Date(from).toISOString()),
      ),
    )
    .all()
    .map((t) => t.id);
  let completed = 0;
  if (doneTasks.length > 0) {
    const lastDone = new Map<string, number>();
    for (const e of db
      .select({ entityId: schema.events.entityId, data: schema.events.data, at: schema.events.at })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.entityType, 'task'),
          eq(schema.events.type, EventType.TaskChanged),
          inArray(schema.events.entityId, doneTasks),
        ),
      )
      .orderBy(schema.events.seq)
      .all()) {
      if (e.data['status'] === TaskStatus.Done) lastDone.set(e.entityId, Date.parse(e.at));
    }
    const runsOf = db
      .select({ taskId: schema.workstreams.taskId, id: schema.workstreams.id })
      .from(schema.workstreams)
      .where(inArray(schema.workstreams.taskId, doneTasks))
      .all();
    completed = doneTasks.filter((id) => {
      const at = lastDone.get(id);
      return (
        at !== undefined &&
        at >= from &&
        at <= now.getTime() &&
        !runsOf.some((r) => r.taskId === id && carded.has(r.id))
      );
    }).length;
  }

  const sentBack = db
    .select({ data: schema.events.data })
    .from(schema.events)
    .innerJoin(schema.workstreams, eq(schema.workstreams.id, schema.events.entityId))
    .leftJoin(schema.batches, eq(schema.batches.id, schema.workstreams.batchId))
    .where(
      and(
        eq(schema.events.entityType, 'workstream'),
        eq(schema.events.type, EventType.StepChanged),
        eq(schema.workstreams.projectId, projectId),
        isNull(schema.batches.passId),
        gte(schema.events.at, new Date(from).toISOString()),
        lte(schema.events.at, now.toISOString()),
      ),
    )
    .all()
    .filter((e) => {
      const by = e.data['sentBackBy'];
      return typeof by === 'string' && by !== BUILDER_SENT_BACK;
    }).length;

  return { completed, sentBack, sentToYou };
}
