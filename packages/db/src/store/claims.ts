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

/**
 * The workstream holding the claim `request` names, as `acquireClaims` looks for it in the same
 * scope, or null while it is free. Reads only: a caller whose grant needs more than one write learns
 * here, without granting, whether the claim is free.
 */
export function claimHolder(
  db: DbReader,
  input: {
    readonly projectId: ProjectId;
    readonly request: ClaimRequest;
    readonly areaScope?: BatchId;
    readonly copyHazards?: ReadonlySet<string>;
  },
): WorkstreamId | null {
  return activeHolder(db, scopeOf(input.request, input), input.request)?.workstreamId ?? null;
}

/** What a workstream asks to claim, and where. */
export interface ClaimAsk {
  readonly projectId: ProjectId;
  readonly workstreamId: WorkstreamId;
  readonly requests: readonly ClaimRequest[];
  /** The batch whose copy these are; absent, areas and per-copy hazards are scoped to the project. */
  readonly areaScope?: BatchId;
  /** The hazards (`copyHazardNames`) exclusive per copy; any other hazard is exclusive across the project. */
  readonly copyHazards?: ReadonlySet<string>;
}

const uniqueRequests = (requests: readonly ClaimRequest[]): ClaimRequest[] => [
  ...new Map(requests.map((r) => [`${r.kind}:${r.name}`, r])).values(),
];

/**
 * The first requested claim another workstream holds, or null when `acquireClaims` would grant them
 * all now. Reads only, for a caller that must know before it acts on the workstream's checkout.
 */
export function claimConflict(
  db: DbReader,
  input: ClaimAsk,
): Extract<AcquireResult, { ok: false }>['conflict'] | null {
  for (const request of uniqueRequests(input.requests)) {
    const holder = activeHolder(db, scopeOf(request, input), request);
    if (holder && holder.workstreamId !== input.workstreamId)
      return { kind: request.kind, name: request.name, heldBy: holder.workstreamId };
  }
  return null;
}

/** Grants every requested claim or none. Active claims never overlap (spec §8.1). */
export function acquireClaims(
  ctx: WriteContext,
  input: ClaimAsk & { readonly leaseExpiresAt: string },
): AcquireResult {
  const conflict = claimConflict(ctx.tx, input);
  if (conflict !== null) return { ok: false, conflict };
  const toInsert = uniqueRequests(input.requests).filter(
    (request) => !activeHolder(ctx.tx, scopeOf(request, input), request),
  );
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

/**
 * The workstream holding the area in the project's own checkout, where a pass's pages are claimed, or
 * undefined while none does. A claim in a separate copy is that copy's and is not this one.
 */
export function folderAreaHolder(
  db: DbReader,
  projectId: ProjectId,
  area: string,
): WorkstreamId | undefined {
  return activeHolder(db, projectId, { kind: ClaimKind.Area, name: area })?.workstreamId;
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
