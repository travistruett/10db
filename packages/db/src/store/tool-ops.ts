import {
  currentStep,
  mintId,
  type SessionId,
  type StepPosition,
  type WorkstreamId,
} from '@10db/contracts';
import { and, count, desc, eq, gt, inArray } from 'drizzle-orm';
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
 * The commits the workstreams made through the commit tool: the `sha` each recorded call returned.
 * A call whose result holds no sha is skipped.
 */
export function commitShasOf(db: DbReader, workstreamIds: readonly WorkstreamId[]): string[] {
  if (workstreamIds.length === 0) return [];
  const shas = new Set<string>();
  const rows = db
    .select({ result: schema.toolOps.result })
    .from(schema.toolOps)
    .where(
      and(
        inArray(schema.toolOps.workstreamId, [...workstreamIds]),
        eq(schema.toolOps.tool, 'commit'),
      ),
    )
    .all();
  for (const { result } of rows) {
    const sha =
      typeof result === 'object' && result !== null && !Array.isArray(result)
        ? result['sha']
        : undefined;
    if (typeof sha === 'string') shas.add(sha);
  }
  return [...shas];
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
