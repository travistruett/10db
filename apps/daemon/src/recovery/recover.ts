import {
  ACTIVE_STATES,
  PassState,
  EventType,
  WorkstreamFailure,
  WorkstreamState as S,
  type InboxItemId,
  type NextAction,
  WorkstreamId,
} from '@10db/contracts';
import { z } from 'zod';
import { coverageLinesOf } from '../evals';
import {
  clearLease,
  deleteAppSetting,
  endSession,
  getAppSetting,
  getProject,
  getTask,
  getWorkstreamRow,
  insertSystemNotice,
  latestHandoffForStep,
  latestToolOp,
  listInbox,
  listSessions,
  listWorkstreams,
  openItemsForWorkstream,
  openPassTurn,
  patchWorkstream,
  releaseClaims,
  setAppSetting,
  transitionWorkstream,
  type DbReader,
  type WorkstreamRow,
} from '@10db/db';
import {
  batchCardFields,
  checkoutOf,
  laneBranchOf,
  runCommits,
  type DeliveryJobs,
} from '../delivery';
import type { StateStore } from '../events';
import type { Git } from '../git';
import {
  flagFailedRun,
  OutOfMovesKind,
  outOfMovesFields,
  raiseStartHoldCard,
  type InboxService,
} from '../inbox';
import type { Logger } from '../log';
import type { Clock } from '../clock';
import {
  outstandingFixEvidence,
  liveCheckCard,
  livePlanCard,
  nextActionAfterCrash,
  passOfWorkstream,
  planOf,
  raiseBuilderCheck,
  raisePlanApproval,
  untakenMessages,
  withUndelivered,
  yieldClaimsWhileWaiting,
} from '../runner';
import { recoverPage } from './pass-pages';
import { failStep } from '../team';
import type { ProcessTerminator } from './processes';

export interface RecoveryReport {
  readonly requeued: WorkstreamId[];
  readonly failed: WorkstreamId[];
  readonly parked: WorkstreamId[];
  /** Runs held because they were starting at this unclean restart and at the one before it. */
  readonly held: WorkstreamId[];
  readonly redelivered: InboxItemId[];
}

/**
 * The app setting naming the runs that were starting at the last unclean restart (a crash, or the app
 * killing a frozen daemon). A run found starting again at the next one is held, so a run that brings
 * 10db down on every start stops instead of looping: a starting run is never charged an attempt.
 */
const STARTING_AT_RESTART_KEY = 'recovery.starting_at_unclean_restart';
const StartingAtRestart = z.object({ workstreamIds: z.array(WorkstreamId) });

/** The runs the setting names; a value 10db can't read names none. */
function startingAtLastRestart(db: DbReader): ReadonlySet<WorkstreamId> {
  // The setting is JSON read back from the database: a boundary, so parse it.
  const parsed = StartingAtRestart.safeParse(getAppSetting(db, STARTING_AT_RESTART_KEY));
  return new Set(parsed.success ? parsed.data.workstreamIds : []);
}

/** The thread's note that a page's turn goes on after 10db restarted (Workbench spec §4.3). */
const RESUMED_AFTER_RESTART = 'Resumed after 10db restarted';

/** States that keep their place: only the dead daemon's lease, session and processes are cleaned up. */
const KEEP_STATE = new Set<string>([S.Queued, S.Held, S.PausedLimit]);

/** The most dirty files one recovery event records. */
const MAX_DIRTY_FILES = 200;

/** What the builder is asked to check, read from the workstream's checkout. */
async function readCheckFacts(git: Git, db: DbReader, row: WorkstreamRow) {
  const checkout = checkoutOf(db, row);
  const head = await git.head(checkout).catch(() => 'unknown');
  const baseHead = row.baseHead ?? head;
  const commits = await runCommits({ db, git }, row, checkout, baseHead, head)
    .then((run) => [...run.commits])
    .catch(() => []);
  return { baseHead, head, commits };
}

/** The facts for a card raised in the instant its predecessor closed, before git was read. */
function unreadCheckFacts(row: WorkstreamRow) {
  return { baseHead: row.baseHead ?? 'unknown', head: 'unknown', commits: [] };
}

/**
 * Runs once at startup, before the scheduler, so no runner races it. Every non-terminal workstream
 * loses its dead session, gate process and lease; lane work is then re-queued at the front of the
 * line (or failed once it has used its attempts), waiting work is parked on its card, and answered cards are redelivered.
 */
export async function recoverOnStartup(opts: {
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly git: Git;
  readonly processes: ProcessTerminator;
  readonly maxRecoveryAttempts: number;
  readonly logger: Logger;
  /** The previous daemon stopped cleanly, so this restart is not a failed attempt. */
  readonly cleanShutdown?: boolean;
  /**
   * The app killed the previous daemon because it stopped answering. No run is charged for that, as on a
   * clean shutdown, but the restart is unclean: a run starting at it may be what froze the daemon.
   */
  readonly frozenKill?: boolean;
  /** The delivery jobs and the clock a page of a pass keeps its work beside. */
  readonly jobs: DeliveryJobs;
  readonly clock: Clock;
}): Promise<RecoveryReport> {
  const db = opts.state.db;
  const report: RecoveryReport = {
    requeued: [],
    failed: [],
    parked: [],
    held: [],
    redelivered: [],
  };
  // One stamp for every workstream this run re-queues, so they keep their start order among themselves.
  const recoveredAt = opts.state.now();
  const unclean = opts.cleanShutdown !== true;
  // A clean shutdown between two unclean restarts means they were not in a row.
  const startingBefore = unclean ? startingAtLastRestart(db) : new Set<WorkstreamId>();
  const startingNow: WorkstreamId[] = [];

  for (const ws of listWorkstreams(db, { states: ACTIVE_STATES })) {
    const row = getWorkstreamRow(db, ws.id);
    const project = getProject(db, row.projectId);
    const sessions = listSessions(db, ws.id);
    const live = sessions.filter((s) => s.endedAt === null);
    for (const s of live) {
      if (s.pid !== null && s.pidStart !== null) {
        await opts.processes.terminate({ pid: s.pid, startedAt: s.pidStart });
      }
    }
    if (row.gatePid !== null && row.gatePidStart !== null) {
      await opts.processes.terminate({
        pid: row.gatePid,
        startedAt: row.gatePidStart,
        group: true,
      });
    }
    const providerSessionId =
      [...sessions].reverse().find((s) => s.providerSessionId !== null)?.providerSessionId ?? null;
    opts.state.write((ctx) => {
      for (const s of live) endSession(ctx, s.id, 'daemon_restart');
      patchWorkstream(ctx, ws.id, null, {
        currentSessionId: null,
        gatePid: null,
        gatePidStart: null,
      });
      clearLease(ctx, ws.id);
    });
    if (KEEP_STATE.has(row.state)) continue;
    // A STARTING run's session never reported started in this launch (its `started` event moves it to
    // RUNNING), so the restart cost it nothing. Queued, held and paused runs kept their state above.
    const charged = unclean && opts.frozenKill !== true && row.state !== S.Starting;
    const attempts = charged ? row.recoveryAttempts + 1 : row.recoveryAttempts;
    if (
      await recoverPage(
        { ...opts, maxRecoveryAttempts: opts.maxRecoveryAttempts },
        getWorkstreamRow(db, ws.id),
        { providerSessionId, attempts },
      )
    ) {
      report.parked.push(ws.id);
      continue;
    }
    // A page of a pass never fails; its next session takes the message no turn took.
    const pass = passOfWorkstream(db, ws.id);

    const waiting = row.state === S.WaitingHuman;
    // Work that waits for the builder's check keeps its card; it is not an agent's question to answer.
    if (waiting && row.nextAction.kind === 'builder_review') {
      // Git is read only when the card has to be raised again, so a restart that finds it touches nothing.
      const facts = liveCheckCard(db, ws.id) ? null : await readCheckFacts(opts.git, db, row);
      // A card that was closed some other way is raised again, so the work is never stranded.
      const card = opts.state.write((ctx) => {
        const kept =
          liveCheckCard(ctx.tx, ws.id) ??
          raiseBuilderCheck(ctx, {
            workstreamId: ws.id,
            projectId: project.id,
            taskTitle: getTask(ctx.tx, row.taskId).title,
            ...(facts ?? unreadCheckFacts(row)),
            evalLines: coverageLinesOf(ctx.tx, ws.id),
          });
        patchWorkstream(ctx, ws.id, null, {
          nextAction: { kind: 'builder_review', inboxId: kept.id },
        });
        return kept;
      });
      opts.logger.info({ workstreamId: ws.id, inboxId: card.id }, 'still waiting for the builder');
      report.parked.push(ws.id);
      continue;
    }
    // Work that waits for the builder's approval of its plan keeps its card the same way.
    if (waiting && row.nextAction.kind === 'plan_approval') {
      const card = opts.state.write((ctx) => {
        const kept =
          livePlanCard(ctx.tx, ws.id) ??
          raisePlanApproval(ctx, {
            workstreamId: ws.id,
            projectId: project.id,
            taskTitle: getTask(ctx.tx, row.taskId).title,
            plan: planOf(row),
          });
        patchWorkstream(ctx, ws.id, null, {
          nextAction: { kind: 'plan_approval', inboxId: kept.id },
        });
        return kept;
      });
      opts.logger.info(
        { workstreamId: ws.id, inboxId: card.id },
        'still waiting for the builder to approve the plan',
      );
      report.parked.push(ws.id);
      continue;
    }
    // A check, plan, acceptance or Look card is not an agent's question: it is answered by its own handler.
    const open = waiting
      ? openItemsForWorkstream(db, ws.id).find(
          (i) =>
            i.kind !== 'check' &&
            i.kind !== 'plan' &&
            i.kind !== 'acceptance' &&
            i.kind !== 'watchpoint',
        )
      : undefined;
    if (open) {
      const nextAction: NextAction = { kind: 'answer', inboxId: open.id, providerSessionId };
      opts.state.write((ctx) => {
        patchWorkstream(ctx, ws.id, null, { nextAction });
      });
      // A task waiting on a person does not hold its claims across the restart either.
      await yieldClaimsWhileWaiting(opts, ws.id, open.id).catch((error: unknown) => {
        opts.logger.warn(
          { workstreamId: ws.id, err: String(error) },
          'could not let go of the claims of a task waiting on an answer',
        );
      });
      report.parked.push(ws.id);
      continue;
    }

    const checkout = checkoutOf(db, row);
    const head = await opts.git.head(checkout).catch(() => 'unknown');
    const dirty = await opts.git.changedPaths(checkout).catch(() => []);
    const lastOp = latestToolOp(db, ws.id);
    // A resume that was fixing a gate failure comes back as the fix, so the failure isn't dropped.
    const failedGate = row.nextAction.kind === 'resume' ? outstandingFixEvidence(db, row) : null;
    const crashAction: NextAction =
      row.state === S.Verifying || row.nextAction.kind === 'verify'
        ? { kind: 'verify' }
        : failedGate
          ? { kind: 'fix', evidenceId: failedGate, providerSessionId: null }
          : nextActionAfterCrash(row.nextAction, providerSessionId, latestHandoffForStep(db, row));
    const nextAction = pass
      ? withUndelivered(crashAction, untakenMessages(db, row.taskId)[0] ?? null, providerSessionId)
      : crashAction;
    // A waiting workstream has no edge to FAILED, and it never ran a session this boot.
    const failed = !waiting && !pass && attempts > opts.maxRecoveryAttempts;
    const startingAtUncleanRestart = unclean && !waiting && !pass && row.state === S.Starting;
    if (startingAtUncleanRestart && !startingBefore.has(ws.id)) startingNow.push(ws.id);
    const held = !failed && startingAtUncleanRestart && startingBefore.has(ws.id);
    opts.state.write((ctx) => {
      if (row.state !== S.Recovering && !waiting) {
        transitionWorkstream(ctx, ws.id, {
          to: S.Recovering,
          fence: null,
          reason: opts.cleanShutdown
            ? 'daemon restarted after a clean shutdown'
            : opts.frozenKill
              ? 'daemon restarted after the app killed it as frozen or stuck starting'
              : 'daemon restarted',
        });
      }
      ctx.emit({
        type: EventType.RecoveryStep,
        entityType: 'workstream',
        entityId: ws.id,
        data: {
          step: 'reconciled',
          head,
          dirtyFiles: dirty.slice(0, MAX_DIRTY_FILES),
          lastOpId: lastOp?.opId ?? null,
          sessionsEnded: live.length,
        },
      });
      if (failed) {
        transitionWorkstream(ctx, ws.id, {
          to: S.Failed,
          fence: null,
          patch: {
            recoveryAttempts: attempts,
            failureReason: `Recovery failed ${String(attempts)} times`,
            failureKind: WorkstreamFailure.SessionFailed,
            ...(row.steps.length > 0 ? { steps: failStep(row.steps, row.stepIndex) } : {}),
          },
        });
        // A run on a lane branch keeps its claims until its take-out has its work out of Your folder.
        if (laneBranchOf(row) === null) releaseClaims(ctx, ws.id);
      } else {
        transitionWorkstream(ctx, ws.id, {
          to: S.Queued,
          fence: null,
          // Back at the front of the line, ahead of work that never started; see `queueOrder`.
          // 10db re-runs the run itself: the one session it starts counts against the daily ceiling.
          patch: {
            nextAction,
            recoveryAttempts: attempts,
            runNextAt: recoveredAt,
            autoRerun: true,
          },
          reason: 'recovered after restart',
        });
        if (held) {
          transitionWorkstream(ctx, ws.id, {
            to: S.Held,
            fence: null,
            patch: { runNextAt: null },
            reason: 'held: it was starting at two unclean restarts in a row',
          });
          // As a failed run does: one on a lane branch keeps its claims until its work is out of Your folder.
          if (laneBranchOf(row) === null) releaseClaims(ctx, ws.id);
          raiseStartHoldCard(ctx, row, { frozen: opts.frozenKill === true });
        }
        // Workbench spec §4.3: a page's turn the restart cut short goes on, and its thread says so,
        // once, in the write that queues it; a closing or abandoning pass takes no turn further.
        if (
          passOfWorkstream(ctx.tx, ws.id)?.state === PassState.Open &&
          openPassTurn(ctx.tx, row.taskId)
        )
          insertSystemNotice(ctx, row.taskId, RESUMED_AFTER_RESTART);
      }
    });
    if (failed) {
      // The out-of-moves answers replace the batch card's; its detail stays so the batch's settling finds it.
      const batch = batchCardFields(row);
      const oom = outOfMovesFields({
        kind: OutOfMovesKind.Recovery,
        more: opts.maxRecoveryAttempts,
        batchId: row.batchId,
        workstreamId: row.id,
      });
      opts.state.write((ctx) => {
        flagFailedRun(ctx, row, {
          body: `Recovery failed ${String(attempts)} times.`,
          options: oom.options,
          detail: { ...batch?.detail, ...oom.detail },
        });
      });
      report.failed.push(ws.id);
    } else if (held) {
      opts.logger.warn(
        { workstreamId: ws.id },
        'held a run that was starting at two unclean restarts in a row',
      );
      report.held.push(ws.id);
    } else {
      report.requeued.push(ws.id);
    }
  }

  opts.state.write((ctx) => {
    if (startingNow.length === 0) deleteAppSetting(ctx, STARTING_AT_RESTART_KEY);
    else setAppSetting(ctx, STARTING_AT_RESTART_KEY, { workstreamIds: startingNow });
  });

  for (const item of listInbox(db, { states: ['ANSWERED', 'DELIVERING'] })) {
    opts.inbox.redeliver(item.id);
    report.redelivered.push(item.id);
  }
  opts.logger.info({ ...report }, 'startup recovery complete');
  return report;
}
