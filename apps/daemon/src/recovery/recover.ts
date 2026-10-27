import {
  ACTIVE_STATES,
  EventType,
  WorkstreamState as S,
  type InboxItemId,
  type NextAction,
  type WorkstreamId,
} from '@10db/contracts';
import {
  clearLease,
  endSession,
  getProject,
  getTask,
  getWorkstreamRow,
  latestHandoffForStep,
  latestToolOp,
  listInbox,
  listSessions,
  listWorkstreams,
  openItemsForWorkstream,
  patchWorkstream,
  releaseClaims,
  transitionWorkstream,
} from '@10db/db';
import { batchCardFields } from '../delivery';
import type { StateStore } from '../events';
import type { Git } from '../git';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { failedGateEvidence, nextActionAfterCrash } from '../runner';
import { failStep } from '../team';
import type { ProcessTerminator } from './processes';

export interface RecoveryReport {
  readonly requeued: WorkstreamId[];
  readonly failed: WorkstreamId[];
  readonly parked: WorkstreamId[];
  readonly redelivered: InboxItemId[];
}

/** States that keep their place: only the dead daemon's lease, session and processes are cleaned up. */
const KEEP_STATE = new Set<string>([S.Queued, S.PausedLimit]);

/** The most dirty files one recovery event records. */
const MAX_DIRTY_FILES = 200;

/**
 * Runs once at startup, before the scheduler, so no runner races it. Every non-terminal workstream
 * loses its dead session, gate process and lease; lane work is then re-queued (or failed once it
 * has used its attempts), waiting work is parked on its card, and answered cards are redelivered.
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
}): Promise<RecoveryReport> {
  const db = opts.state.db;
  const report: RecoveryReport = { requeued: [], failed: [], parked: [], redelivered: [] };

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

    const waiting = row.state === S.WaitingHuman;
    const open = waiting ? openItemsForWorkstream(db, ws.id)[0] : undefined;
    if (open) {
      const nextAction: NextAction = { kind: 'answer', inboxId: open.id, providerSessionId };
      opts.state.write((ctx) => {
        patchWorkstream(ctx, ws.id, null, { nextAction });
      });
      report.parked.push(ws.id);
      continue;
    }

    const head = await opts.git.head(project.repoPath).catch(() => 'unknown');
    const dirty = await opts.git.changedPaths(project.repoPath).catch(() => []);
    const lastOp = latestToolOp(db, ws.id);
    const attempts = opts.cleanShutdown ? row.recoveryAttempts : row.recoveryAttempts + 1;
    // A resume that was fixing a gate failure comes back as the fix, so the failure isn't dropped.
    const failedGate = row.nextAction.kind === 'resume' ? failedGateEvidence(db, ws.id) : null;
    const nextAction: NextAction =
      row.state === S.Verifying || row.nextAction.kind === 'verify'
        ? { kind: 'verify' }
        : failedGate
          ? { kind: 'fix', evidenceId: failedGate }
          : nextActionAfterCrash(row.nextAction, providerSessionId, latestHandoffForStep(db, row));
    // A waiting workstream has no edge to FAILED, and it never ran a session this boot.
    const failed = !waiting && attempts > opts.maxRecoveryAttempts;
    opts.state.write((ctx) => {
      if (row.state !== S.Recovering && !waiting) {
        transitionWorkstream(ctx, ws.id, {
          to: S.Recovering,
          fence: null,
          reason: opts.cleanShutdown
            ? 'daemon restarted after a clean shutdown'
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
            ...(row.steps.length > 0 ? { steps: failStep(row.steps, row.stepIndex) } : {}),
          },
        });
        releaseClaims(ctx, ws.id);
      } else {
        transitionWorkstream(ctx, ws.id, {
          to: S.Queued,
          fence: null,
          patch: { nextAction, recoveryAttempts: attempts },
          reason: 'recovered after restart',
        });
      }
    });
    if (failed) {
      opts.inbox.flag({
        projectId: project.id,
        workstreamId: ws.id,
        title: `Workstream failed: ${getTask(db, row.taskId).title}`,
        body: `Recovery failed ${String(attempts)} times.`,
        ...batchCardFields(row),
      });
      report.failed.push(ws.id);
    } else {
      report.requeued.push(ws.id);
    }
  }

  for (const item of listInbox(db, { states: ['ANSWERED', 'DELIVERING'] })) {
    opts.inbox.redeliver(item.id);
    report.redelivered.push(item.id);
  }
  opts.logger.info({ ...report }, 'startup recovery complete');
  return report;
}
