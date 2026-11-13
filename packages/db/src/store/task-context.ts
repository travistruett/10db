import {
  EventType,
  mintId,
  type AnchorResult,
  type ShapeAttachmentRevisionId,
  type ShapeId,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '../schema';
import { getShape } from './shapes';
import type { DbReader, WriteContext } from './store';

// A task made from a Plan: the section it is pinned to, the Plan block its brief last carried, and the
// checks of the anchors it cites, per workstream and base commit.

export type TaskContextRow = typeof schema.taskContext.$inferSelect;
export type AnchorCheckRow = typeof schema.taskContextChecks.$inferSelect;

const Keys = z.array(z.string());

const contextOf = (row: TaskContextRow): TaskContextRow => ({
  ...row,
  shared: Keys.parse(row.shared),
  cites: Keys.parse(row.cites),
});

/** Pins a task to its revision and section; the packed columns are left as they are. */
export function upsertTaskContext(
  ctx: WriteContext,
  input: {
    readonly taskId: TaskId;
    readonly shapeId: ShapeId;
    readonly revisionId: ShapeAttachmentRevisionId;
    readonly section: string;
    readonly shared: readonly string[];
    readonly cites: readonly string[];
  },
): void {
  const pin = {
    shapeId: input.shapeId,
    revisionId: input.revisionId,
    section: input.section,
    shared: [...input.shared],
    cites: [...input.cites],
  };
  ctx.tx
    .insert(schema.taskContext)
    .values({
      taskId: input.taskId,
      ...pin,
      packedText: null,
      packedAt: null,
      packedWorkstreamId: null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoUpdate({ target: schema.taskContext.taskId, set: { ...pin, updatedAt: ctx.now } })
    .run();
  ctx.emit({
    type: EventType.PlanRecordChanged,
    entityType: 'shape',
    entityId: input.shapeId,
    data: {
      projectId: getShape(ctx.tx, input.shapeId).projectId,
      what: 'tasks',
      taskId: input.taskId,
    },
  });
}

export function getTaskContext(db: DbReader, taskId: TaskId): TaskContextRow | undefined {
  const row = db
    .select()
    .from(schema.taskContext)
    .where(eq(schema.taskContext.taskId, taskId))
    .get();
  return row ? contextOf(row) : undefined;
}

/**
 * Keeps the Plan block a lane's brief carried, verbatim. It emits nothing of its own: the caller writes
 * it in the same transaction as the `context.packed` event.
 */
export function markTaskContextPacked(
  ctx: WriteContext,
  taskId: TaskId,
  packed: { readonly text: string; readonly workstreamId: WorkstreamId },
): void {
  ctx.tx
    .update(schema.taskContext)
    .set({
      packedText: packed.text,
      packedAt: ctx.now,
      packedWorkstreamId: packed.workstreamId,
      updatedAt: ctx.now,
    })
    .where(eq(schema.taskContext.taskId, taskId))
    .run();
}

export interface NewAnchorCheck {
  readonly workstreamId: WorkstreamId;
  readonly entryKey: string;
  readonly entryVersion: number;
  readonly anchorIndex: number;
  readonly result: AnchorResult;
  readonly line: number | null;
  readonly checkedCommit: string;
  readonly note: string | null;
}

/** Appends one check run's rows and one `plan.anchor_checked`; no rows write nothing. */
export function insertAnchorChecks(
  ctx: WriteContext,
  taskId: TaskId,
  rows: readonly NewAnchorCheck[],
): void {
  const first = rows[0];
  if (first === undefined) return;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    ctx.tx
      .insert(schema.taskContextChecks)
      .values({ id: mintId('TaskContextCheck'), taskId, ...row, createdAt: ctx.now })
      .run();
    counts[row.result] = (counts[row.result] ?? 0) + 1;
  }
  ctx.emit({
    type: EventType.PlanAnchorChecked,
    entityType: 'task',
    entityId: taskId,
    data: { workstreamId: first.workstreamId, counts },
  });
}

/** One base's checks by a workstream, the newest per entry key, version and anchor. */
export function listAnchorChecks(
  db: DbReader,
  workstreamId: WorkstreamId,
  checkedCommit: string,
): AnchorCheckRow[] {
  const rows = db
    .select()
    .from(schema.taskContextChecks)
    .where(
      and(
        eq(schema.taskContextChecks.workstreamId, workstreamId),
        eq(schema.taskContextChecks.checkedCommit, checkedCommit),
      ),
    )
    .orderBy(desc(schema.taskContextChecks.id))
    .all();
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const key = JSON.stringify([row.entryKey, row.entryVersion, row.anchorIndex]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .reverse();
}

/** The checks of a task's newest check run: that workstream's rows at that base. */
export function latestAnchorChecksOfTask(db: DbReader, taskId: TaskId): AnchorCheckRow[] {
  const newest = db
    .select()
    .from(schema.taskContextChecks)
    .where(eq(schema.taskContextChecks.taskId, taskId))
    .orderBy(desc(schema.taskContextChecks.id))
    .get();
  return newest ? listAnchorChecks(db, newest.workstreamId, newest.checkedCommit) : [];
}
