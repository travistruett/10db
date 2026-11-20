import { mintId, ShapeProposalState, type ShapeAcceptId, type ShapeId } from '@10db/contracts';
import { and, desc, eq, isNull } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';
import type { ShapeProposalRow } from './shape-state';

// An Accept of a plan (shape spec §5): one record per Accept, so Undo Accept takes back exactly
// what it wrote. The writes that use these emit `shape.changed` already, so none emits an event.

export type ShapeAcceptRow = typeof schema.shapeAccepts.$inferSelect;

export function insertShapeAccept(ctx: WriteContext, shapeId: ShapeId): ShapeAcceptRow {
  const row = {
    id: mintId('ShapeAccept'),
    shapeId,
    undoneAt: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.shapeAccepts).values(row).run();
  return row;
}

/** The newest Accept of the plan that is not undone, or undefined. */
export function latestShapeAccept(db: DbReader, shapeId: ShapeId): ShapeAcceptRow | undefined {
  return db
    .select()
    .from(schema.shapeAccepts)
    .where(and(eq(schema.shapeAccepts.shapeId, shapeId), isNull(schema.shapeAccepts.undoneAt)))
    .orderBy(desc(schema.shapeAccepts.createdAt), desc(schema.shapeAccepts.id))
    .limit(1)
    .get();
}

export function markShapeAcceptUndone(ctx: WriteContext, id: ShapeAcceptId): void {
  ctx.tx
    .update(schema.shapeAccepts)
    .set({ undoneAt: ctx.now, updatedAt: ctx.now })
    .where(eq(schema.shapeAccepts.id, id))
    .run();
}

/** The proposals an Accept accepted that are still accepted under it. */
export function listAcceptedProposals(db: DbReader, id: ShapeAcceptId): ShapeProposalRow[] {
  return db
    .select()
    .from(schema.shapeProposals)
    .where(
      and(
        eq(schema.shapeProposals.acceptId, id),
        eq(schema.shapeProposals.state, ShapeProposalState.Accepted),
      ),
    )
    .all();
}
