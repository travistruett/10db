import type { McpApprovalDto, ProjectId } from '@10db/contracts';
import { and, eq } from 'drizzle-orm';
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
