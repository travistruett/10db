import {
  GrantTarget,
  mintId,
  type InboxItemId,
  type LimitName,
  type ProjectId,
  type TrustGrantDto,
  type TrustGrantId,
} from '@10db/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

type GrantRow = typeof schema.trustGrants.$inferSelect;

function toDto(row: GrantRow): TrustGrantDto {
  return {
    id: row.id,
    projectId: row.projectId,
    limit: row.limitName,
    target: row.target,
    createdAt: row.createdAt,
  };
}

/** Keeps a grant for a project. The target is parsed as one safe line first, so a bad one stores nothing. */
export function insertTrustGrant(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    readonly limit: LimitName | null;
    readonly target: string;
    readonly sourceInboxId: InboxItemId | null;
  },
): TrustGrantDto {
  const row: GrantRow = {
    id: mintId('TrustGrant'),
    projectId: input.projectId,
    limitName: input.limit,
    target: GrantTarget.parse(input.target),
    sourceInboxId: input.sourceInboxId,
    createdAt: ctx.now,
  };
  ctx.tx.insert(schema.trustGrants).values(row).run();
  return toDto(row);
}

/** A project's grants, oldest first. */
export function listTrustGrants(db: DbReader, projectId: ProjectId): TrustGrantDto[] {
  return db
    .select()
    .from(schema.trustGrants)
    .where(eq(schema.trustGrants.projectId, projectId))
    .orderBy(asc(schema.trustGrants.createdAt), asc(sql`trust_grants.rowid`))
    .all()
    .map(toDto);
}

/** Removes one of the project's grants; false when the project has no grant by that id. */
export function deleteTrustGrant(
  ctx: WriteContext,
  projectId: ProjectId,
  id: TrustGrantId,
): boolean {
  const result = ctx.tx
    .delete(schema.trustGrants)
    .where(and(eq(schema.trustGrants.id, id), eq(schema.trustGrants.projectId, projectId)))
    .run();
  return result.changes > 0;
}
