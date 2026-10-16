import {
  mintId,
  type InboxItemId,
  type PermissionRuleDto,
  type ProjectId,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export function insertPermissionRule(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    readonly workstreamId: WorkstreamId | null;
    readonly toolName: string;
    readonly pattern: string | null;
    readonly sourceInboxId: InboxItemId | null;
  },
): PermissionRuleDto {
  const row: PermissionRuleDto = { id: mintId('PermissionRule'), ...input, createdAt: ctx.now };
  ctx.tx
    .insert(schema.permissionRules)
    .values({ ...row, updatedAt: ctx.now })
    .run();
  return row;
}

export function listPermissionRules(
  db: DbReader,
  projectId: ProjectId,
  workstreamId: WorkstreamId,
): PermissionRuleDto[] {
  return db
    .select()
    .from(schema.permissionRules)
    .where(
      and(
        eq(schema.permissionRules.projectId, projectId),
        or(
          isNull(schema.permissionRules.workstreamId),
          eq(schema.permissionRules.workstreamId, workstreamId),
        ),
      ),
    )
    .orderBy(asc(schema.permissionRules.createdAt), asc(schema.permissionRules.id))
    .all();
}
