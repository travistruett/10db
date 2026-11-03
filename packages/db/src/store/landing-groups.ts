import {
  ConflictError,
  EventType,
  mintId,
  NotFoundError,
  type LandingGroupDto,
  type LandingGroupId,
  type ProjectId,
  type ShapeId,
  type TaskId,
} from '@10db/contracts';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

// Shape spec §10.4. A landing group is the tasks that land in one pull request: starting them
// together makes one batch, and a task of the group started later joins that batch while it is open.

function toDto(row: typeof schema.landingGroups.$inferSelect): LandingGroupDto {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    shapeId: row.shapeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getLandingGroup(db: DbReader, id: LandingGroupId): LandingGroupDto {
  const row = db.select().from(schema.landingGroups).where(eq(schema.landingGroups.id, id)).get();
  if (!row) throw new NotFoundError('landing group', id);
  return toDto(row);
}

/** The project's landing groups, oldest first. */
export function listLandingGroups(db: DbReader, projectId: ProjectId): LandingGroupDto[] {
  return db
    .select()
    .from(schema.landingGroups)
    .where(eq(schema.landingGroups.projectId, projectId))
    .orderBy(schema.landingGroups.createdAt, schema.landingGroups.id)
    .all()
    .map(toDto);
}

/**
 * Writes a landing group and puts its tasks in it. A task that is already in a group, or belongs to
 * another project, is refused and nothing is written. The tasks keep the placement and landing they
 * have: the group does not move them, and starting them refuses a mix (`sharedLanding`).
 */
export function insertLandingGroup(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly taskIds: readonly TaskId[];
    readonly shapeId?: ShapeId;
  },
): LandingGroupDto {
  const tasks =
    input.taskIds.length === 0
      ? []
      : ctx.tx
          .select({
            id: schema.tasks.id,
            title: schema.tasks.title,
            projectId: schema.tasks.projectId,
            landingGroupId: schema.tasks.landingGroupId,
          })
          .from(schema.tasks)
          .where(inArray(schema.tasks.id, [...input.taskIds]))
          .all();
  if (tasks.length !== new Set(input.taskIds).size)
    throw new NotFoundError('task', input.taskIds.join(', '));
  for (const task of tasks) {
    if (task.projectId !== input.projectId)
      throw new ConflictError(`${task.title} belongs to another project`);
    if (task.landingGroupId !== null)
      throw new ConflictError(`${task.title} is already in a landing`);
  }
  const row = {
    id: mintId('LandingGroup'),
    projectId: input.projectId,
    title: input.title,
    shapeId: input.shapeId ?? null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.landingGroups).values(row).run();
  if (tasks.length > 0)
    ctx.tx
      .update(schema.tasks)
      .set({ landingGroupId: row.id, updatedAt: ctx.now })
      .where(inArray(schema.tasks.id, [...input.taskIds]))
      .run();
  for (const task of tasks)
    ctx.emit({
      type: EventType.TaskChanged,
      entityType: 'task',
      entityId: task.id,
      data: { landingGroupId: row.id },
    });
  return toDto(row);
}
