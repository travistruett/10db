import {
  BatchState,
  DecisionRule,
  WorkstreamState,
  type ProjectId,
  type TaskId,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getWorkstreamRow,
  isRuleAsking,
  listActiveProjects,
  listBatches,
  listWorkstreams,
  queuedCopyBatchIds,
  type DbReader,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import { cardsResolvedByEvent, flagCard, resolveStaleCards, type InboxService } from '../inbox';
import type { Logger } from '../log';
import type { StallRestartResult } from '../runner';
import type { QueueWaits } from '../scheduler';
import { stallCard, stallCardOf } from './card';
import { liveGateOf } from './live-gate';
import { markHung, readRestart } from './restart-record';
import { StallFault, stallMove, StallMove } from './restart-rule';
import {
  batchStallKey,
  findStalls,
  runStallKey,
  StallKind,
  type ActiveRun,
  type QueuedRun,
  type Stall,
} from './rules';
import { STALL } from './thresholds';

const ACTIVE_STATES: ReadonlySet<string> = new Set([
  WorkstreamState.Starting,
  WorkstreamState.Running,
  WorkstreamState.Verifying,
]);

/** The reason 10db writes on a Stuck card it closed because the item moved. */
export const STALL_CLEARED_REASON = 'It moved again';

export interface StallSweep {
  start(): void;
  stop(): void;
  /** Looks once: raises a card for each new or changed stall and closes the cards whose stall is gone. */
  sweep(): void;
}

/** The latest run of each task among a batch's runs, which `listWorkstreams` lists oldest first. */
function latestPerTask(runs: readonly WorkstreamDto[]): WorkstreamDto[] {
  const latest = new Map<TaskId, WorkstreamDto>();
  for (const run of runs) latest.set(run.taskId, run);
  return [...latest.values()];
}

/**
 * The watchdog: every minute it reads what is queued, active and shipping in the active projects and
 * keeps one Stuck card per stall. A stalled active run is restarted once instead (`stallMove`), with no
 * card; it never cancels, retries or abandons on its own.
 */
export function createStallSweep(deps: {
  readonly state: StateStore;
  readonly inbox: Pick<InboxService, 'resolve'>;
  readonly waits: Pick<QueueWaits, 'get'>;
  /** Whether 10db's admission holds new work now: the load guard, low disk or an update's drain. */
  readonly held: () => boolean;
  /** The data dir, whose `logs/gate` holds each gate's log. */
  readonly dataDir: string;
  /** The fixed floor of a gate's timeout (`limits.gateTimeoutMs`). */
  readonly gateTimeoutFloorMs: number;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Stops a stalled run and queues it again (`Runner.restartStalled`). */
  restart(id: WorkstreamId): Promise<StallRestartResult>;
  /** Whether a restart of the run has not returned (`Runner.isRestarting`). */
  isRestarting(id: WorkstreamId): boolean;
  /** Whether the run has a live lane (`Runner.isRunning`). */
  isRunning(id: WorkstreamId): boolean;
  /** The recovery attempts a run may spend (`limits.maxRecoveryAttempts`). */
  readonly maxRecoveryAttempts: number;
}): StallSweep {
  let timer: Timer | null = null;
  let started = false;
  // Silence before this was the daemon being down or a run waiting on 10db's own admission. The sweep
  // made at the daemon's start is the earliest the daemon can have been running.
  let countFrom = deps.clock.now();

  /** What to do about one stall: the Stuck card, or the restart rule's move for an active run. */
  function moveFor(db: DbReader, stall: Stall, active: readonly ActiveRun[], now: Date): StallMove {
    const id = stall.workstreamId;
    if (stall.kind !== StallKind.Active || id === null) return StallMove.Card;
    const row = getWorkstreamRow(db, id);
    const gate = active.find((run) => run.id === id)?.gate;
    const fault =
      row.state === WorkstreamState.Starting
        ? StallFault.NeverStarted
        : gate !== undefined && now.getTime() - Date.parse(gate.startedAt) > gate.timeoutMs
          ? StallFault.GatePastLimit
          : !deps.isRunning(id)
            ? StallFault.NoLane
            : null;
    const record = readRestart(db, id);
    return stallMove({
      asking: isRuleAsking(db, stall.projectId, DecisionRule.StuckRun),
      kind: stall.kind,
      inFlight: deps.isRestarting(id),
      restarted: record !== null,
      stopHung: record !== null && record.stopHungAt !== null,
      recoveryLeft: row.recoveryAttempts < deps.maxRecoveryAttempts,
      fault,
    }).move;
  }

  /**
   * Starts the restart of a stalled run without waiting on it: the runner marks it in flight before it
   * returns, so the next sweep waits. A stop that hung, or a restart that failed, ends in today's Stuck
   * card, so every stall ends in a notice or a card.
   */
  function restartRun(stall: Stall): void {
    const id = stall.workstreamId;
    if (id === null) return;
    const hung = (reason: string): void => {
      deps.logger.warn({ workstreamId: id, reason }, 'a stalled run was not restarted');
      try {
        deps.state.write((ctx) => {
          const row = getWorkstreamRow(ctx.tx, id);
          if (!ACTIVE_STATES.has(row.state)) return;
          markHung(ctx, { id, state: row.state, at: ctx.now });
          flagCard(ctx, stallCard(stall));
        });
      } catch (error) {
        deps.logger.error(
          { workstreamId: id, err: error instanceof Error ? error.message : String(error) },
          'could not raise the Stuck card of a run whose restart failed',
        );
      }
    };
    deps
      .restart(id)
      .then((result) => {
        if (result === 'stop_hung') hung('its stop did not finish in time');
        else
          deps.logger.info(
            { workstreamId: id, result },
            'a stalled run was restarted by the stall sweep',
          );
      })
      .catch((error: unknown) => {
        hung(error instanceof Error ? error.message : String(error));
      });
  }

  function sweep(): void {
    const db = deps.state.db;
    const now = deps.clock.now();
    if (deps.held()) countFrom = now;
    const live = new Set(listActiveProjects(db).map((p) => p.id));
    const inLive = (w: { readonly projectId: ProjectId }): boolean => live.has(w.projectId);
    // A queued run no tick has looked at since the start has no wait yet: its card, and its batch's,
    // stay as they are until one has.
    const unknown = new Set<string>();
    const queued: QueuedRun[] = [];
    for (const run of listWorkstreams(db, { states: [WorkstreamState.Queued] }).filter(inLive)) {
      const wait = deps.waits.get(run.id);
      if (wait === undefined) {
        unknown.add(runStallKey(run.id));
        if (run.batchId !== null) unknown.add(batchStallKey(run.batchId));
        continue;
      }
      queued.push({ run, title: run.taskTitle, wait });
    }
    const active = listWorkstreams(db, {
      states: [WorkstreamState.Starting, WorkstreamState.Running, WorkstreamState.Verifying],
    })
      .filter(inLive)
      .map((run): ActiveRun => {
        const gate = liveGateOf(db, run.id, deps);
        return gate === null ? run : { ...run, gate };
      });
    // A copy waiting for its turn is not being cut, however long it waits.
    const waiting = new Set(queuedCopyBatchIds(db));
    const batches = listBatches(db, {
      states: [BatchState.Open, BatchState.Shipping, BatchState.Cutting],
    })
      .filter(inLive)
      .filter((batch) => !waiting.has(batch.id))
      .map((batch) => ({
        batch,
        members: latestPerTask(listWorkstreams(db, { batchId: batch.id })),
      }));
    const open = new Map(
      cardsResolvedByEvent(db, null).flatMap(({ item, when }) => {
        if (when.event !== 'stall_cleared') return [];
        const card = stallCardOf(item);
        return card === null ? [] : [[when.key, card] as const];
      }),
    );
    const found = findStalls({
      now,
      queued,
      active,
      batches,
      countFrom,
      carried: new Map([...open].map(([key, card]) => [key, card.since])),
    });
    // A stall that is waited on or restarted raises no card; one already open is kept as it is.
    const stalls: Stall[] = [];
    for (const stall of found) {
      const move = moveFor(db, stall, active, now);
      if (move === StallMove.Wait || move === StallMove.Restart) {
        unknown.add(stall.key);
        if (move === StallMove.Restart) restartRun(stall);
        continue;
      }
      stalls.push(stall);
    }
    const changed = stalls.filter((s) => open.get(s.key)?.fingerprint !== s.fingerprint);
    if (changed.length > 0)
      deps.state.write((ctx) => {
        for (const stall of changed) flagCard(ctx, stallCard(stall));
      });
    const current = new Set(stalls.map((s) => s.key));
    const closed = resolveStaleCards(db, deps.inbox, null, (when, item) =>
      when.event === 'stall_cleared' &&
      live.has(item.projectId) &&
      !current.has(when.key) &&
      !unknown.has(when.key)
        ? STALL_CLEARED_REASON
        : null,
    );
    if (changed.length > 0 || closed > 0)
      deps.logger.info(
        { component: 'stalls', raised: changed.map((s) => s.key), closed },
        'stall sweep changed its cards',
      );
  }

  function loop(): void {
    try {
      sweep();
    } catch (error) {
      deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'stall sweep failed',
      );
    }
    if (started) timer = deps.clock.setTimeout(loop, STALL.sweepMs);
  }

  return {
    sweep,
    start() {
      started = true;
      timer ??= deps.clock.setTimeout(loop, STALL.sweepMs);
    },
    stop() {
      started = false;
      timer?.cancel();
      timer = null;
    },
  };
}
