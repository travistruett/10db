import {
  currentStep,
  mintId,
  type SessionId,
  type StepPosition,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, count, desc, eq, gt, gte } from 'drizzle-orm';
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

/** Whether any session of the workstream has recorded a call of the tool. */
export function hasToolOp(db: DbReader, workstreamId: WorkstreamId, tool: string): boolean {
  return (
    db
      .select({ id: schema.toolOps.id })
      .from(schema.toolOps)
      .where(and(eq(schema.toolOps.workstreamId, workstreamId), eq(schema.toolOps.tool, tool)))
      .limit(1)
      .get() !== undefined
  );
}

/**
 * What every recorded call of the tool by any session of the workstream returned, oldest first. With
 * `since`, only the calls recorded at or after that time.
 */
export function listToolOpResults(
  db: DbReader,
  workstreamId: WorkstreamId,
  tool: string,
  since?: string,
): Json[] {
  return db
    .select({ result: schema.toolOps.result })
    .from(schema.toolOps)
    .where(
      and(
        eq(schema.toolOps.workstreamId, workstreamId),
        eq(schema.toolOps.tool, tool),
        since === undefined ? undefined : gte(schema.toolOps.createdAt, since),
      ),
    )
    .orderBy(asc(schema.toolOps.createdAt), asc(schema.toolOps.id))
    .all()
    .map((row) => row.result);
}

/**
 * Every recorded call of the tool by any session of the workstream with its id, oldest first. The id
 * sorts against other records' ids (they are time-ordered), so a call can be placed among the
 * workstream's evidence without comparing timestamps that two writes in a millisecond share.
 */
export function listToolOps(
  db: DbReader,
  workstreamId: WorkstreamId,
  tool: string,
): { id: string; result: Json }[] {
  return db
    .select({ id: schema.toolOps.id, result: schema.toolOps.result })
    .from(schema.toolOps)
    .where(and(eq(schema.toolOps.workstreamId, workstreamId), eq(schema.toolOps.tool, tool)))
    .orderBy(asc(schema.toolOps.id))
    .all();
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

/**
 * What each call of a tool recorded in the workstream's current step returned, counted the same way
 * as countStepToolOps (every session after the step's `sessionFloor`).
 */
export function listStepToolOpResults(
  db: DbReader,
  ws: StepPosition & { readonly id: WorkstreamId },
  tool: string,
): Json[] {
  const floor = currentStep(ws).sessionFloor;
  return db
    .select({ result: schema.toolOps.result })
    .from(schema.toolOps)
    .innerJoin(schema.sessions, eq(schema.sessions.id, schema.toolOps.sessionId))
    .where(
      and(
        eq(schema.toolOps.workstreamId, ws.id),
        eq(schema.toolOps.tool, tool),
        gt(schema.sessions.sequence, floor),
      ),
    )
    .all()
    .map((row) => row.result);
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
