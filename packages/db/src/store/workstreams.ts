import {
  ACTIVE_STATES,
  BatchState,
  canTransition,
  ConflictError,
  EventType,
  EvidenceKind,
  LANE_STATES,
  mintId,
  NotFoundError,
  LEFT_OUT_NOTICE_KEY,
  PARKED_NOTICE_KEY,
  REVERT_COMMIT_LINE,
  REVERTED_NOTICE_KEY,
  revertCommitIn,
  TaskStatus,
  WorkstreamState,
  type AccountId,
  type BatchId,
  fitNotice,
  type NextAction,
  type Notice,
  type ProjectId,
  type SessionId,
  type TaskId,
  type WorkstreamDto,
  type WorkstreamFailure,
  type WorkstreamId,
  Effort,
  type WorkstreamStep,
} from '@10db/contracts';
import { and, asc, count, desc, eq, inArray, isNotNull, like, or, type SQL } from 'drizzle-orm';
import * as schema from '../schema';
import { getBoardColumn } from './board-columns';
import { recordLaneTime } from './lane-times';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';
import { getTask, mergedDespiteFailure } from './tasks';

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
  readonly failureKind?: WorkstreamFailure | null;
  readonly lastActivityAt?: string | null;
  readonly runNextAt?: string | null;
  readonly baseHead?: string;
  readonly branch?: string;
  readonly gatePid?: number | null;
  readonly gatePidStart?: string | null;
  /** Mutable because drizzle's `.set()` takes the column's own type. */
  readonly steps?: WorkstreamStep[];
  readonly stepIndex?: number;
  readonly model?: string;
  readonly effort?: Effort;
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
    .select({ title: schema.tasks.title, headline: schema.tasks.headline })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, row.taskId))
    .get();
  return {
    id: row.id,
    taskId: row.taskId,
    taskTitle: task?.title ?? '',
    taskHeadline: task?.headline ?? '',
    projectId: row.projectId,
    batchId: row.batchId,
    state: row.state,
    nextAction: row.nextAction,
    attempt: row.attempt,
    recoveryAttempts: row.recoveryAttempts,
    model: row.model,
    effort: row.effort,
    steps: row.steps,
    stepIndex: row.stepIndex,
    currentSessionId: row.currentSessionId,
    sessionCount: sessions?.n ?? 0,
    contextPct: row.contextPct,
    pausedUntil: row.pausedUntil,
    failureReason: row.failureReason,
    failureKind: row.failureKind,
    lastActivityAt: row.lastActivityAt,
    runNextAt: row.runNextAt,
    notice: row.notice,
    revertTold: revertTold(db, row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Whether a builder note among the run's evidence names a revert commit (a retry or a joined start wrote it). */
function revertTold(db: DbReader, id: WorkstreamId): boolean {
  return db
    .select({ summary: schema.evidence.summary })
    .from(schema.evidence)
    .where(
      and(
        eq(schema.evidence.workstreamId, id),
        eq(schema.evidence.kind, EvidenceKind.Builder),
        like(schema.evidence.summary, `%${REVERT_COMMIT_LINE}%`),
      ),
    )
    .all()
    .some((row) => revertCommitIn(row.summary) !== null);
}

export function getWorkstream(db: DbReader, id: WorkstreamId): WorkstreamDto {
  return toDto(db, getWorkstreamRow(db, id));
}

export function listWorkstreams(
  db: DbReader,
  filter: { states?: readonly WorkstreamState[]; projectId?: ProjectId; batchId?: BatchId } = {},
): WorkstreamDto[] {
  const where: SQL[] = [];
  if (filter.states) where.push(inArray(schema.workstreams.state, [...filter.states]));
  if (filter.projectId) where.push(eq(schema.workstreams.projectId, filter.projectId));
  if (filter.batchId) where.push(eq(schema.workstreams.batchId, filter.batchId));
  return db
    .select()
    .from(schema.workstreams)
    .where(and(...where))
    .orderBy(asc(schema.workstreams.createdAt), asc(schema.workstreams.id))
    .all()
    .map((r) => toDto(db, r));
}

/**
 * The model and effort a workstream shows before a plan's first step sets them; routing picks the
 * real ones per step.
 */
const UNPLANNED_MODEL = { model: 'sonnet', effort: Effort.Medium } as const;

/** `first` is the model and effort of the plan's first step; absent, the workstream shows a placeholder. */
export function insertWorkstream(
  ctx: WriteContext,
  taskId: TaskId,
  opts: {
    readonly batchId?: BatchId | null;
    readonly first?: { readonly model: string; readonly effort: Effort };
  } = {},
): WorkstreamDto {
  const task = getTask(ctx.tx, taskId);
  if (task.status !== TaskStatus.Open)
    throw new ConflictError(`Task ${task.title} is ${task.status}`);
  if (task.boardColumnId !== null) {
    const column = getBoardColumn(ctx.tx, task.boardColumnId);
    throw new ConflictError(
      `Task ${task.title} is parked in ${column.name}; move it to Backlog or Ready to start it`,
    );
  }
  // A queued task waits for its dependencies; one parked in a human column would never finish.
  for (const dependencyId of task.dependsOn) {
    const dependency = getTask(ctx.tx, dependencyId);
    if (dependency.status === TaskStatus.Open && dependency.boardColumnId !== null) {
      const column = getBoardColumn(ctx.tx, dependency.boardColumnId);
      throw new ConflictError(
        `Task ${task.title} waits on ${dependency.title}, which is parked in ${column.name}; move it to Backlog or Ready first`,
      );
    }
  }
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
    batchId: opts.batchId ?? null,
    workspaceMode: task.workspaceMode,
    state: WorkstreamState.Queued,
    nextAction: { kind: 'start' },
    attempt: 0,
    recoveryAttempts: 0,
    model: (opts.first ?? UNPLANNED_MODEL).model,
    effort: (opts.first ?? UNPLANNED_MODEL).effort,
    steps: [],
    stepIndex: 0,
    baseHead: null,
    branch: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    fence: 0,
    gatePid: null,
    gatePidStart: null,
    currentSessionId: null,
    contextPct: null,
    pausedUntil: null,
    failureReason: null,
    failureKind: null,
    lastActivityAt: null,
    runNextAt: null,
    notice: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.workstreams).values(row).run();
  ctx.emit({
    type: EventType.WorkstreamCreated,
    entityType: 'workstream',
    entityId: row.id,
    data: { taskId, projectId: project.id, batchId: opts.batchId ?? null },
  });
  return toDto(ctx.tx, row);
}

/** The task's newest workstream, whatever its state; undefined for a task that never started. */
export function latestWorkstreamOf(db: DbReader, taskId: TaskId): WorkstreamRow | undefined {
  return db
    .select()
    .from(schema.workstreams)
    .where(eq(schema.workstreams.taskId, taskId))
    .orderBy(desc(schema.workstreams.createdAt), desc(schema.workstreams.id))
    .limit(1)
    .get();
}

/** The task's most recent DONE workstream: where its code was finished, and in which batch. */
export function latestDoneWorkstream(db: DbReader, taskId: TaskId): WorkstreamRow | undefined {
  return db
    .select()
    .from(schema.workstreams)
    .where(
      and(
        eq(schema.workstreams.taskId, taskId),
        eq(schema.workstreams.state, WorkstreamState.Done),
      ),
    )
    .orderBy(desc(schema.workstreams.createdAt), desc(schema.workstreams.id))
    .limit(1)
    .get();
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
  // Lane time is stored once, as the workstream finishes (Shape spec §8).
  if (opts.to === WorkstreamState.Done) recordLaneTime(ctx, id);
  return getWorkstream(ctx.tx, id);
}

/**
 * Puts the task's queued workstream first in line for the next free lane, ahead of work the
 * builder pressed Run Next on earlier. Answers the titles of the dependencies still open: the
 * workstream runs once they finish. Throws ConflictError for a task whose latest workstream isn't
 * waiting for a lane.
 */
export function runNext(
  ctx: WriteContext,
  taskId: TaskId,
): { readonly workstream: WorkstreamDto; readonly waitingOn: string[] } {
  const task = getTask(ctx.tx, taskId);
  const latest = ctx.tx
    .select()
    .from(schema.workstreams)
    .where(eq(schema.workstreams.taskId, taskId))
    .orderBy(desc(schema.workstreams.createdAt), desc(schema.workstreams.id))
    .limit(1)
    .get();
  if (latest?.state !== WorkstreamState.Queued)
    throw new ConflictError(`Task ${task.title} isn't waiting for a lane`);
  ctx.tx
    .update(schema.workstreams)
    .set({ runNextAt: ctx.now, updatedAt: ctx.now })
    .where(eq(schema.workstreams.id, latest.id))
    .run();
  ctx.emit({
    type: EventType.WorkstreamChanged,
    entityType: 'workstream',
    entityId: latest.id,
    data: { from: latest.state, to: latest.state, reason: 'run next' },
  });
  const waitingOn = task.dependsOn
    .map((id) => getTask(ctx.tx, id))
    .filter(
      (dependency) =>
        dependency.status !== TaskStatus.Done && !mergedDespiteFailure(ctx.tx, dependency.id),
    )
    .map((dependency) => dependency.title);
  return { workstream: getWorkstream(ctx.tx, latest.id), waitingOn };
}

/** Frees every workstream of a batch that is about to be deleted. */
export function detachFromBatch(ctx: WriteContext, batchId: BatchId): void {
  ctx.tx
    .update(schema.workstreams)
    .set({ batchId: null, updatedAt: ctx.now })
    .where(eq(schema.workstreams.batchId, batchId))
    .run();
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

function emitWorkstreamNotice(ctx: WriteContext, row: WorkstreamRow): void {
  ctx.emit({
    type: EventType.WorkstreamChanged,
    entityType: 'workstream',
    entityId: row.id,
    data: { from: row.state, to: row.state, reason: 'notice' },
  });
}

/**
 * Sets what the run waits for besides the builder, or clears it with null. Writes, and tells clients,
 * only when that changes what the run says. It is not fenced: a wait is written by the session's tool
 * call, not the lane that holds the lease. Resolves whether it changed.
 */
export function setWorkstreamNotice(
  ctx: WriteContext,
  id: WorkstreamId,
  given: Notice | null,
): boolean {
  const notice = given === null ? null : fitNotice(given);
  const row = getWorkstreamRow(ctx.tx, id);
  if (JSON.stringify(row.notice) === JSON.stringify(notice)) return false;
  ctx.tx
    .update(schema.workstreams)
    .set({ notice, updatedAt: ctx.now })
    .where(eq(schema.workstreams.id, id))
    .run();
  emitWorkstreamNotice(ctx, row);
  return true;
}

/**
 * Clears every run's notice, as a daemon start does: the waits they describe ended with the last one.
 * A parked run keeps its own: it records what the builder answered, not a wait. So does a run left
 * out of its batch's pull request, because the body reads that notice, and so does a retried run
 * whose commits are still reverted, because its drawer says so across a restart.
 */
export function clearWorkstreamNotices(ctx: WriteContext): WorkstreamId[] {
  const rows = ctx.tx
    .select()
    .from(schema.workstreams)
    .where(isNotNull(schema.workstreams.notice))
    .all()
    .filter(
      (row) =>
        row.notice?.key !== PARKED_NOTICE_KEY &&
        row.notice?.key !== LEFT_OUT_NOTICE_KEY &&
        row.notice?.key !== REVERTED_NOTICE_KEY,
    );
  for (const row of rows) {
    ctx.tx
      .update(schema.workstreams)
      .set({ notice: null, updatedAt: ctx.now })
      .where(eq(schema.workstreams.id, row.id))
      .run();
    emitWorkstreamNotice(ctx, row);
  }
  return rows.map((r) => r.id);
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
  readonly byAccount: ReadonlyMap<AccountId, number>;
}

export function countLanes(db: DbReader): LaneCounts {
  const rows = db
    .select({
      projectId: schema.workstreams.projectId,
      accountId: schema.projects.accountId,
    })
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
  const byAccount = new Map<AccountId, number>();
  for (const r of rows) {
    byProject.set(r.projectId, (byProject.get(r.projectId) ?? 0) + 1);
    byAccount.set(r.accountId, (byAccount.get(r.accountId) ?? 0) + 1);
  }
  return { global: rows.length, byProject, byAccount };
}

/**
 * How many things a restart would cut off: workstreams that hold a lane (as `countLanes` counts
 * them) or run a gate process, and batches being cut or shipped. Work that is queued, paused or
 * waiting for the builder is not counted: recovery keeps its place across a restart.
 *
 * A lane waiting on a card whose session is still live holds a lane, but runs nothing: a restart
 * ends the session and recovery parks the lane on its card to resume with the answer. It counts
 * unless `waitingOnCard` is false, which a drain passes so one unanswered card does not hold the
 * install, and every lane behind it, until the builder comes back.
 */
export function countMidSession(
  db: DbReader,
  opts: { readonly waitingOnCard?: boolean } = {},
): number {
  const rows = db
    .select({
      state: schema.workstreams.state,
      gatePid: schema.workstreams.gatePid,
      currentSessionId: schema.workstreams.currentSessionId,
    })
    .from(schema.workstreams)
    .where(inArray(schema.workstreams.state, [...ACTIVE_STATES]))
    .all();
  const withCards = opts.waitingOnCard ?? true;
  const live = rows.filter(
    (r) => LANE_STATES.includes(r.state) || r.gatePid !== null || (withCards && isWaitingOnCard(r)),
  );
  return live.length + countBatchesInFlight(db);
}

/** The batches being cut or shipped: the part of `countMidSession` that is no lane or gate. */
export function countBatchesInFlight(db: DbReader): number {
  const batches = db
    .select({ n: count() })
    .from(schema.batches)
    .where(inArray(schema.batches.state, [BatchState.Cutting, BatchState.Shipping]))
    .get();
  return batches?.n ?? 0;
}

function isWaitingOnCard(r: {
  readonly state: WorkstreamState;
  readonly currentSessionId: SessionId | null;
}): boolean {
  return r.state === WorkstreamState.WaitingHuman && r.currentSessionId !== null;
}

/**
 * Whether this lane is only waiting on a card (as `countWaitingOnCard` counts it): it runs nothing and
 * frees no claim until the builder answers. False for a lane that is not there.
 */
export function isLaneWaitingOnCard(db: DbReader, id: WorkstreamId): boolean {
  const row = db
    .select({
      state: schema.workstreams.state,
      gatePid: schema.workstreams.gatePid,
      currentSessionId: schema.workstreams.currentSessionId,
    })
    .from(schema.workstreams)
    .where(eq(schema.workstreams.id, id))
    .get();
  return row?.gatePid === null && isWaitingOnCard(row);
}

/**
 * How many of `countMidSession`'s lanes are only waiting on a card: parked on a permission or ask
 * with a live session and no gate process. These are the ones a drain stops waiting for.
 */
export function countWaitingOnCard(db: DbReader): number {
  return db
    .select({
      state: schema.workstreams.state,
      gatePid: schema.workstreams.gatePid,
      currentSessionId: schema.workstreams.currentSessionId,
    })
    .from(schema.workstreams)
    .where(eq(schema.workstreams.state, WorkstreamState.WaitingHuman))
    .all()
    .filter((r) => r.gatePid === null && isWaitingOnCard(r)).length;
}
