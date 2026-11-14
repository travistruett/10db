import {
  BundleOrigin,
  EventType,
  mintId,
  NotFoundError,
  ShapeState,
  type ProjectId,
  type ShapeDto,
  type ShapeId,
  type ShapeOrigin,
} from '@10db/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';

// Shape spec docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md §13. The daemon's
// shape module owns the conversation's state; these are its rows.

type ShapeRow = typeof schema.shapes.$inferSelect;

const toShapeDto = (row: ShapeRow): ShapeDto => ({
  id: row.id,
  projectId: row.projectId,
  title: row.title,
  state: row.state,
  origin: row.origin,
  proposeUnlocked: row.proposeUnlocked,
  round: row.round,
  model: row.model,
  effort: row.effort,
  importedAt: row.importedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Writes a conversation that is listening: no proposal yet, Propose still locked. An imported Plan
 * gives its state, round and bundle.
 */
export function insertShape(
  ctx: WriteContext,
  projectId: ProjectId,
  input: {
    readonly title: string;
    readonly origin: ShapeOrigin;
    readonly state?: ShapeState;
    readonly round?: number;
    readonly bundleId?: string | null;
    readonly bundleOrigin?: BundleOrigin | null;
    readonly importedAt?: string | null;
  },
): ShapeDto {
  getProject(ctx.tx, projectId);
  const row: ShapeRow = {
    id: mintId('Shape'),
    projectId,
    title: input.title,
    state: input.state ?? ShapeState.Listening,
    origin: input.origin,
    sdkSessionId: null,
    proposeUnlocked: false,
    round: input.round ?? 0,
    model: null,
    effort: null,
    bundleId: input.bundleId ?? null,
    bundleOrigin: input.bundleOrigin ?? null,
    importedAt: input.importedAt ?? null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.shapes).values(row).run();
  ctx.emit({
    type: EventType.ShapeChanged,
    entityType: 'shape',
    entityId: row.id,
    data: { projectId },
  });
  return toShapeDto(row);
}

/** The Plan a bundle id was imported into in a project, if any. */
export function getShapeByBundle(
  db: DbReader,
  projectId: ProjectId,
  bundleId: string,
): ShapeDto | undefined {
  const row = db
    .select()
    .from(schema.shapes)
    .where(and(eq(schema.shapes.projectId, projectId), eq(schema.shapes.bundleId, bundleId)))
    .get();
  return row ? toShapeDto(row) : undefined;
}

/** Where an imported Plan's bundle was made; null for a conversation. */
export function getShapeBundleOrigin(db: DbReader, id: ShapeId): BundleOrigin | null {
  const row = db
    .select({ bundleOrigin: schema.shapes.bundleOrigin })
    .from(schema.shapes)
    .where(eq(schema.shapes.id, id))
    .get();
  return row?.bundleOrigin == null ? null : BundleOrigin.parse(row.bundleOrigin);
}

export function getShape(db: DbReader, id: ShapeId): ShapeDto {
  const row = db.select().from(schema.shapes).where(eq(schema.shapes.id, id)).get();
  if (!row) throw new NotFoundError('shape', id);
  return toShapeDto(row);
}

/**
 * The tokens a conversation has used so far (§4): input and output summed over every session it has
 * run, the same rows per-project usage reads. Cache reads are left out although they are not part of the
 * input (the daemon stores them apart, so adding them would be valid): Settings usage and the goal digest
 * leave them out too, and repeated cache reads across turns would swamp the number.
 */
export function shapeTokens(db: DbReader, id: ShapeId): number {
  const row = db
    .select({
      total: sql<number>`coalesce(sum(${schema.sessions.inputTokens} + ${schema.sessions.outputTokens}), 0)`,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.shapeId, id))
    .get();
  return row?.total ?? 0;
}

/** The project's conversations, oldest first. */
export function listShapes(db: DbReader, projectId: ProjectId): ShapeDto[] {
  return db
    .select()
    .from(schema.shapes)
    .where(eq(schema.shapes.projectId, projectId))
    .orderBy(asc(schema.shapes.createdAt), asc(schema.shapes.id))
    .all()
    .map(toShapeDto);
}
