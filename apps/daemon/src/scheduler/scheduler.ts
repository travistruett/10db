import { isTerminal, WorkstreamState, type Provider, type WorkstreamId } from '@10db/contracts';
import {
  acquireClaims,
  acquireLease,
  claimRequestsForTask,
  countLanes,
  dependenciesDone,
  getProject,
  getTask,
  listWorkstreams,
  renewClaimLeases,
  renewLeases,
  transitionWorkstream,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { Logger } from '../log';

export interface SchedulerOptions {
  readonly state: StateStore;
  readonly runner: {
    launch(id: WorkstreamId, fence: number): void;
    isRunning(id: WorkstreamId): boolean;
  };
  readonly pauses: { isPaused(provider: Provider): boolean };
  readonly clock: Clock;
  readonly instanceId: string;
  readonly caps: { readonly global: number; readonly perProvider: number };
  readonly leaseMs: number;
  readonly tickMs: number;
  readonly logger: Logger;
}

export interface Scheduler {
  requestTick(): void;
  /** Launches what fits now; returns how many were launched. */
  tick(): number;
  start(): void;
  stop(): void;
}

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const db = opts.state.db;
  let timer: Timer | null = null;
  let pending = false;
  let started = false;

  // A runner can write PAUSED_LIMIT after the pause's reset timer already fired, so the timer
  // found nothing to re-queue; work paused for a provider that is no longer paused is re-queued here.
  function requeueExpiredPauses(): void {
    for (const ws of listWorkstreams(db, { states: [WorkstreamState.PausedLimit] })) {
      if (opts.runner.isRunning(ws.id)) continue;
      if (opts.pauses.isPaused(getProject(db, ws.projectId).provider)) continue;
      opts.state.write((ctx) => {
        transitionWorkstream(ctx, ws.id, {
          to: WorkstreamState.Queued,
          fence: null,
          patch: { pausedUntil: null },
          reason: 'usage limit reset',
        });
      });
    }
  }

  function tick(): number {
    requeueExpiredPauses();
    const lanes = countLanes(db);
    let global = lanes.global;
    const byProject = new Map(lanes.byProject);
    const byProvider = new Map(lanes.byProvider);
    let launched = 0;
    for (const ws of listWorkstreams(db, { states: [WorkstreamState.Queued] })) {
      if (global >= opts.caps.global) break;
      // A runner that just re-queued this row is still unwinding; launch() would refuse it and
      // leave it STARTING with a lane. Its lane-freed callback ticks again once it has exited.
      if (opts.runner.isRunning(ws.id)) continue;
      const project = getProject(db, ws.projectId);
      if (opts.pauses.isPaused(project.provider)) continue;
      if ((byProject.get(project.id) ?? 0) >= project.maxLanes) continue;
      if ((byProvider.get(project.provider) ?? 0) >= opts.caps.perProvider) continue;
      if (!dependenciesDone(db, ws.taskId)) continue;
      const task = getTask(db, ws.taskId);
      // A parked task never launches, whatever its queue holds.
      if (task.boardColumnId !== null) continue;
      const leaseUntil = new Date(opts.clock.now().getTime() + opts.leaseMs).toISOString();
      const fence = opts.state.write((ctx) => {
        const claimed = acquireClaims(ctx, {
          projectId: project.id,
          workstreamId: ws.id,
          requests: claimRequestsForTask(task, project),
          leaseExpiresAt: leaseUntil,
        });
        if (!claimed.ok) return null;
        const f = acquireLease(ctx, ws.id, opts.instanceId, leaseUntil);
        transitionWorkstream(ctx, ws.id, {
          to: WorkstreamState.Starting,
          fence: f,
          reason: 'lane granted',
        });
        return f;
      });
      if (fence === null) continue;
      global += 1;
      byProject.set(project.id, (byProject.get(project.id) ?? 0) + 1);
      byProvider.set(project.provider, (byProvider.get(project.provider) ?? 0) + 1);
      launched += 1;
      opts.runner.launch(ws.id, fence);
    }
    return launched;
  }

  function heartbeat(): void {
    const leaseUntil = new Date(opts.clock.now().getTime() + opts.leaseMs).toISOString();
    opts.state.write((ctx) => {
      renewLeases(ctx, opts.instanceId, leaseUntil);
      const mine = listWorkstreams(ctx.tx)
        .filter((w) => !isTerminal(w.state))
        .map((w) => w.id);
      renewClaimLeases(ctx, mine, leaseUntil);
    });
  }

  function loop(): void {
    try {
      heartbeat();
      tick();
    } catch (error) {
      opts.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'scheduler tick failed',
      );
    }
    timer = opts.clock.setTimeout(loop, opts.tickMs);
  }

  return {
    tick,
    requestTick() {
      // Before start() the daemon is still recovering; the first loop and start's own tick cover it.
      if (pending || !started) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        if (!started) return;
        try {
          tick();
        } catch (error) {
          opts.logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            'scheduler tick failed',
          );
        }
      });
    },
    start() {
      started = true;
      timer ??= opts.clock.setTimeout(loop, opts.tickMs);
    },
    stop() {
      started = false;
      timer?.cancel();
      timer = null;
    },
  };
}
