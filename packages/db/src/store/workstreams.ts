import {
  ACTIVE_STATES,
  canTransition,
  ConflictError,
  EventType,
  LANE_STATES,
  mintId,
  NotFoundError,
  TaskStatus,
  WorkstreamState,
  type NextAction,
  type ProjectId,
  type Provider,
  type SessionId,
  type TaskId,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, count, eq, inArray, isNotNull, or, type SQL } from 'drizzle-orm';
import * as schema from '../schema';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';
import { getTask } from './tasks';

export class StaleFenceError extends Error {
  override readonly name = 'StaleFenceError';
  readonly workstreamId: WorkstreamId;
  constructor(workstreamId: WorkstreamId) {
    super(`Workstream ${workstreamId} is owned by a newer runner`);
    this.workstreamId = workstreamId;
  }
}

export type WorkstreamRow = typeof schema.workstreams.$inferSelect;

export interface WorkstreamPatch {
  readonly nextAction?: NextAction;
  readonly attempt?: number;
  readonly recoveryAttempts?: number;
  readonly currentSessionId?: SessionId | null;
  readonly contextPct?: number | null;
  readonly pausedUntil?: string | null;
  readonly failureReason?: string | null;
  readonly lastActivityAt?: string | null;
  readonly baseHead?: string;
  readonly gatePid?: number | null;
  readonly gatePidStart?: string | null;
}

export function getWorkstreamRow(db: DbReader, id: WorkstreamId): WorkstreamRow {
  const row = db.select().from(schema.workstreams).where(eq(schema.workstreams.id, id)).get();
  if (!row) throw new NotFoundError('workstream', id);
  return row;
}

function toDto(db: DbReader, row: WorkstreamRow): WorkstreamDto {
  const sessions = db
    .select({ n: count() })
    .from(schema.sessions)
    .where(eq(schema.sessions.workstreamId, row.id))
    .get();
  const task = db
    .select({ title: schema.tasks.title })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, row.taskId))
    .get();
  return {
    id: row.id,
    taskId: row.taskId,
    taskTitle: task?.title ?? '',
    projectId: row.projectId,
    state: row.state,
    nextAction: row.nextAction,
    attempt: row.attempt,
    recoveryAttempts: row.recoveryAttempts,
    model: row.model,
    effort: row.effort,
    currentSessionId: row.currentSessionId,
    sessionCount: sessions?.n ?? 0,
    contextPct: row.contextPct,
    pausedUntil: row.pausedUntil,
    failureReason: row.failureReason,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getWorkstream(db: DbReader, id: WorkstreamId): WorkstreamDto {
  return toDto(db, getWorkstreamRow(db, id));
}

export function listWorkstreams(
  db: DbReader,
  filter: { states?: readonly WorkstreamState[]; projectId?: ProjectId } = {},
): WorkstreamDto[] {
  const where: SQL[] = [];
  if (filter.states) where.push(inArray(schema.workstreams.state, [...filter.states]));
  if (filter.projectId) where.push(eq(schema.workstreams.projectId, filter.projectId));
  return db
    .select()
    .from(schema.workstreams)
    .where(and(...where))
    .orderBy(asc(schema.workstreams.createdAt), asc(schema.workstreams.id))
    .all()
    .map((r) => toDto(db, r));
}

export function insertWorkstream(ctx: WriteContext, taskId: TaskId): WorkstreamDto {
  const task = getTask(ctx.tx, taskId);
  if (task.status !== TaskStatus.Open)
    throw new ConflictError(`Task ${task.title} is ${task.status}`);
  const active = ctx.tx
    .select({ id: schema.workstreams.id })
    .from(schema.workstreams)
    .where(
      and(
        eq(schema.workstreams.taskId, taskId),
        inArray(schema.workstreams.state, [...ACTIVE_STATES]),
      ),
    )
    .get();
  if (active) throw new ConflictError(`Task ${task.title} already has an active workstream`);
  const project = getProject(ctx.tx, task.projectId);
  const row: WorkstreamRow = {
    id: mintId('Workstream'),
    taskId,
    projectId: project.id,
    state: WorkstreamState.Queued,
    nextAction: { kind: 'start' },
    attempt: 0,
    recoveryAttempts: 0,
    model: project.model,
    effort: project.effort,
    baseHead: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    fence: 0,
    gatePid: null,
    gatePidStart: null,
    currentSessionId: null,
    contextPct: null,
    pausedUntil: null,
    failureReason: null,
    lastActivityAt: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.workstreams).values(row).run();
  ctx.emit({
    type: EventType.WorkstreamCreated,
    entityType: 'workstream',
    entityId: row.id,
    data: { taskId, projectId: project.id },
  });
  return toDto(ctx.tx, row);
}

function checkFence(row: WorkstreamRow, fence: number | null): void {
  if (fence !== null && row.fence !== fence) throw new StaleFenceError(row.id);
}

export function transitionWorkstream(
  ctx: WriteContext,
  id: WorkstreamId,
  opts: {
    readonly to: WorkstreamState;
    readonly fence: number | null;
    readonly patch?: WorkstreamPatch;
    readonly reason?: string;
  },
): WorkstreamDto {
  const row = getWorkstreamRow(ctx.tx, id);
  checkFence(row, opts.fence);
  if (!canTransition(row.state, opts.to))
    throw new ConflictError(`Cannot move workstream from ${row.state} to ${opts.to}`);
  ctx.tx
    .update(schema.workstreams)
    .set({ ...opts.patch, state: opts.to, updatedAt: ctx.now })
    .where(eq(schema.workstreams.id, id))
    .run();
  ctx.emit({
    type: EventType.WorkstreamChanged,
    entityType: 'workstream',
    entityId: id,
    data: { from: row.state, to: opts.to, reason: opts.reason ?? null },
  });
  return getWorkstream(ctx.tx, id);
}

export function patchWorkstream(
  ctx: WriteContext,
  id: WorkstreamId,
  fence: number | null,
  patch: WorkstreamPatch,
): void {
  checkFence(getWorkstreamRow(ctx.tx, id), fence);
  ctx.tx
    .update(schema.workstreams)
    .set({ ...patch, updatedAt: ctx.now })
    .where(eq(schema.workstreams.id, id))
    .run();
}

export function acquireLease(
  ctx: WriteContext,
  id: WorkstreamId,
  owner: string,
  expiresAt: string,
): number {
  const fence = getWorkstreamRow(ctx.tx, id).fence + 1;
  ctx.tx
    .update(schema.workstreams)
    .set({ leaseOwner: owner, leaseExpiresAt: expiresAt, fence, updatedAt: ctx.now })
    .where(eq(schema.workstreams.id, id))
    .run();
  return fence;
}

export function renewLeases(ctx: WriteContext, owner: string, expiresAt: string): number {
  return ctx.tx
    .update(schema.workstreams)
    .set({ leaseExpiresAt: expiresAt, updatedAt: ctx.now })
    .where(eq(schema.workstreams.leaseOwner, owner))
    .run().changes;
}

export function clearLease(ctx: WriteContext, id: WorkstreamId): void {
  ctx.tx
    .update(schema.workstreams)
    .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: ctx.now })
    .where(eq(schema.workstreams.id, id))
    .run();
}

export interface LaneCounts {
  readonly global: number;
  readonly byProject: ReadonlyMap<ProjectId, number>;
  readonly byProvider: ReadonlyMap<Provider, number>;
}

export function countLanes(db: DbReader): LaneCounts {
  const rows = db
    .select({ projectId: schema.workstreams.projectId, provider: schema.projects.provider })
    .from(schema.workstreams)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.workstreams.projectId))
    .where(
      or(
        inArray(schema.workstreams.state, [...LANE_STATES]),
        and(
          eq(schema.workstreams.state, WorkstreamState.WaitingHuman),
          isNotNull(schema.workstreams.currentSessionId),
        ),
      ),
    )
    .all();
  const byProject = new Map<ProjectId, number>();
  const byProvider = new Map<Provider, number>();
  for (const r of rows) {
    byProject.set(r.projectId, (byProject.get(r.projectId) ?? 0) + 1);
    byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + 1);
  }
  return { global: rows.length, byProject, byProvider };
}
