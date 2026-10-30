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
    /** The project file a scan found the host in; left out for every other source. */
    readonly foundIn?: string | null;
  },
): PermissionRuleDto {
  const row: PermissionRuleDto = {
    id: mintId('PermissionRule'),
    ...input,
    foundIn: input.foundIn ?? null,
    createdAt: ctx.now,
  };
  ctx.tx
    .insert(schema.permissionRules)
    .values({ ...row, updatedAt: ctx.now })
    .run();
  return row;
}

/** The project's own rules and, when one is named, the workstream's. */
export function listPermissionRules(
  db: DbReader,
  projectId: ProjectId,
  workstreamId: WorkstreamId | null,
): PermissionRuleDto[] {
  const projectWide = isNull(schema.permissionRules.workstreamId);
  return db
    .select()
    .from(schema.permissionRules)
    .where(
      and(
        eq(schema.permissionRules.projectId, projectId),
        workstreamId === null
          ? projectWide
          : or(projectWide, eq(schema.permissionRules.workstreamId, workstreamId)),
      ),
    )
    .orderBy(asc(schema.permissionRules.createdAt), asc(schema.permissionRules.id))
    .all();
}

/** Removes the project-wide rules for one tool and pattern, however many copies; answers how many went. */
export function deleteProjectPermissionRules(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    readonly toolName: string;
    readonly pattern: string;
  },
): number {
  return ctx.tx
    .delete(schema.permissionRules)
    .where(
      and(
        eq(schema.permissionRules.projectId, input.projectId),
        isNull(schema.permissionRules.workstreamId),
        eq(schema.permissionRules.toolName, input.toolName),
        eq(schema.permissionRules.pattern, input.pattern),
      ),
    )
    .run().changes;
}
