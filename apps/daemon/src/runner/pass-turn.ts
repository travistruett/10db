import {
  ConflictError,
  PassTurnEnding,
  WorkstreamFailure,
  WorkstreamState as S,
  type NextAction,
  type PassDto,
  type PassTurnDto,
  type SessionId,
  type TaskMessageId,
  type WorkstreamId,
  type WorkstreamState,
} from '@10db/contracts';
import {
  clearLease,
  endPassTurn,
  getTask,
  getWorkstreamRow,
  insertPassTurn,
  latestPassTurn,
  openPassTurn,
  passHoldingTask,
  patchWorkstream,
  settlePassTurn,
  transitionWorkstream,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { withdrawCard } from '../inbox';
import { keepTurnWork, keptWorkFacts, type KeptWork, type PassWorkDeps } from '../pass';
import { liveCheckCard } from './builder-check';
import { untakenMessages } from './lane-messages';
import { raisePassCheck, raiseTurnFailed } from './pass-check';

// Workbench spec §6.2: a pass task's turn. It starts with a builder message going into its session
// and ends in one order, however it ends: the end and the agent's reply in one write, the page's
// work kept, then the turn settled in one more write, so a restart between finishes it by its ending.

/** The pass that holds the workstream's task, or undefined for ordinary work. */
export function passOfWorkstream(db: DbReader, id: WorkstreamId): PassDto | undefined {
  return passHoldingTask(db, getTask(db, getWorkstreamRow(db, id).taskId));
}

/** The states of a lane that has been granted and has not parked: its turn may not be open yet. */
const LAUNCHED: ReadonlySet<WorkstreamState> = new Set([S.Starting, S.Running, S.HandingOff]);

/** Moves the workstream to WAITING_HUMAN from wherever a turn of it can end. */
function toWaitingHuman(ctx: WriteContext, id: WorkstreamId, fence: number | null): void {
  const { state } = getWorkstreamRow(ctx.tx, id);
  if (state === S.WaitingHuman) return;
  if (state === S.Starting) transitionWorkstream(ctx, id, { to: S.Running, fence });
  else if (state !== S.Running && state !== S.HandingOff)
    throw new ConflictError(`Workstream ${id} is ${state}; its turn cannot end there`);
  transitionWorkstream(ctx, id, { to: S.WaitingHuman, fence, reason: 'the turn ended' });
}

/** Closes the item the page waits on and its live Ready item, if any. */
export function withdrawPageItems(ctx: WriteContext, id: WorkstreamId): void {
  const row = getWorkstreamRow(ctx.tx, id);
  if (row.nextAction.kind === 'pass_review') withdrawCard(ctx, row.nextAction.inboxId);
  const live = liveCheckCard(ctx.tx, id);
  if (live) withdrawCard(ctx, live.id);
}

/**
 * A page waiting for the builder, with no session to hand it to, that has a builder message no turn
 * took: it goes back to the queue to start a turn with the oldest, resuming `providerSessionId`, and
 * its item is withdrawn. Nothing else would launch it. True when it was queued.
 */
export function queueUntaken(
  ctx: WriteContext,
  id: WorkstreamId,
  fence: number | null,
  providerSessionId: string | null,
): boolean {
  const row = getWorkstreamRow(ctx.tx, id);
  if (row.state !== S.WaitingHuman || row.nextAction.kind !== 'pass_review') return false;
  const messageId = untakenMessages(ctx.tx, row.taskId)[0];
  if (messageId === undefined) return false;
  withdrawPageItems(ctx, id);
  transitionWorkstream(ctx, id, {
    to: S.Queued,
    fence,
    patch: { nextAction: { kind: 'feedback', messageId, providerSessionId } },
    reason: 'a message waits for the next turn',
  });
  return true;
}

/**
 * A builder message goes into the page's session (spec §6.2, §6.3): it starts a turn unless one is
 * open, in which case it folds into that turn. A started turn moves a Ready page back to running and
 * withdraws its Ready item, in the caller's write.
 */
export function startTurn(
  ctx: WriteContext,
  input: {
    readonly workstreamId: WorkstreamId;
    readonly sessionId: SessionId | null;
    readonly messageId: TaskMessageId | null;
    readonly fence: number | null;
  },
): PassTurnDto {
  const row = getWorkstreamRow(ctx.tx, input.workstreamId);
  const open = openPassTurn(ctx.tx, row.taskId);
  if (open) return open;
  const turn = insertPassTurn(ctx, {
    taskId: row.taskId,
    workstreamId: input.workstreamId,
    sessionId: input.sessionId,
    messageId: input.messageId,
  });
  withdrawPageItems(ctx, input.workstreamId);
  // A new turn is past any failed one: the page shows no failure while it runs.
  if (row.failureKind !== null || row.failureReason !== null)
    patchWorkstream(ctx, input.workstreamId, input.fence, {
      failureKind: null,
      failureReason: null,
    });
  if (row.state === S.WaitingHuman)
    transitionWorkstream(ctx, input.workstreamId, {
      to: S.Running,
      fence: input.fence,
      reason: 'the builder wrote to the page',
    });
  return turn;
}

/** How a turn's end is carried through once its work is kept. */
export interface TurnSettle {
  /** The runner's fence on the workstream; null where no runner holds it (recovery). */
  readonly fence: number | null;
  /** The provider session a stopped page resumes with its next message; null starts fresh. */
  readonly providerSessionId: string | null;
  /** Why a failed turn could not go on, in the builder's words. */
  readonly reason: string;
}

/**
 * The last write of a turn's end: the turn settled, and the page moved by how it ended. Ready waits
 * for the builder on a new Ready item with its session still open; a failed turn waits on its flag;
 * a stopped turn goes back to the queue resuming its session, which launches nothing until the
 * builder writes again. `kept` is null for an ending that raises no Ready and whose work could not
 * be kept now: it stays on disk, and the next keep takes it.
 */
function settleTurn(
  deps: PassWorkDeps,
  turn: PassTurnDto,
  ending: PassTurnEnding,
  kept: KeptWork | null,
  settle: TurnSettle,
): void {
  const id = turn.workstreamId;
  deps.state.write((ctx) => {
    settlePassTurn(ctx, turn.id);
    const row = getWorkstreamRow(ctx.tx, id);
    const task = getTask(ctx.tx, row.taskId);
    const pass = passHoldingTask(ctx.tx, task);
    if (!pass) throw new ConflictError(`${task.title} is in no open pass`);
    switch (ending) {
      case PassTurnEnding.Ready: {
        if (kept === null) throw new ConflictError(`Turn ${String(turn.seq)} has no kept work`);
        // A message that came as this turn ended has opened the next one: the page works on, and
        // that turn's end raises its Ready.
        if (openPassTurn(ctx.tx, row.taskId)) return;
        // A page never has two open Ready items.
        withdrawPageItems(ctx, id);
        toWaitingHuman(ctx, id, settle.fence);
        const item = raisePassCheck(ctx, {
          pass,
          task,
          workstreamId: id,
          turnId: turn.id,
          keptSha: kept.keptSha,
          keptBaseSha: kept.keptBaseSha,
          turnFiles: kept.turnFiles,
          pageFiles: kept.pageFiles,
        });
        // A turn that got through ends the page's run of crashes.
        patchWorkstream(ctx, id, settle.fence, {
          nextAction: { kind: 'pass_review', inboxId: item.id },
          recoveryAttempts: 0,
        });
        return;
      }
      case PassTurnEnding.Failed: {
        toWaitingHuman(ctx, id, settle.fence);
        const flag = raiseTurnFailed(ctx, {
          pass,
          task,
          workstreamId: id,
          turnId: turn.id,
          reason: settle.reason,
        });
        // The run says why, as a failed run does, though it never fails: the page reads it.
        // Retry Turn starts the page over, with every recovery attempt to come.
        patchWorkstream(ctx, id, settle.fence, {
          nextAction: { kind: 'pass_review', inboxId: flag.id },
          recoveryAttempts: 0,
          currentSessionId: null,
          failureKind: WorkstreamFailure.SessionFailed,
          failureReason: settle.reason,
        });
        clearLease(ctx, id);
        return;
      }
      case PassTurnEnding.Stopped: {
        withdrawPageItems(ctx, id);
        const next: NextAction =
          settle.providerSessionId === null
            ? { kind: 'start' }
            : { kind: 'resume', providerSessionId: settle.providerSessionId, reason: 'stopped' };
        const patch = { nextAction: next, currentSessionId: null };
        // Never through a usage pause's state, which would show the page as paused.
        if (row.state === S.Queued) patchWorkstream(ctx, id, settle.fence, patch);
        else {
          if (row.state !== S.PausedLimit) toWaitingHuman(ctx, id, settle.fence);
          transitionWorkstream(ctx, id, {
            to: S.Queued,
            fence: settle.fence,
            patch,
            reason: 'the builder stopped the turn',
          });
        }
        clearLease(ctx, id);
        return;
      }
    }
  });
}

/**
 * Ends the page's turn (spec §6.2) in its order, for every ending: the end and the agent's reply in
 * one write; the page's work kept; then the turn settled. A turn is not over, and nothing is done,
 * while a builder message no turn has taken is kept (step 1): it is on its way into the session,
 * whether or not it has been handed over yet. A failed page settles the turn that ended and was not
 * settled, if one did, rather than ending another; with none, a failed lane or one stopped before
 * its turn opened gets one for the message it was given, so Retry Turn has a message to send again
 * and the launch rule sees the stop. True when a turn was carried through.
 */
export async function endTurnSteps(
  deps: PassWorkDeps,
  input: TurnSettle & {
    readonly workstreamId: WorkstreamId;
    readonly ending: PassTurnEnding;
    readonly reply: string | null;
  },
): Promise<boolean> {
  const db = deps.state.db;
  const { taskId } = getWorkstreamRow(db, input.workstreamId);
  const ended = deps.state.write((ctx) => {
    if (input.ending === PassTurnEnding.Ready && untakenMessages(ctx.tx, taskId).length > 0)
      return undefined;
    const open = openPassTurn(ctx.tx, taskId);
    // A shared change the turn made is kept, and its areas released, before this write.
    if (open) return endPassTurn(ctx, open.id, { ending: input.ending, replyBody: input.reply });
    if (input.ending === PassTurnEnding.Ready) return undefined;
    if (input.ending === PassTurnEnding.Failed) {
      const latest = latestPassTurn(ctx.tx, taskId);
      if (latest && latest.endedAt !== null && latest.settledAt === null) return latest;
    } else if (!LAUNCHED.has(getWorkstreamRow(ctx.tx, input.workstreamId).state)) return undefined;
    // The lane was started for a message and stopped or failed before its turn opened: the turn is
    // opened for it here so how it ended is on the rows the launch rule and Retry Turn read.
    const turn = insertPassTurn(ctx, {
      taskId,
      workstreamId: input.workstreamId,
      sessionId: null,
      messageId: untakenMessages(ctx.tx, taskId)[0] ?? null,
    });
    return endPassTurn(ctx, turn.id, { ending: input.ending, replyBody: input.reply });
  });
  if (!ended) return false;
  await carryThrough(deps, ended, input.ending, input);
  return true;
}

/**
 * Carries an ended turn through: keeps its work unless it was kept already, then settles it by its
 * ending. A restart between the end and the settle finishes the turn here, never resuming it.
 */
export async function finishEndedTurn(
  deps: PassWorkDeps,
  turn: PassTurnDto,
  settle: TurnSettle,
): Promise<void> {
  if (turn.ending === null)
    throw new ConflictError(`Turn ${String(turn.seq)} of this task has not ended`);
  await carryThrough(deps, turn, turn.ending, settle);
}

/**
 * Keeps the turn's work and settles it as `ending`. A Ready needs its kept work for the item it
 * raises; any other ending settles though its work cannot be kept now, so the page is never left
 * working with no runner.
 */
async function carryThrough(
  deps: PassWorkDeps,
  turn: PassTurnDto,
  ending: PassTurnEnding,
  settle: TurnSettle,
): Promise<void> {
  const keep = () =>
    turn.keptBaseSha === null
      ? keepTurnWork(deps, { workstreamId: turn.workstreamId, turnId: turn.id })
      : keptWorkFacts(deps, turn.taskId);
  let kept: KeptWork | null;
  if (ending === PassTurnEnding.Ready) kept = await keep();
  else
    try {
      kept = await keep();
    } catch (error) {
      deps.logger.warn(
        {
          workstreamId: turn.workstreamId,
          turnId: turn.id,
          err: error instanceof Error ? error.message : String(error),
        },
        "the turn's work was not kept; it is settled, and the next keep takes it",
      );
      kept = null;
    }
  settleTurn(deps, turn, ending, kept, settle);
}
