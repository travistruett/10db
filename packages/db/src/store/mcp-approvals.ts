import { McpVerdict, type McpApprovalDto, type ProjectId } from '@10db/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

/** Records the builder's verdict on one exact server config. A second answer for the same config replaces the first. */
export function recordMcpApproval(
  ctx: WriteContext,
  input: Omit<McpApprovalDto, 'updatedAt'>,
): McpApprovalDto {
  const row: McpApprovalDto = {
    ...input,
    variables: [...input.variables],
    hosts: [...input.hosts],
    updatedAt: ctx.now,
  };
  ctx.tx
    .insert(schema.mcpServerApprovals)
    .values(row)
    .onConflictDoUpdate({
      target: [
        schema.mcpServerApprovals.projectId,
        schema.mcpServerApprovals.serverName,
        schema.mcpServerApprovals.configHash,
      ],
      set: {
        verdict: row.verdict,
        variables: row.variables,
        hosts: row.hosts,
        sourceInboxId: row.sourceInboxId,
        updatedAt: row.updatedAt,
      },
    })
    .run();
  return row;
}

/**
 * The builder's latest approval of a server under any config, or null when they never approved one: what
 * a changed config is compared with, so its card can say what is new.
 */
export function getLatestApprovedMcpApproval(
  db: DbReader,
  projectId: ProjectId,
  serverName: string,
): McpApprovalDto | null {
  const t = schema.mcpServerApprovals;
  return (
    db
      .select()
      .from(t)
      .where(
        and(
          eq(t.projectId, projectId),
          eq(t.serverName, serverName),
          eq(t.verdict, McpVerdict.Approved),
        ),
      )
      // Answers inside one clock tick share a time; the row written later has the larger rowid.
      .orderBy(desc(t.updatedAt), sql`${t}.rowid desc`)
      .get() ?? null
  );
}

export function getMcpApproval(
  db: DbReader,
  projectId: ProjectId,
  serverName: string,
  configHash: string,
): McpApprovalDto | null {
  const t = schema.mcpServerApprovals;
  return (
    db
      .select()
      .from(t)
      .where(
        and(eq(t.projectId, projectId), eq(t.serverName, serverName), eq(t.configHash, configHash)),
      )
      .get() ?? null
  );
}
