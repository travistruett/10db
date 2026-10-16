import { mintId, type SessionId, type WorkstreamId } from '@10db/contracts';
import { and, desc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { Json } from '../json';
import type { DbReader, WriteContext } from './store';

export function findToolOp(
  db: DbReader,
  workstreamId: WorkstreamId,
  opId: string,
): { tool: string; result: Json } | undefined {
  return db
    .select({ tool: schema.toolOps.tool, result: schema.toolOps.result })
    .from(schema.toolOps)
    .where(and(eq(schema.toolOps.workstreamId, workstreamId), eq(schema.toolOps.opId, opId)))
    .get();
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
