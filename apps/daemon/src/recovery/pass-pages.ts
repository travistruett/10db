import { PassTurnEnding, WorkstreamState as S, type WorkstreamState } from '@10db/contracts';
import {
  getInboxItem,
  getTask,
  latestPassTurn,
  openPassTurn,
  patchWorkstream,
  type WorkstreamRow,
} from '@10db/db';
import { keptWorkFacts, type PassWorkDeps } from '../pass';
import {
  endTurnSteps,
  finishEndedTurn,
  passOfWorkstream,
  queueUntaken,
  raisePassCheck,
  raiseTurnFailed,
} from '../runner';

// Workbench spec §12: what a restart does with a page of a pass. A turn that ended is finished by
// how it ended and never resumed; a page waiting for the builder keeps its item; a page past the
// recovery limit waits on a failed turn, never failing.

/** The states a turn of a page can end from, as the runner leaves them when the daemon stops. */
const TURN_STATES: ReadonlySet<WorkstreamState> = new Set([
  S.Starting,
  S.Running,
  S.HandingOff,
  S.WaitingHuman,
]);

/** Why a turn that recovery finishes as failed could not go on, when it recorded nothing. */
const UNRECORDED_FAILURE = 'The turn could not go on, and 10db stopped before it said why';

/**
 * Recovers a page of a pass whose session the restart ended, before any other rule: true when it is
 * settled here, false to requeue it as any lane is (with its untaken message, by the caller).
 */
export async function recoverPage(
  deps: PassWorkDeps & { readonly maxRecoveryAttempts: number },
  row: WorkstreamRow,
  input: { readonly providerSessionId: string | null; readonly attempts: number },
): Promise<boolean> {
  const db = deps.state.db;
  const pass = passOfWorkstream(db, row.id);
  if (!pass) return false;
  const latest = latestPassTurn(db, row.taskId);
  const log = deps.logger.child({ workstreamId: row.id });
  try {
    // A turn that ended and was not carried through: its work kept if it was not, then settled.
    if (latest && latest.endedAt !== null && latest.settledAt === null) {
      if (!TURN_STATES.has(row.state)) return false;
      await finishEndedTurn(deps, latest, {
        fence: null,
        providerSessionId: input.providerSessionId,
        reason: row.failureReason ?? UNRECORDED_FAILURE,
      });
      // A message the builder wrote meanwhile starts the next turn.
      deps.state.write((ctx) => queueUntaken(ctx, row.id, null, input.providerSessionId));
      log.info({ turnId: latest.id, ending: latest.ending }, 'pass turn finished after restart');
      return true;
    }
    // A page waiting for the builder keeps the item it waits on, or has it raised again, unless
    // the builder has written to it: then the message starts its next turn.
    if (row.state === S.WaitingHuman && row.nextAction.kind === 'pass_review') {
      if (deps.state.write((ctx) => queueUntaken(ctx, row.id, null, input.providerSessionId)))
        return true;
      if (getInboxItem(db, row.nextAction.inboxId).state === 'OPEN') return true;
      const task = getTask(db, row.taskId);
      if (!latest) return false;
      // A turn settled as failed says so on the run, though it may have ended another way first.
      const failed = latest.ending === PassTurnEnding.Failed || row.failureKind !== null;
      const kept = failed ? null : await keptWorkFacts(deps, task.id);
      deps.state.write((ctx) => {
        const item =
          kept === null
            ? raiseTurnFailed(ctx, {
                pass,
                task,
                workstreamId: row.id,
                turnId: latest.id,
                reason: row.failureReason ?? UNRECORDED_FAILURE,
              })
            : raisePassCheck(ctx, {
                pass,
                task,
                workstreamId: row.id,
                turnId: latest.id,
                keptSha: kept.keptSha,
                keptBaseSha: kept.keptBaseSha,
                turnFiles: kept.turnFiles,
                pageFiles: kept.pageFiles,
              });
        patchWorkstream(ctx, row.id, null, {
          nextAction: { kind: 'pass_review', inboxId: item.id },
        });
      });
      return true;
    }
    // Past the recovery limit, the open turn fails and the page waits on it.
    if (
      input.attempts > deps.maxRecoveryAttempts &&
      TURN_STATES.has(row.state) &&
      openPassTurn(db, row.taskId)
    ) {
      await endTurnSteps(deps, {
        workstreamId: row.id,
        ending: PassTurnEnding.Failed,
        reply: null,
        fence: null,
        providerSessionId: input.providerSessionId,
        reason: `Recovery failed ${String(input.attempts)} times`,
      });
      return true;
    }
  } catch (error) {
    // Its work could not be read or kept now (a folder off the pass's branch): the page is requeued,
    // and the runner finishes the turn once it is launched there.
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'pass page not recovered; it is requeued',
    );
  }
  return false;
}
