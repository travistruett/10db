import {
  ClaimKind,
  EventType,
  hazardScope,
  HazardScope,
  mintId,
  type BatchId,
  type ProjectDto,
  type ProjectId,
  type TaskDto,
  type WorkstreamId,
} from '@10db/contracts';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export type ClaimRow = typeof schema.claims.$inferSelect;

export interface ClaimRequest {
  readonly kind: ClaimKind;
  readonly name: string;
}

export type AcquireResult =
  | { readonly ok: true; readonly claims: ClaimRow[] }
  | {
      readonly ok: false;
      readonly conflict: {
        readonly kind: ClaimKind;
        readonly name: string;
        readonly heldBy: WorkstreamId;
      };
    };

/** A task's areas become area claims, except names that are project hazards, which are exclusive hazard claims. */
export function claimRequestsForTask(
  task: Pick<TaskDto, 'areas'>,
  project: Pick<ProjectDto, 'hazards'>,
): ClaimRequest[] {
  const hazards = new Set(project.hazards.map((h) => h.name));
  return task.areas.map((name) => ({
    kind: hazards.has(name) ? ClaimKind.Hazard : ClaimKind.Area,
    name,
  }));
}

/** The names of the project's hazards that are exclusive per copy of the repository, not per project. */
export function copyHazardNames(project: Pick<ProjectDto, 'hazards'>): Set<string> {
  return new Set(
    project.hazards.filter((h) => hazardScope(h) === HazardScope.Copy).map((h) => h.name),
  );
}

/**
 * An area, and a per-copy hazard, is exclusive within its batch when it has a worktree, else within the
 * project (one shared checkout is one copy); any other hazard within the project.
 */
function scopeOf(
  request: ClaimRequest,
  input: {
    readonly projectId: ProjectId;
    readonly areaScope?: BatchId;
    readonly copyHazards?: ReadonlySet<string>;
  },
): ProjectId | BatchId {
  const perCopy =
    request.kind === ClaimKind.Area || (input.copyHazards?.has(request.name) ?? false);
  return perCopy ? (input.areaScope ?? input.projectId) : input.projectId;
}

function activeHolder(
  db: DbReader,
  scope: ProjectId | BatchId,
  request: ClaimRequest,
): ClaimRow | undefined {
  return db
    .select()
    .from(schema.claims)
    .where(
      and(
        eq(schema.claims.scope, scope),
        eq(schema.claims.kind, request.kind),
        eq(schema.claims.name, request.name),
        isNull(schema.claims.releasedAt),
      ),
    )
    .get();
}

/** Grants every requested claim or none. Active claims never overlap (spec §8.1). */
export function acquireClaims(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    readonly workstreamId: WorkstreamId;
    readonly requests: readonly ClaimRequest[];
    readonly leaseExpiresAt: string;
    /** The batch whose copy these are; absent, areas and per-copy hazards are scoped to the project. */
    readonly areaScope?: BatchId;
    /** The hazards (`copyHazardNames`) exclusive per copy; any other hazard is exclusive across the project. */
    readonly copyHazards?: ReadonlySet<string>;
  },
): AcquireResult {
  const toInsert: ClaimRequest[] = [];
  const unique = new Map(input.requests.map((r) => [`${r.kind}:${r.name}`, r]));
  for (const request of unique.values()) {
    const holder = activeHolder(ctx.tx, scopeOf(request, input), request);
    if (holder && holder.workstreamId !== input.workstreamId) {
      return {
        ok: false,
        conflict: { kind: request.kind, name: request.name, heldBy: holder.workstreamId },
      };
    }
    if (!holder) toInsert.push(request);
  }
  for (const request of toInsert) {
    const id = mintId('Claim');
    ctx.tx
      .insert(schema.claims)
      .values({
        id,
        projectId: input.projectId,
        scope: scopeOf(request, input),
        workstreamId: input.workstreamId,
        kind: request.kind,
        name: request.name,
        exclusive: true,
        leaseExpiresAt: input.leaseExpiresAt,
        releasedAt: null,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .run();
    ctx.emit({
      type: EventType.ClaimAcquired,
      entityType: 'claim',
      entityId: id,
      data: { workstreamId: input.workstreamId, kind: request.kind, name: request.name },
    });
  }
  return { ok: true, claims: activeClaims(ctx.tx, input.workstreamId) };
}

export function releaseClaims(ctx: WriteContext, workstreamId: WorkstreamId): number {
  const held = activeClaims(ctx.tx, workstreamId);
  for (const claim of held) {
    ctx.tx
      .update(schema.claims)
      .set({ releasedAt: ctx.now, updatedAt: ctx.now })
      .where(eq(schema.claims.id, claim.id))
      .run();
    ctx.emit({
      type: EventType.ClaimReleased,
      entityType: 'claim',
      entityId: claim.id,
      data: { workstreamId, kind: claim.kind, name: claim.name },
    });
  }
  return held.length;
}

/** Releases the one claim `claimId`, leaving its workstream's others; false when it was not active. */
export function releaseClaim(ctx: WriteContext, claimId: ClaimRow['id']): boolean {
  const claim = ctx.tx
    .select()
    .from(schema.claims)
    .where(and(eq(schema.claims.id, claimId), isNull(schema.claims.releasedAt)))
    .get();
  if (!claim) return false;
  ctx.tx
    .update(schema.claims)
    .set({ releasedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(schema.claims.id, claim.id))
    .run();
  ctx.emit({
    type: EventType.ClaimReleased,
    entityType: 'claim',
    entityId: claim.id,
    data: { workstreamId: claim.workstreamId, kind: claim.kind, name: claim.name },
  });
  return true;
}

export function activeClaims(db: DbReader, workstreamId: WorkstreamId): ClaimRow[] {
  return db
    .select()
    .from(schema.claims)
    .where(and(eq(schema.claims.workstreamId, workstreamId), isNull(schema.claims.releasedAt)))
    .all();
}

export function renewClaimLeases(
  ctx: WriteContext,
  workstreamIds: readonly WorkstreamId[],
  expiresAt: string,
): void {
  if (workstreamIds.length === 0) return;
  ctx.tx
    .update(schema.claims)
    .set({ leaseExpiresAt: expiresAt, updatedAt: ctx.now })
    .where(
      and(
        inArray(schema.claims.workstreamId, [...workstreamIds]),
        isNull(schema.claims.releasedAt),
      ),
    )
    .run();
}
