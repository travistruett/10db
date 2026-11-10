import {
  ConflictError,
  EventType,
  mintId,
  NotFoundError,
  PassTurnCheck,
  PassTurnEnding,
  type PassId,
  type PassTurnDto,
  type PassTurnId,
  type SessionId,
  type TaskId,
  type TaskMessageId,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, desc, eq, isNotNull, isNull, max, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { getBatch } from './batches';
import type { DbReader, WriteContext } from './store';
import { insertAgentReply } from './task-thread';
import { getWorkstreamRow } from './workstreams';

// Workbench spec §6.2, §11, §12: a pass task's turns. A turn's end is two writes, the end with its
// reply and then its settling, so a restart between them finishes the turn by how it ended.

type PassTurnRow = typeof schema.passTurns.$inferSelect;

function toPassTurnDto(row: PassTurnRow): PassTurnDto {
  return {
    id: row.id,
    taskId: row.taskId,
    workstreamId: row.workstreamId,
    sessionId: row.sessionId,
    seq: row.seq,
    messageId: row.messageId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    ending: row.ending,
    settledAt: row.settledAt,
    keptSha: row.keptSha,
    keptBaseSha: row.keptBaseSha,
    sharedSeq: row.sharedSeq,
    check: row.check,
    readyAt: row.readyAt,
    openedAt: row.openedAt,
    answeredAt: row.answeredAt,
  };
}

export function getPassTurn(db: DbReader, id: PassTurnId): PassTurnDto {
  const row = db.select().from(schema.passTurns).where(eq(schema.passTurns.id, id)).get();
  if (!row) throw new NotFoundError('pass turn', id);
  return toPassTurnDto(row);
}

/** The pass a turn's workstream runs in: a pass task runs only in its pass's batch. */
function passOfTurn(db: DbReader, workstreamId: WorkstreamId): PassId {
  const { batchId } = getWorkstreamRow(db, workstreamId);
  const passId = batchId === null ? null : getBatch(db, batchId).passId;
  if (passId == null) throw new ConflictError(`Workstream ${workstreamId} runs in no pass`);
  return passId;
}

function emitTurn(ctx: WriteContext, type: EventType, turn: PassTurnDto): void {
  ctx.emit({
    type,
    entityType: 'pass',
    entityId: passOfTurn(ctx.tx, turn.workstreamId),
    data: { taskId: turn.taskId, turnId: turn.id, seq: turn.seq, ending: turn.ending },
  });
}

export interface PassTurnInsert {
  readonly taskId: TaskId;
  readonly workstreamId: WorkstreamId;
  readonly sessionId: SessionId | null;
  /** The builder message the turn starts from; it is marked with the turn. */
  readonly messageId: TaskMessageId | null;
}

/**
 * Starts the task's next turn, numbered after its last, and marks the message that starts it, in the
 * caller's write. Refused while the task has a turn that has not ended.
 */
export function insertPassTurn(ctx: WriteContext, input: PassTurnInsert): PassTurnDto {
  const open = openPassTurn(ctx.tx, input.taskId);
  if (open) throw new ConflictError(`Turn ${String(open.seq)} of this task has not ended`);
  const last = ctx.tx
    .select({ seq: max(schema.passTurns.seq) })
    .from(schema.passTurns)
    .where(eq(schema.passTurns.taskId, input.taskId))
    .get();
  const row: PassTurnRow = {
    id: mintId('PassTurn'),
    taskId: input.taskId,
    workstreamId: input.workstreamId,
    sessionId: input.sessionId,
    seq: (last?.seq ?? 0) + 1,
    messageId: input.messageId,
    startedAt: ctx.now,
    endedAt: null,
    ending: null,
    settledAt: null,
    keptSha: null,
    keptBaseSha: null,
    sharedSeq: null,
    check: PassTurnCheck.None,
    readyAt: null,
    openedAt: null,
    answeredAt: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.passTurns).values(row).run();
  if (input.messageId !== null)
    ctx.tx
      .update(schema.taskMessages)
      .set({ turnId: row.id })
      .where(
        and(
          eq(schema.taskMessages.id, input.messageId),
          eq(schema.taskMessages.taskId, input.taskId),
        ),
      )
      .run();
  const turn = toPassTurnDto(row);
  emitTurn(ctx, EventType.PassTurnStarted, turn);
  return turn;
}

/**
 * Ends a turn, saying how, and appends the agent's reply naming it, in one write: the reply is never
 * lost to a restart between the two. An empty reply writes no row. Refused for a turn already ended.
 */
export function endPassTurn(
  ctx: WriteContext,
  id: PassTurnId,
  input: { readonly ending: PassTurnEnding; readonly replyBody: string | null },
): PassTurnDto {
  const turn = getPassTurn(ctx.tx, id);
  if (turn.endedAt !== null)
    throw new ConflictError(`Turn ${String(turn.seq)} of this task has already ended`);
  ctx.tx
    .update(schema.passTurns)
    .set({ endedAt: ctx.now, ending: input.ending, updatedAt: ctx.now })
    .where(eq(schema.passTurns.id, id))
    .run();
  if (input.replyBody !== null && input.replyBody.trim() !== '')
    insertAgentReply(ctx, turn.taskId, { body: input.replyBody, turnId: id });
  const ended = getPassTurn(ctx.tx, id);
  emitTurn(ctx, EventType.PassTurnEnded, ended);
  return ended;
}

/** Records the turn's kept work: the task's kept commit, the tip it was compared with, the shared chain. */
export function setPassTurnKept(
  ctx: WriteContext,
  id: PassTurnId,
  kept: {
    readonly keptSha: string | null;
    readonly keptBaseSha: string;
    readonly sharedSeq: number | null;
  },
): PassTurnDto {
  getPassTurn(ctx.tx, id);
  ctx.tx
    .update(schema.passTurns)
    .set({ ...kept, updatedAt: ctx.now })
    .where(eq(schema.passTurns.id, id))
    .run();
  return getPassTurn(ctx.tx, id);
}

/**
 * Settles an ended turn: its end has been carried through. A turn that ended `ready` makes its page
 * Ready now (`ready_at`, `pass.page_ready`); a stopped or failed one makes nothing Ready. Refused for a
 * turn that has not ended or is settled already.
 */
export function settlePassTurn(ctx: WriteContext, id: PassTurnId): PassTurnDto {
  const turn = getPassTurn(ctx.tx, id);
  if (turn.endedAt === null)
    throw new ConflictError(`Turn ${String(turn.seq)} of this task has not ended`);
  if (turn.settledAt !== null)
    throw new ConflictError(`Turn ${String(turn.seq)} of this task is settled already`);
  const ready = turn.ending === PassTurnEnding.Ready;
  ctx.tx
    .update(schema.passTurns)
    .set({ settledAt: ctx.now, ...(ready ? { readyAt: ctx.now } : {}), updatedAt: ctx.now })
    .where(eq(schema.passTurns.id, id))
    .run();
  const settled = getPassTurn(ctx.tx, id);
  emitTurn(ctx, ready ? EventType.PassPageReady : EventType.PassChanged, settled);
  return settled;
}

/** Notes when the builder first wrote after the turn's page was Ready; a later message changes nothing. */
export function markPassTurnAnswered(ctx: WriteContext, id: PassTurnId): void {
  getPassTurn(ctx.tx, id);
  ctx.tx
    .update(schema.passTurns)
    .set({ answeredAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(schema.passTurns.id, id), isNull(schema.passTurns.answeredAt)))
    .run();
}

/**
 * The task's turns of its current run: a run in an earlier pass the task left is over, whatever its
 * turns' rows say.
 */
function ofCurrentRun(db: DbReader, taskId: TaskId) {
  // The task's run is its latest workstream, as `getTask` reads it.
  const run = db
    .select({ id: schema.workstreams.id })
    .from(schema.workstreams)
    .where(eq(schema.workstreams.taskId, taskId))
    .orderBy(desc(schema.workstreams.createdAt), desc(schema.workstreams.id))
    .limit(1)
    .get();
  return and(
    eq(schema.passTurns.taskId, taskId),
    run === undefined ? sql`0` : eq(schema.passTurns.workstreamId, run.id),
  );
}

/** Takes back a turn's first answer, as when the message that answered it is taken back. */
export function clearPassTurnAnswered(ctx: WriteContext, id: PassTurnId): void {
  getPassTurn(ctx.tx, id);
  ctx.tx
    .update(schema.passTurns)
    .set({ answeredAt: null, updatedAt: ctx.now })
    .where(eq(schema.passTurns.id, id))
    .run();
}

/**
 * The task's turn that has not ended, or undefined: at most one, of any run, since a task leaving its
 * pass ends its open turn (`settleTurnsLeaving`).
 */
export function openPassTurn(db: DbReader, taskId: TaskId): PassTurnDto | undefined {
  const row = db
    .select()
    .from(schema.passTurns)
    .where(and(eq(schema.passTurns.taskId, taskId), isNull(schema.passTurns.endedAt)))
    .get();
  return row ? toPassTurnDto(row) : undefined;
}

/** The latest turn of the task's current run, or undefined before its first. */
export function latestPassTurn(db: DbReader, taskId: TaskId): PassTurnDto | undefined {
  const row = db
    .select()
    .from(schema.passTurns)
    .where(ofCurrentRun(db, taskId))
    .orderBy(desc(schema.passTurns.seq))
    .limit(1)
    .get();
  return row ? toPassTurnDto(row) : undefined;
}

/**
 * A task leaving its pass, in the caller's write: a turn of it still open ends as stopped, with no
 * reply, and every turn of it not settled is settled, none of them Ready, so no later run of the
 * task finds one to finish.
 */
export function settleTurnsLeaving(ctx: WriteContext, taskId: TaskId): void {
  const ofTask = eq(schema.passTurns.taskId, taskId);
  for (const row of ctx.tx
    .select({ id: schema.passTurns.id })
    .from(schema.passTurns)
    .where(and(ofTask, isNull(schema.passTurns.endedAt)))
    .all())
    endPassTurn(ctx, row.id, { ending: PassTurnEnding.Stopped, replyBody: null });
  for (const row of ctx.tx
    .select({ id: schema.passTurns.id })
    .from(schema.passTurns)
    .where(and(ofTask, isNull(schema.passTurns.settledAt)))
    .all()) {
    ctx.tx
      .update(schema.passTurns)
      .set({ settledAt: ctx.now, updatedAt: ctx.now })
      .where(eq(schema.passTurns.id, row.id))
      .run();
    emitTurn(ctx, EventType.PassChanged, getPassTurn(ctx.tx, row.id));
  }
}

/** Every turn that ended and was not settled, oldest first: start-up finishes each by its `ending`. */
export function listTurnsEndedUnsettled(db: DbReader): PassTurnDto[] {
  return db
    .select()
    .from(schema.passTurns)
    .where(and(isNotNull(schema.passTurns.endedAt), isNull(schema.passTurns.settledAt)))
    .orderBy(asc(schema.passTurns.id))
    .all()
    .map(toPassTurnDto);
}

/** Every turn of the pass's tasks, a task that has left it included, oldest first. */
export function listPassTurns(db: DbReader, passId: PassId): PassTurnDto[] {
  return db
    .select({ turn: schema.passTurns })
    .from(schema.passTurns)
    .innerJoin(schema.workstreams, eq(schema.workstreams.id, schema.passTurns.workstreamId))
    .innerJoin(schema.batches, eq(schema.batches.id, schema.workstreams.batchId))
    .where(eq(schema.batches.passId, passId))
    .orderBy(asc(schema.passTurns.id))
    .all()
    .map((r) => toPassTurnDto(r.turn));
}
