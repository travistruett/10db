import {
  EventType,
  mintId,
  NotFoundError,
  TaskStatus,
  type DesignCheckDto,
  type DesignCheckId,
  type DesignCheckPurpose,
  type DesignCheckShot,
  type ProjectId,
  type ShapeAttachmentId,
  type ShapeId,
  type TaskId,
} from '@10db/contracts';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

// Plan-in-sessions spec §4: a mock-up drawn and its page shot as it is now, kept with the verdict. The
// daemon writes the pictures' files, named by their hash, before it calls these.

export type DesignCheckRow = typeof schema.designChecks.$inferSelect;

export interface NewDesignCheck {
  readonly projectId: ProjectId;
  readonly shapeId: ShapeId | null;
  readonly taskId: TaskId | null;
  readonly attachmentId: ShapeAttachmentId;
  readonly purpose: DesignCheckPurpose;
  readonly mockupSha256: string | null;
  readonly shots: readonly DesignCheckShot[];
  readonly designMdPath: string | null;
}

function toDto(row: DesignCheckRow): DesignCheckDto {
  return {
    id: row.id,
    projectId: row.projectId,
    shapeId: row.shapeId,
    taskId: row.taskId,
    attachmentId: row.attachmentId,
    purpose: row.purpose,
    mockupSha256: row.mockupSha256,
    shots: row.shots,
    designMdPath: row.designMdPath,
    verdict: row.verdict,
    createdAt: row.createdAt,
  };
}

/** Keeps a check; a lane's also appends `task.changed`, which the task's drawer follows. */
export function insertDesignCheck(ctx: WriteContext, input: NewDesignCheck): DesignCheckDto {
  const row: DesignCheckRow = {
    id: mintId('DesignCheck'),
    ...input,
    shots: [...input.shots],
    verdict: null,
    createdAt: ctx.now,
  };
  ctx.tx.insert(schema.designChecks).values(row).run();
  if (row.taskId !== null)
    ctx.emit({
      type: EventType.TaskChanged,
      entityType: 'task',
      entityId: row.taskId,
      data: { designCheckId: row.id },
    });
  return toDto(row);
}

export function getDesignCheck(db: DbReader, id: DesignCheckId): DesignCheckDto {
  const row = db.select().from(schema.designChecks).where(eq(schema.designChecks.id, id)).get();
  if (!row) throw new NotFoundError('design check', id);
  return toDto(row);
}

/** The task's newest check, or null. */
export function latestTaskDesignCheck(db: DbReader, taskId: TaskId): DesignCheckDto | null {
  const row = db
    .select()
    .from(schema.designChecks)
    .where(eq(schema.designChecks.taskId, taskId))
    .orderBy(desc(schema.designChecks.createdAt), desc(schema.designChecks.id))
    .get();
  return row ? toDto(row) : null;
}

/** Records what the agent says still differs, on the check it just ran. */
export function setDesignCheckVerdict(
  ctx: WriteContext,
  id: DesignCheckId,
  verdict: string,
): DesignCheckDto {
  ctx.tx.update(schema.designChecks).set({ verdict }).where(eq(schema.designChecks.id, id)).run();
  const row = ctx.tx.select().from(schema.designChecks).where(eq(schema.designChecks.id, id)).get();
  if (!row) throw new NotFoundError('design check', id);
  if (row.taskId !== null)
    ctx.emit({
      type: EventType.TaskChanged,
      entityType: 'task',
      entityId: row.taskId,
      data: { designCheckId: row.id },
    });
  return toDto(row);
}

/** Whether a check names the file of `sha256`, as its mock-up or a shot; a file nothing names may go. */
export function designCheckNames(db: DbReader, sha256: string): boolean {
  return (
    db
      .select({ id: schema.designChecks.id })
      .from(schema.designChecks)
      .where(
        sql`${schema.designChecks.mockupSha256} = ${sha256} OR EXISTS (
          SELECT 1 FROM json_each(${schema.designChecks.shots}) AS shot
          WHERE json_extract(shot.value, '$.sha256') = ${sha256}
        )`,
      )
      .get() !== undefined
  );
}

/**
 * Every check with when it can go: its task's finish when it has one (read from its last update, as the
 * pruning of turn pictures does), else its own making.
 */
export function listDesignChecksForPruning(db: DbReader): {
  readonly id: DesignCheckId;
  readonly createdAt: string;
  readonly taskDoneAt: string | null;
  readonly hasTask: boolean;
}[] {
  return db
    .select({
      id: schema.designChecks.id,
      createdAt: schema.designChecks.createdAt,
      taskId: schema.designChecks.taskId,
      status: schema.tasks.status,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.designChecks)
    .leftJoin(schema.tasks, eq(schema.tasks.id, schema.designChecks.taskId))
    .all()
    .map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      hasTask: r.taskId !== null,
      taskDoneAt:
        r.status === TaskStatus.Done || r.status === TaskStatus.Cancelled ? r.updatedAt : null,
    }));
}

/** Deletes checks; answers the hashes their rows named, whose files may now go. */
export function deleteDesignChecks(ctx: WriteContext, ids: readonly DesignCheckId[]): string[] {
  if (ids.length === 0) return [];
  const rows = ctx.tx
    .select()
    .from(schema.designChecks)
    .where(inArray(schema.designChecks.id, [...ids]))
    .all();
  ctx.tx
    .delete(schema.designChecks)
    .where(inArray(schema.designChecks.id, [...ids]))
    .run();
  return [
    ...new Set(
      rows.flatMap((r) => [
        ...(r.mockupSha256 === null ? [] : [r.mockupSha256]),
        ...r.shots.flatMap((s) => (s.sha256 === null ? [] : [s.sha256])),
      ]),
    ),
  ];
}
