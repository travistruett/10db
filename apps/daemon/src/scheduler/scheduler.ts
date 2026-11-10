import {
  BatchState,
  ClaimKind,
  Delivery,
  isTerminal,
  passHeldAreas,
  PASS_FOLDER_WAIT_LINE,
  PASS_FOLDER_WAIT_NOTICE_KEY,
  PASS_PR_WAIT_LINE,
  PassState,
  queueOrder,
  PassTurnEnding,
  TakeOutStep,
  WorkstreamState,
  type BatchDto,
  type BatchId,
  type AccountId,
  type PassDto,
  type PassId,
  type ProjectDto,
  type TaskDto,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  acquireClaims,
  acquireLease,
  claimRequestsForTask,
  copyHazardNames,
  countLanes,
  dependenciesDone,
  findOpenPass,
  getBatch,
  getAccountRow,
  getProject,
  getTask,
  getTaskMessageRow,
  getWorkstreamRow,
  lastTakeOut,
  listBatches,
  listProjects,
  listWorkstreams,
  latestPassTurn,
  passHoldingFolder,
  passHoldingTask,
  renewClaimLeases,
  renewLeases,
  setWorkstreamNotice,
  transitionWorkstream,
} from '@10db/db';
import {
  unready,
  type AccountPreparer,
  type AccountRuntime,
  type ModelListWait,
} from '../accounts';
import type { Clock, Timer } from '../clock';
import { batchLaunchVerdict, claimScopeOf, LaunchVerdict } from '../delivery';
import type { StateStore } from '../events';
import { existsAsEntry, GitTrustError } from '../git';
import type { Logger } from '../log';
import { folderCardOpen, folderSeenOn } from '../pass';
import { untakenMessages } from '../runner';
import { roomForLane } from './lane-room';
import { passLaunch, PassLaunch } from './pass-launch';
import { FREE_SESSION_WAIT_KEY, freeSessionWait, laneToYield, type WarmLane } from './warm-yield';

export interface SchedulerOptions {
  readonly state: StateStore;
  readonly runner: {
    launch(id: WorkstreamId, fence: number): void;
    isRunning(id: WorkstreamId): boolean;
    /** Closes a pass task's warm session, freeing its lane, unless a message waits for it. */
    closeWarm(id: WorkstreamId): Promise<void>;
  };
  readonly accounts: Pick<AccountRuntime, 'blocked' | 'isPaused'> &
    Pick<AccountPreparer, 'prepare'> & {
      /**
       * A session may start on this ready account: its model list is read if it is a day old. Asked once per
       * account per tick; it returns at once and the read goes on behind it.
       */
      readList?(id: AccountId): void;
    };
  readonly clock: Clock;
  readonly instanceId: string;
  readonly caps: { readonly global: number };
  readonly leaseMs: number;
  readonly tickMs: number;
  readonly logger: Logger;
  /** Reads a checkout's branch; asked once per tick for each checkout with queued pull-request work. */
  readonly branches: { currentBranch(repo: string): Promise<string | null> };
  /** An open batch's work waits because its checkout (its worktree, when it has one) is on another branch. */
  readonly onWrongBranch: (batch: BatchDto, current: string | null, checkout: string) => void;
  /** An open batch's work waits because its worktree is gone. */
  readonly onWorktreeMissing: (batch: BatchDto, path: string) => void;
  /**
   * The workstreams holding a claim that a running task waits for inside request_claim. Such a waiter
   * keeps its lane, so a holder that has to queue for a lane launches over every lane cap; otherwise
   * waiters filling the lanes would keep it, and so themselves, waiting for ever.
   */
  readonly awaitedHolders?: () => ReadonlySet<WorkstreamId>;
  /**
   * True while the Mac is overloaded: no queued work launches, awaited holders included, and it
   * launches again on the first tick after this answers false.
   */
  readonly held?: () => boolean;
  /**
   * The account whose browser sign-in is under way. It replaces the login sessions run on, so nothing
   * starts on it until the sign-in is over.
   */
  readonly connecting?: () => { readonly accountId: AccountId } | null;
  /** Accounts with no model profile yet: their queued work is left alone, not claimed and given back each tick. */
  readonly modelWait?: Pick<ModelListWait, 'holds'>;
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

/** What one tick read: each checkout's branch, and the worktrees that were not on disk. */
interface CheckoutSnapshot {
  readonly branches: ReadonlyMap<string, string | null>;
  readonly missing: ReadonlySet<string>;
}

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const db = opts.state.db;
  let timer: Timer | null = null;
  let pending = false;
  let started = false;
  /** Set by `stop()`, cleared by `start()`: a tick that was reading branches launches nothing. */
  let halted = false;
  // Batches whose work is waiting for its branch and already reported, so a tick doesn't repeat the card.
  const warned = new Set<BatchId>();
  // Batches whose work is waiting for a missing worktree and already reported.
  const warnedMissing = new Set<BatchId>();

  /** Forgets a reported batch once it is no longer OPEN, so one that reopens is reported again. */
  function pruneWarned(): void {
    if (warned.size === 0 && warnedMissing.size === 0) return;
    const open = new Set(listBatches(db, { states: [BatchState.Open] }).map((b) => b.id));
    for (const id of warned) if (!open.has(id)) warned.delete(id);
    for (const id of warnedMissing) if (!open.has(id)) warnedMissing.delete(id);
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

  /**
   * Shows on a task in Your folder that it waits for the pass holding the folder: for its close, or
   * once closed for its pull request to merge (D22). Written when what it says changes, and never
   * over another notice: a parked, left-out or reverted run's notice says what the builder must know,
   * and the run's card says it waits.
   */
  function waitForPass(id: WorkstreamId, pass: PassDto): void {
    const line = pass.state === PassState.Closed ? PASS_PR_WAIT_LINE : PASS_FOLDER_WAIT_LINE;
    const stale = (notice: WorkstreamDto['notice']): boolean =>
      notice === null || (notice.key === PASS_FOLDER_WAIT_NOTICE_KEY && notice.line !== line);
    if (!stale(getWorkstreamRow(db, id).notice)) return;
    opts.state.write((ctx) => {
      if (!stale(getWorkstreamRow(ctx.tx, id).notice)) return;
      setWorkstreamNotice(ctx, id, {
        key: PASS_FOLDER_WAIT_NOTICE_KEY,
        tone: 'info',
        line,
        body: `Your folder is in the Workbench pass "${pass.name}". This task starts there once the pass has closed and its work is in the base.`,
      });
    });
  }

  /**
   * Whether a queued page of the pass has a turn to run now (Workbench spec §5.5): read from its rows
   * and from this tick's read of Your folder's branch, never from its next action.
   */
  function passPageRuns(
    ws: WorkstreamDto,
    task: TaskDto,
    pass: PassDto,
    project: ProjectDto,
    snapshot: CheckoutSnapshot,
    folderHeld: Set<PassId>,
  ): boolean {
    const takeOut = lastTakeOut(db, task.id);
    const read = snapshot.branches.has(project.repoPath);
    const latest = latestPassTurn(db, task.id);
    const untaken = untakenMessages(db, task.id);
    const stoppedAt = latest?.ending === PassTurnEnding.Stopped ? latest.endedAt : null;
    const verdict = passLaunch({
      passState: pass.state,
      takingOut: takeOut?.passId === pass.id && takeOut.step < TakeOutStep.Done,
      untaken: untaken.length > 0,
      stopped: stoppedAt !== null,
      writtenSinceStop:
        stoppedAt !== null &&
        untaken.some((messageId) => getTaskMessageRow(db, messageId).createdAt > stoppedAt),
      turnUnsettled: latest?.settledAt === null,
      folderOn: read
        ? snapshot.branches.get(project.repoPath) === getBatch(db, pass.batchId).branch
        : null,
    });
    if (verdict !== PassLaunch.Launch)
      opts.logger.debug({ workstreamId: ws.id, passId: pass.id, verdict }, 'pass page held');
    // A page with a turn to run that Your folder holds back: the pass's card says why.
    if (verdict === PassLaunch.FolderOff && read) folderHeld.add(pass.id);
    return verdict === PassLaunch.Launch;
  }

  /**
   * Each open pass's folder card by this tick's read of Your folder (Workbench spec §5.1, §12): raised
   * once for a pass whose page has a turn to run and the folder off the pass's branch, and withdrawn
   * once the folder is back on it, whatever its pages wait for. A folder this tick did not read
   * changes nothing.
   */
  function showPassFolders(snapshot: CheckoutSnapshot, folderHeld: ReadonlySet<PassId>): void {
    for (const project of listProjects(db)) {
      const pass = findOpenPass(db, project.id);
      if (pass?.state !== PassState.Open || !snapshot.branches.has(project.repoPath)) continue;
      const found = snapshot.branches.get(project.repoPath) ?? null;
      const on = found === getBatch(db, pass.batchId).branch;
      if (on || folderHeld.has(pass.id) || folderCardOpen(db, pass))
        folderSeenOn(opts, pass, found);
    }
  }

  /** A pass task's sessions open between turns, each holding a lane, with when its turn ended. */
  function warmLanes(): WarmLane[] {
    return listWorkstreams(db, { states: [WorkstreamState.WaitingHuman] }).flatMap((ws) => {
      if (ws.currentSessionId === null || ws.nextAction.kind !== 'pass_review') return [];
      if (!opts.runner.isRunning(ws.id)) return [];
      const pass = passHoldingTask(db, getTask(db, ws.taskId));
      if (!pass) return [];
      return [
        {
          id: ws.id,
          passId: pass.id,
          accountId: getProject(db, ws.projectId).accountId,
          idleSince: latestPassTurn(db, ws.taskId)?.readyAt ?? ws.updatedAt,
        },
      ];
    });
  }

  /** Shows on a page that it waits for a session to free up; never over another notice. */
  function waitForSession(id: WorkstreamId, working: number): void {
    const notice = getWorkstreamRow(db, id).notice;
    if (notice !== null && notice.key !== FREE_SESSION_WAIT_KEY) return;
    const next = freeSessionWait(working);
    if (notice?.line === next.line) return;
    opts.state.write((ctx) => {
      setWorkstreamNotice(ctx, id, next);
    });
  }

  /** Takes down the pass's wait once the run no longer waits for it; any other notice stays. */
  function endPassWait(id: WorkstreamId): void {
    opts.state.write((ctx) => {
      if (getWorkstreamRow(ctx.tx, id).notice?.key === PASS_FOLDER_WAIT_NOTICE_KEY)
        setWorkstreamNotice(ctx, id, null);
    });
  }

  function launchQueued(snapshot: CheckoutSnapshot): number {
    if (opts.held?.()) return 0;
    const signingIn = opts.connecting?.()?.accountId ?? null;
    const lanes = countLanes(db);
    let global = lanes.global;
    const byProject = new Map(lanes.byProject);
    const byAccount = new Map(lanes.byAccount);
    const byPass = new Map(lanes.byPass);
    // Accounts a cap check found open this tick: it reads the month's spend, so it runs once per account.
    const open = new Set<AccountId>();
    // Accounts that can't start a session yet: the preparer is asked once per account per tick.
    const notReady = new Set<AccountId>();
    // Account and project pairs found blocked this tick: each project is asked once, so it gets its
    // own card, and a project with several queued lanes isn't asked again.
    const blockedThisTick = new Set<string>();
    const awaited = opts.awaitedHolders?.() ?? new Set<WorkstreamId>();
    let launched = 0;
    // Read once a tick, when work first has no room; a session asked to close leaves it.
    let warm: WarmLane[] | null = null;
    /**
     * Work that could start has no room: the warm session idle longest that makes room closes, and
     * the work starts on the tick its lane frees. A page with none to close says it waits.
     */
    const makeRoom = (
      ws: (typeof line)[number],
      ask: { accountId: AccountId; pass: PassDto | null },
    ): void => {
      const full = {
        global: global >= opts.caps.global,
        account: (byAccount.get(ask.accountId) ?? 0) >= getAccountRow(db, ask.accountId).laneCap,
        pass: ask.pass !== null && (byPass.get(ask.pass.id) ?? 0) >= ask.pass.pageCap,
      };
      warm ??= warmLanes();
      const yielded = laneToYield(warm, {
        accountId: ask.accountId,
        passId: ask.pass?.id ?? null,
        full,
      });
      if (yielded !== null) {
        warm = warm.filter((w) => w.id !== yielded);
        void opts.runner.closeWarm(yielded).catch((error: unknown) => {
          opts.logger.warn(
            { workstreamId: yielded, err: error instanceof Error ? error.message : String(error) },
            'a warm session did not close',
          );
        });
        return;
      }
      if (ask.pass === null) return;
      const working = full.global
        ? global
        : full.account
          ? (byAccount.get(ask.accountId) ?? 0)
          : (byPass.get(ask.pass.id) ?? 0);
      waitForSession(ws.id, working);
    };
    const line = listWorkstreams(db, { states: [WorkstreamState.Queued] }).toSorted(queueOrder);
    // Open passes whose page this tick held for Your folder being off the pass's branch.
    const folderHeld = new Set<PassId>();
    for (const ws of line) {
      const overCaps = awaited.has(ws.id);
      // At the daemon-wide cap ordinary work waits, unless a warm pass session could close for it;
      // a page goes on to say it waits. The room check below decides either.
      if (
        !overCaps &&
        global >= opts.caps.global &&
        (warm ??= warmLanes()).length === 0 &&
        !passHoldingTask(db, getTask(db, ws.taskId))
      )
        continue;
      // A runner that just re-queued this row is still unwinding; launch() would refuse it and
      // leave it STARTING with a lane. Its lane-freed callback ticks again once it has exited.
      if (opts.runner.isRunning(ws.id)) continue;
      const task = getTask(db, ws.taskId);
      const project = getProject(db, ws.projectId);
      // A pass task runs a turn only when its pass's rows say so (Workbench spec §5.5), while the
      // pass holds it.
      const inPass = passHoldingTask(db, task) ?? null;
      if (inPass && !passPageRuns(ws, task, inPass, project, snapshot, folderHeld)) continue;
      const batch = ws.batchId ? getBatch(db, ws.batchId) : null;
      // Nothing else runs in Your folder while a pass holds it (W9): the task waits, saying so.
      const holding =
        inPass === null && batch?.worktreePath == null
          ? passHoldingFolder(db, project.id)
          : undefined;
      if (holding) {
        waitForPass(ws.id, holding);
        continue;
      }
      if (ws.notice?.key === PASS_FOLDER_WAIT_NOTICE_KEY) endPassWait(ws.id);
      const account = getAccountRow(db, project.accountId);
      if (account.id === signingIn) continue;
      if (opts.modelWait?.holds(account.id)) continue;
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
        opts.accounts.readList?.(account.id);
        open.add(account.id);
      }
      const room = roomForLane(
        { global, byProject, byAccount, byPass },
        {
          projectId: project.id,
          accountId: account.id,
          pass: inPass && { id: inPass.id, pageCap: inPass.pageCap },
          global: opts.caps.global,
          maxLanes: project.maxLanes,
          accountCap: account.laneCap,
        },
      );
      let needsRoom = false;
      if (!overCaps && !room) {
        // A project's own limit is never freed by a warm session, which it does not count.
        if (inPass === null && (byProject.get(project.id) ?? 0) >= project.maxLanes) continue;
        // A warm session closes only for work that could start once it has: after every check.
        needsRoom = true;
      }
      // A pass's folder was read for its branch above; its off-branch card is the pass's own.
      if (inPass === null && project.delivery === Delivery.PullRequest) {
        const checkout = batch?.worktreePath ?? project.repoPath;
        // A worktree that isn't on disk holds the batch's work with one card; it never launches.
        if (batch && snapshot.missing.has(checkout)) {
          if (!warnedMissing.has(batch.id)) {
            warnedMissing.add(batch.id);
            opts.onWorktreeMissing(batch, checkout);
          }
          continue;
        }
        if (batch) warnedMissing.delete(batch.id);
        // Read after this tick's branch snapshot: wait for the next tick rather than guess.
        if (!snapshot.branches.has(checkout)) continue;
        const current = snapshot.branches.get(checkout) ?? null;
        const verdict = batchLaunchVerdict(batch, current);
        if (verdict === LaunchVerdict.WrongBranch && batch && !warned.has(batch.id)) {
          warned.add(batch.id);
          opts.onWrongBranch(batch, current, checkout);
        }
        if (verdict !== LaunchVerdict.Launch) continue;
        if (batch) warned.delete(batch.id);
      }
      if (!dependenciesDone(db, ws.taskId)) continue;
      // A parked task never launches, whatever its queue holds.
      if (task.boardColumnId !== null) continue;
      if (needsRoom) {
        makeRoom(ws, { accountId: account.id, pass: inPass });
        continue;
      }
      const leaseUntil = new Date(opts.clock.now().getTime() + opts.leaseMs).toISOString();
      const areaScope = claimScopeOf(db, ws);
      // A page holds its pass's areas for its life; one that waited at the open for a page another
      // task held claims it here, and runs only once it has it.
      const requests = inPass
        ? passHeldAreas(project.areas, task).map((name) => ({ kind: ClaimKind.Area, name }))
        : claimRequestsForTask(task, project);
      const fence = opts.state.write((ctx) => {
        const claimed = acquireClaims(ctx, {
          projectId: project.id,
          workstreamId: ws.id,
          requests,
          copyHazards: copyHazardNames(project),
          leaseExpiresAt: leaseUntil,
          ...(areaScope ? { areaScope } : {}),
        });
        if (!claimed.ok) return null;
        const f = acquireLease(ctx, ws.id, opts.instanceId, leaseUntil);
        transitionWorkstream(ctx, ws.id, {
          to: WorkstreamState.Starting,
          fence: f,
          patch: { runNextAt: null },
          reason: 'lane granted',
        });
        return f;
      });
      if (fence === null) continue;
      if (ws.notice?.key === FREE_SESSION_WAIT_KEY)
        opts.state.write((ctx) => {
          setWorkstreamNotice(ctx, ws.id, null);
        });
      global += 1;
      if (inPass) byPass.set(inPass.id, (byPass.get(inPass.id) ?? 0) + 1);
      else byProject.set(project.id, (byProject.get(project.id) ?? 0) + 1);
      byAccount.set(account.id, (byAccount.get(account.id) ?? 0) + 1);
      launched += 1;
      opts.runner.launch(ws.id, fence);
    }
    showPassFolders(snapshot, folderHeld);
    return launched;
  }

  /**
   * The branch of each checkout with queued pull-request work or a queued page of a pass, read once per
   * tick. A worktree is read only while its batch is open and cut, so work in a batch still being cut
   * waits without touching disk.
   */
  async function branchSnapshot(): Promise<CheckoutSnapshot> {
    const checkouts = new Set<string>();
    const missing = new Set<string>();
    for (const ws of listWorkstreams(db, { states: [WorkstreamState.Queued] })) {
      const project = getProject(db, ws.projectId);
      // A pass's page runs only while Your folder names the pass's branch, on any delivery.
      if (passHoldingTask(db, getTask(db, ws.taskId))) {
        checkouts.add(project.repoPath);
        continue;
      }
      if (project.delivery !== Delivery.PullRequest) continue;
      const batch = ws.batchId ? getBatch(db, ws.batchId) : null;
      if (batch?.worktreePath == null) {
        checkouts.add(project.repoPath);
        continue;
      }
      if (batch.state !== BatchState.Open || batch.branch === null || batch.baseSha === null)
        continue;
      if (existsAsEntry(batch.worktreePath)) checkouts.add(batch.worktreePath);
      else missing.add(batch.worktreePath);
    }
    // A pass's folder card is withdrawn once Your folder is back, though no page of it is queued.
    for (const project of listProjects(db)) {
      const pass = findOpenPass(db, project.id);
      if (pass?.state === PassState.Open && folderCardOpen(db, pass))
        checkouts.add(project.repoPath);
    }
    const branches = new Map<string, string | null>();
    for (const path of checkouts) {
      try {
        branches.set(path, await opts.branches.currentBranch(path));
      } catch (error) {
        // A checkout git refuses has a card of its own: its work waits, with no wrong-branch card.
        if (!(error instanceof GitTrustError)) branches.set(path, null);
      }
    }
    return { branches, missing };
  }

  let chain: Promise<unknown> = Promise.resolve();
  function tick(): Promise<number> {
    const run = chain.then(async () => {
      requeueExpiredPauses();
      pruneWarned();
      const snapshot = await branchSnapshot();
      // Stopped while the branches were read: whoever stopped it (a shutdown, the self-update before
      // it quits the app) counts on no lane starting afterwards.
      if (halted) return 0;
      return launchQueued(snapshot);
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
      halted = false;
      timer ??= opts.clock.setTimeout(loop, opts.tickMs);
    },
    stop() {
      started = false;
      halted = true;
      timer?.cancel();
      timer = null;
    },
  };
}
