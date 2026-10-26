import {
  BatchState,
  Delivery,
  isTerminal,
  WorkstreamState,
  type BatchDto,
  type BatchId,
  type AccountId,
  type ProjectId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  acquireClaims,
  acquireLease,
  claimRequestsForTask,
  countLanes,
  dependenciesDone,
  getBatch,
  getAccountRow,
  getProject,
  getTask,
  getWorkstreamRow,
  listBatches,
  listWorkstreams,
  renewClaimLeases,
  renewLeases,
  transitionWorkstream,
} from '@10db/db';
import { unready, type AccountPreparer, type AccountRuntime } from '../accounts';
import type { Clock, Timer } from '../clock';
import { batchLaunchVerdict, LaunchVerdict } from '../delivery';
import type { StateStore } from '../events';
import type { Logger } from '../log';

export interface SchedulerOptions {
  readonly state: StateStore;
  readonly runner: {
    launch(id: WorkstreamId, fence: number): void;
    isRunning(id: WorkstreamId): boolean;
  };
  readonly accounts: Pick<AccountRuntime, 'blocked' | 'isPaused'> &
    Pick<AccountPreparer, 'prepare'>;
  readonly clock: Clock;
  readonly instanceId: string;
  readonly caps: { readonly global: number };
  readonly leaseMs: number;
  readonly tickMs: number;
  readonly logger: Logger;
  /** Reads the checkout's branch; asked once per tick for each pull-request project with queued work. */
  readonly branches: { currentBranch(repo: string): Promise<string | null> };
  /** An open batch's work waits because the checkout is on another branch. */
  readonly onWrongBranch: (batch: BatchDto, current: string | null, repoPath: string) => void;
}

export interface Scheduler {
  requestTick(): void;
  /** Launches what fits now; resolves to how many were launched. Ticks run one at a time. */
  tick(): Promise<number>;
  /** Settles once every tick requested or running now has finished; tests await it. */
  idle(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const db = opts.state.db;
  let timer: Timer | null = null;
  let pending = false;
  let started = false;
  // Batches whose work is waiting for its branch and already reported, so a tick doesn't repeat the card.
  const warned = new Set<BatchId>();

  /** Forgets a reported batch once it is no longer OPEN, so one that reopens is reported again. */
  function pruneWarned(): void {
    if (warned.size === 0) return;
    const open = new Set(listBatches(db, { states: [BatchState.Open] }).map((b) => b.id));
    for (const id of warned) if (!open.has(id)) warned.delete(id);
  }

  // A runner can write PAUSED_LIMIT after the pause's reset timer already fired, so the timer
  // found nothing to re-queue; work paused for an account that is no longer paused is re-queued here.
  function requeueExpiredPauses(): void {
    for (const ws of listWorkstreams(db, { states: [WorkstreamState.PausedLimit] })) {
      if (opts.runner.isRunning(ws.id)) continue;
      if (opts.accounts.isPaused(getProject(db, ws.projectId).accountId)) continue;
      // Asking can resume an account whose pause ended unnoticed, which re-queues this row itself.
      if (getWorkstreamRow(db, ws.id).state !== WorkstreamState.PausedLimit) continue;
      opts.state.write((ctx) => {
        transitionWorkstream(ctx, ws.id, {
          to: WorkstreamState.Queued,
          fence: null,
          patch: { pausedUntil: null },
          reason: 'the account resumed',
        });
      });
    }
  }

  function launchQueued(branches: ReadonlyMap<ProjectId, string | null>): number {
    const lanes = countLanes(db);
    let global = lanes.global;
    const byProject = new Map(lanes.byProject);
    const byAccount = new Map(lanes.byAccount);
    // Accounts a cap check found open this tick: it reads the month's spend, so it runs once per account.
    const open = new Set<AccountId>();
    // Accounts that can't start a session yet: the preparer is asked once per account per tick.
    const notReady = new Set<AccountId>();
    // Account and project pairs found blocked this tick: each project is asked once, so it gets its
    // own card, and a project with several queued lanes isn't asked again.
    const blockedThisTick = new Set<string>();
    let launched = 0;
    for (const ws of listWorkstreams(db, { states: [WorkstreamState.Queued] })) {
      if (global >= opts.caps.global) break;
      // A runner that just re-queued this row is still unwinding; launch() would refuse it and
      // leave it STARTING with a lane. Its lane-freed callback ticks again once it has exited.
      if (opts.runner.isRunning(ws.id)) continue;
      const project = getProject(db, ws.projectId);
      const account = getAccountRow(db, project.accountId);
      if (notReady.has(account.id)) continue;
      if (!open.has(account.id) && unready(account)) {
        opts.accounts.prepare(account, project.id);
        notReady.add(account.id);
        continue;
      }
      if (!open.has(account.id)) {
        const asked = `${account.id}:${project.id}`;
        if (blockedThisTick.has(asked)) continue;
        if (opts.accounts.blocked(account, project.id) !== null) {
          blockedThisTick.add(asked);
          continue;
        }
        open.add(account.id);
      }
      if ((byProject.get(project.id) ?? 0) >= project.maxLanes) continue;
      if ((byAccount.get(account.id) ?? 0) >= account.laneCap) continue;
      if (project.delivery === Delivery.PullRequest) {
        // Read after this tick's branch snapshot: wait for the next tick rather than guess.
        if (!branches.has(project.id)) continue;
        const current = branches.get(project.id) ?? null;
        const batch = ws.batchId ? getBatch(db, ws.batchId) : null;
        const verdict = batchLaunchVerdict(batch, current);
        if (verdict === LaunchVerdict.WrongBranch && batch && !warned.has(batch.id)) {
          warned.add(batch.id);
          opts.onWrongBranch(batch, current, project.repoPath);
        }
        if (verdict !== LaunchVerdict.Launch) continue;
        if (batch) warned.delete(batch.id);
      }
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
      byAccount.set(account.id, (byAccount.get(account.id) ?? 0) + 1);
      launched += 1;
      opts.runner.launch(ws.id, fence);
    }
    return launched;
  }

  /** The checkout's branch for each pull-request project with queued work, read once per tick. */
  async function branchSnapshot(): Promise<Map<ProjectId, string | null>> {
    const repos = new Map<ProjectId, string>();
    for (const ws of listWorkstreams(db, { states: [WorkstreamState.Queued] })) {
      const project = getProject(db, ws.projectId);
      if (project.delivery === Delivery.PullRequest) repos.set(project.id, project.repoPath);
    }
    const out = new Map<ProjectId, string | null>();
    for (const [id, repo] of repos)
      out.set(id, await opts.branches.currentBranch(repo).catch(() => null));
    return out;
  }

  let chain: Promise<unknown> = Promise.resolve();
  function tick(): Promise<number> {
    const run = chain.then(async () => {
      requeueExpiredPauses();
      pruneWarned();
      return launchQueued(await branchSnapshot());
    });
    chain = run.catch(() => undefined);
    return run;
  }

  /** A requestTick() schedules its tick in a microtask; let that run first, then wait for the chain. */
  async function idle(): Promise<void> {
    await Promise.resolve();
    await chain;
  }

  const logTickError = (error: unknown): void => {
    opts.logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'scheduler tick failed',
    );
  };

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
    } catch (error) {
      logTickError(error);
    }
    void tick()
      .catch(logTickError)
      .finally(() => {
        if (started) timer = opts.clock.setTimeout(loop, opts.tickMs);
      });
  }

  return {
    tick,
    idle,
    requestTick() {
      // Before start() the daemon is still recovering; the first loop and start's own tick cover it.
      if (pending || !started) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        if (!started) return;
        void tick().catch(logTickError);
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
