import {
  currentStep,
  mintId,
  type SessionId,
  type StepPosition,
  type WorkstreamId,
} from '@10db/contracts';
import { and, count, desc, eq, gt } from 'drizzle-orm';
import * as schema from '../schema';
import type { Json } from '../json';
import type { DbReader, WriteContext } from './store';

export function findToolOp(
  db: DbReader,
  workstreamId: WorkstreamId,
  opId: string,
): { tool: string; result: Json; sessionId: SessionId } | undefined {
  return db
    .select({
      tool: schema.toolOps.tool,
      result: schema.toolOps.result,
      sessionId: schema.toolOps.sessionId,
    })
    .from(schema.toolOps)
    .where(and(eq(schema.toolOps.workstreamId, workstreamId), eq(schema.toolOps.opId, opId)))
    .get();
}

/**
 * How many calls of a tool the workstream's current step has recorded, across every session
 * of the step (a handoff, re-launch or recovery starts a new session in the same step): the
 * sessions after the step's `sessionFloor`, as the runner counts them. A replayed opId is one
 * record, not two. A retry keeps the floor, so it does not reset the count.
 */
export function countStepToolOps(
  db: DbReader,
  ws: StepPosition & { readonly id: WorkstreamId },
  tool: string,
): number {
  const floor = currentStep(ws).sessionFloor;
  return (
    db
      .select({ n: count() })
      .from(schema.toolOps)
      .innerJoin(schema.sessions, eq(schema.sessions.id, schema.toolOps.sessionId))
      .where(
        and(
          eq(schema.toolOps.workstreamId, ws.id),
          eq(schema.toolOps.tool, tool),
          gt(schema.sessions.sequence, floor),
        ),
      )
      .get()?.n ?? 0
  );
}

export function insertToolOp(
  ctx: WriteContext,
  input: {
    readonly workstreamId: WorkstreamId;
    readonly sessionId: SessionId;
    readonly opId: string;
    readonly tool: string;
    readonly result: Json;
  },
): void {
  ctx.tx
    .insert(schema.toolOps)
    .values({ id: mintId('ToolOp'), ...input, createdAt: ctx.now })
    .run();
}

/**
 * Gives an opId's record to a new session and result. An opId is unique per workstream, so a call
 * that must run again under an opId an earlier session used takes over its row instead of adding one.
 */
export function replaceToolOp(
  ctx: WriteContext,
  input: {
    readonly workstreamId: WorkstreamId;
    readonly sessionId: SessionId;
    readonly opId: string;
    readonly tool: string;
    readonly result: Json;
  },
): void {
  ctx.tx
    .update(schema.toolOps)
    .set({ sessionId: input.sessionId, tool: input.tool, result: input.result, createdAt: ctx.now })
    .where(
      and(eq(schema.toolOps.workstreamId, input.workstreamId), eq(schema.toolOps.opId, input.opId)),
    )
    .run();
}

export function latestToolOp(
  db: DbReader,
  workstreamId: WorkstreamId,
): { opId: string; tool: string; createdAt: string } | undefined {
  return db
    .select({
      opId: schema.toolOps.opId,
      tool: schema.toolOps.tool,
      createdAt: schema.toolOps.createdAt,
    })
    .from(schema.toolOps)
    .where(eq(schema.toolOps.workstreamId, workstreamId))
    .orderBy(desc(schema.toolOps.id))
    .limit(1)
    .get();
}
