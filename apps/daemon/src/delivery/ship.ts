import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BatchFailure,
  BatchState,
  ConflictError,
  EvidenceKind,
  InvalidError,
  isTerminal,
  LANE_STATES,
  latestPerTask,
  LEFT_OUT_NOTICE_KEY,
  McpToolName,
  McpToolOutputs,
  shipReadiness,
  ShipReadiness,
  StepRole,
  StepStatus,
  TaskStatus,
  WorkstreamState,
  type BatchDto,
  type BatchId,
  type Notice,
  type ProjectDto,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  clearBatchNotice,
  clearLease,
  getBatch,
  getProject,
  getTask,
  getWorkstream,
  hasToolOp,
  listBatches,
  listEvidence,
  listPermissionRules,
  listToolOpResults,
  listWorkstreams,
  openItemsForWorkstream,
  patchBatch,
  patchWorkstream,
  releaseClaims,
  setBatchNotice,
  setTaskStatus,
  setWorkstreamNotice,
  transitionBatch,
  transitionWorkstream,
  type DbReader,
} from '@10db/db';
import type { Clock } from '../clock';
import { comparablePath, GitNetworkError, GitNetworkFailure, samePath } from '../git';
import { gateNote as overloadNote, type LoadGuard } from '../load';
import {
  MergeBlocked,
  PrMergeable,
  PrState,
  type PullRequest,
  type PullRequestStatus,
  type RequiredChecks,
} from '../github';
import { commitResolvedMarkers, insertPlannedWorkstream, revertOfRun } from '../team';
import { raiseGateHostCards, withdrawCard } from '../inbox';
import { takeFoundHostsReading } from '../registries';
import { BlockedRun, type GateResult, type GateRunner } from '../verify';
import { gateNote, type BaseUpdate, type BaseUpdates } from './base-update';
import { BATCH_CARD_DETAIL, type KeptRevert } from './batch-card';
import { settleBranch } from './branch-cleanup';
import {
  autoMergeOffKey,
  autoMergeRefusedKey,
  detailOf,
  leftOutCards,
  leftOutFoldKey,
  type LeftOutAttempt,
  nothingToWaitFor,
  preCheckOnlyKey,
  prCardKey,
  prCards,
  shipCards,
  wrongBranchCard,
  type CatchUpStop,
  type Card,
  type ShipCheckName,
  type ShipFailure,
} from './cards';
import { allCheckouts, projectAtCheckout } from './checkout';
import { returnCheckout } from './checkout-return';
import { keptRevertOf, settleLeftOutCards } from './left-out-settle';
import { resolveShipCards } from './stale-cards';
import {
  ghCall,
  hideNotices,
  networkCall,
  pushCall,
  raise,
  showNotice,
  withdraw,
  withdrawIn,
  type DeliveryContext,
  type DeliveryLimits,
} from './context';
import { fileFlakyTests, rerunFlaky, type FlakyTest } from './flaky-tests';
import { readGateFailures, touchedBy, type GateStepFailure } from './gate-failures';
import { jobKey, JobQueue } from './jobs';
import { shipCheck } from './local-check';
import {
  gateNotices,
  leftOutNotices,
  mergeNotices,
  migrationNotices,
  NOTICE_KEY,
  supersededNotices,
  updateNotices,
} from './notices';
import { readPrScopes, scopeOf } from './pr-scopes';
import type { RetryMergeOptions } from './pr-watch';
import { prBody, prSubject, prTitle, titlePrefix } from './pr-text';
import { readPrTemplate } from './pr-template';
import { retireWorktree } from './worktree-cleanup';
import { madeWorktreeRoot, worktreePathFor } from './worktree-path';
import { ensureWorktreeWhole, reopenWorktreeBatch } from './worktree-repair';

/**
 * How long a pull request 10db failed to catch up waits before 10db tries it again at the same
 * head: the base may have changed, or the builder fixed what kept it out. A new head tries at once.
 */
const CATCH_UP_RETRY_MS = 30 * 60_000;

/** How the message of a Ship without it's revert commit opens; `undoneOnBranch` finds them by it. */
const LEFT_OUT_SUBJECT = 'revert: leave out ';

/** How long a merge GitHub refused waits before 10db asks again while the pull request stays clean. */
const MERGE_RETRY_MS = 10 * 60_000;

/** Batch states whose work runs, and ends by itself: its worktree goes when it does. */
const RUNNING_BATCH: readonly BatchState[] = [
  BatchState.Cutting,
  BatchState.Open,
  BatchState.Shipping,
];

/** True when GitHub says the open pull request conflicts with its base. */
const conflicting = (status: PullRequestStatus): boolean =>
  status.mergeBlocked === MergeBlocked.Conflicts || status.mergeable === PrMergeable.Conflicting;

/**
 * True when the open pull request's head has no check at all while GitHub waits for a required one:
 * the workflows never started. A head with any check, running or finished, is never this.
 */
const checksNeverStarted = (status: PullRequestStatus): boolean =>
  status.state === PrState.Open &&
  status.checks === 'none' &&
  status.blockedOnChecks &&
  !conflicting(status);

/** Why 10db merges the base into a shipped pull request: it conflicts, or its head never got its checks. */
type CatchUpCause = 'conflict' | 'checks';

export interface ShipperDeps extends DeliveryContext {
  readonly gate: GateRunner;
  /** The daemon's one set of base updates, shared with the runner, so a batch's gates run in turn. */
  readonly baseUpdates: BaseUpdates;
  readonly clock: Clock;
  readonly dataDir: string;
  /** The gate runs in the session environment, as a task's gate does. */
  sessionEnv(project: ProjectDto): Readonly<Record<string, string>>;
  identifyProcess?(pid: number): Promise<string | null>;
  /** True while a runner holds the workstream (its lane is live). */
  isRunning(id: WorkstreamId): boolean;
  /** Says whether the Mac was overloaded while a gate ran, so a failed gate's card can say so. */
  readonly load?: Pick<LoadGuard, 'overloadedSince'>;
  /**
   * True while a waiting update drains the factory: no ship and no catch-up begins, and one under way
   * runs on. A batch whose work is done stays open and `checkOpenBatches` ships it once this is false
   * again; a ship the builder asks for is refused, as the pull request watch's catch-up is left for
   * its next round.
   */
  readonly holdShips?: () => boolean;
}

export interface Shipper {
  checkBatch(batchId: BatchId): void;
  checkOpenBatches(): void;
  /**
   * Checks the open batches that still hold an attempt its task started over from: one waits for the
   * replacement's cut (`members`), so each time a cut ends they are looked at again.
   */
  checkSupersededBatches(): void;
  resume(batchId: BatchId): void;
  /** A task drawer on the Board: Ship anyway from OPEN, or Retry from FAILED, which reopens unfinished work. */
  ship(batchId: BatchId): BatchDto;
  /** A failed member's card: ships an open or failed batch whose work is settled, and never reopens one. */
  shipAnyway(batchId: BatchId): BatchDto;
  /**
   * A failed member's card: reverts the commits of that run's task, and of every other member that
   * failed, on the batch's branch in one commit that names them, marks those runs as left out of the
   * pull request, and ships the finished tasks. Refused like `shipAnyway` while work is unfinished,
   * and when no task finished. The revert runs in the ship queue: one that conflicts, would bring
   * conflict markers back, or meets uncommitted changes, ships nothing, leaves the branch and the
   * batch as they were, and raises a card naming the files that can answer Ship without it again.
   * `kept` is the revert commit an earlier answer left on the branch, read from the card: the commits
   * it covers are not reverted again, and the notices name it.
   */
  shipWithout(batchId: BatchId, workstreamId: WorkstreamId, kept?: KeptRevert): BatchDto;
  abandon(batchId: BatchId): BatchDto;
  /**
   * The open pull request of a shipped batch that merges by itself conflicts with its base: merges the
   * base into its branch in a worktree made for it, checks the result as shipping does, pushes it onto
   * the pull request and retires the worktree. A conflict 10db can't settle, or a check that fails,
   * is one card that names the files. Queued in the ship queue; a call for a pull request already
   * queued, or not one 10db lands, does nothing.
   */
  catchUp(batchId: BatchId): void;
  /**
   * The open pull request of a batch that merges by itself has had minutes to get its required
   * checks and its head has none: merges the base into it the same way and pushes it, so GitHub
   * starts its workflows on a new head. Pushes nothing when the head has any check by the time the
   * job runs, when the branch already holds the base, or when the merge or its check fails; none of
   * those raises a card, since the watch's notice says the checks never started.
   */
  restartCi(batchId: BatchId): boolean;
  /**
   * The open pull request merges cleanly: merges it again, or turns auto-merge on again, when GitHub
   * refused that earlier, 10db just pushed to it, or the watch just withdrew the card of a catch-up
   * that stopped (`catchUpCardWasOpen`). Does nothing when no merge is due.
   */
  retryMerge(batchId: BatchId, opts?: RetryMergeOptions): void;
}

type ConflictedUpdate = Extract<BaseUpdate, { readonly kind: 'conflicted' }>;

/**
 * A failed member its task started over from: the task's current workstream is another, so nothing
 * can retry this one.
 */
function superseded(db: DbReader, member: WorkstreamDto): boolean {
  if (member.state !== WorkstreamState.Failed) return false;
  const current = getTask(db, member.taskId).workstreamId;
  return current !== null && current !== member.id;
}

/** Whether the attempt committed through the commit tool, so its commits may be on the batch's branch. */
function committed(db: DbReader, member: WorkstreamDto): boolean {
  return hasToolOp(db, member.id, McpToolName.Commit);
}

/**
 * Whether Ship without it left this run out of the batch's pull request. Only a failed run is: one
 * that ran again carries its work to the pull request whatever its notice says.
 */
function leftOut(member: WorkstreamDto): boolean {
  return member.state === WorkstreamState.Failed && member.notice?.key === LEFT_OUT_NOTICE_KEY;
}

/**
 * Whether the run that replaced a superseded member has not got going yet, so the attempt may still
 * be the task's only one: the replacement's batch is still being cut (the cut may be refused), or
 * its cut was refused and detached it from any batch, leaving it cancelled before it ran. In both
 * cases the builder could still want the old batch to keep the attempt.
 */
function replacementUnsettled(db: DbReader, member: WorkstreamDto): boolean {
  const task = getTask(db, member.taskId);
  // A closed task will not start again, so nothing is left to wait for.
  if (task.status === TaskStatus.Cancelled || task.workstreamId === null) return false;
  const next = getWorkstream(db, task.workstreamId);
  if (next.batchId === null) return next.state === WorkstreamState.Cancelled;
  return getBatch(db, next.batchId).state === BatchState.Cutting;
}
/**
 * Whether a superseded member is held only because its replacement's cut was refused: the task's
 * latest run is cancelled and detached from any batch, and the task is still open to start again.
 */
function replacementRefused(db: DbReader, member: WorkstreamDto): boolean {
  const task = getTask(db, member.taskId);
  if (task.status === TaskStatus.Cancelled || task.workstreamId === null) return false;
  const next = getWorkstream(db, task.workstreamId);
  return next.batchId === null && next.state === WorkstreamState.Cancelled;
}

/**
 * A batch's members: each task's latest workstream in it, except a superseded one that committed
 * nothing. It holds nothing the batch should wait for, so the batch ships the work of the rest. One
 * that committed stays a member: its commits are on the branch and passed no gate or review, so the
 * batch ships them only through Ship anyway, and its tasks' notice says so (`supersededNotices`).
 * One whose replacement is not yet cut stays too, until the cut has ended (`replacementUnsettled`).
 */
function members(db: DbReader, batchId: BatchId): WorkstreamDto[] {
  return latestPerTask(listWorkstreams(db, { batchId })).filter(
    (m) => !superseded(db, m) || committed(db, m) || replacementUnsettled(db, m),
  );
}

/** How many times 10db pushes again by itself after GitHub's server fails a push, before a card. */
const PUSH_SERVER_RETRIES = 2;

/**
 * Why a shipping step threw. The push is the only git network call in shipping that can fail it (the
 * fetch before the gate only leaves the base out): a rejected or timed-out push has its own card, and
 * any other git or gh failure is `network`.
 */
function stepFailure(
  batch: BatchDto,
  step: string,
  error: unknown,
  limits: DeliveryLimits,
): ShipFailure {
  if (!(error instanceof GitNetworkError)) return shipCards.network(batch, step, error);
  switch (error.kind) {
    case GitNetworkFailure.Rejected:
      return shipCards.pushRejected(batch, error.detail);
    case GitNetworkFailure.Declined:
      return shipCards.pushDeclined(batch, error.detail);
    case GitNetworkFailure.ServerError:
      return shipCards.pushServerError(batch, error.detail, PUSH_SERVER_RETRIES);
    case GitNetworkFailure.Timeout:
      return shipCards.pushTimedOut(batch, limits.pushTimeoutMs);
    // Only shutdown aborts a push, and the shipper returns before asking for a card then.
    case GitNetworkFailure.Aborted:
    case GitNetworkFailure.Failed:
      return shipCards.network(batch, step, error);
  }
}

export function createShipper(deps: ShipperDeps): Shipper {
  const db = deps.state.db;

  function resume(batchId: BatchId): void {
    deps.jobs.run(jobKey(getBatch(db, batchId), JobQueue.Ship), (signal) =>
      // One operation: the checkout's git dirs are read once for the ship, not once per git call.
      deps.git.operation(() => shipSteps(batchId, signal)),
    );
  }

  function fail(batch: BatchDto, outcome: ShipFailure): void {
    failWith(batch, outcome.failure, outcome.card.title, outcome.card);
  }

  /** SHIPPING → FAILED; `card` is null when the step that refused raised its own. */
  function failWith(
    batch: BatchDto,
    failure: BatchFailure,
    reason: string,
    card: Card | null,
  ): void {
    const moved = deps.state.write((w) => {
      if (getBatch(w.tx, batch.id).state !== BatchState.Shipping) return false;
      settleLeftOutCards(
        w,
        transitionBatch(w, batch.id, { to: BatchState.Failed, patch: { failure }, reason }),
      );
      return true;
    });
    if (!moved) return;
    deps.logger.warn({ batchId: batch.id, failure, title: reason }, 'batch not shipped');
    // A later ship of the batch that succeeds makes the card stale.
    if (card)
      raise(deps.inbox, batch.projectId, {
        ...card,
        resolvesWhen: { event: 'batch_shipped', batchId: batch.id },
      });
  }

  /**
   * The base merge before the shipping gate left git's conflict markers in `update.paths`, or an
   * earlier gate's markers are still there: no gate ran and nothing was pushed. The batch's last
   * finished task runs again as a session that resolves them, as a task's own gate would send it
   * (`decisions/2026-11-01-a-session-resolves-the-conflicts-of-the-base-merge.md`): in one write
   * the batch goes SHIPPING → FAILED → OPEN (a fix task reopens it the same way), the task opens
   * again and gets a workstream of one implement step whose next action is `merge`. No card is
   * raised; the session asks the builder (ask_human) only for a resolution that changes what a
   * side does, and the batch ships itself once the task is done and the markers are gone. When no
   * task can take them, one card names the files and why.
   */
  function sendToMerge(batch: BatchDto, update: ConflictedUpdate): void {
    const outcome = deps.state.write((w): { readonly why: string } | 'moved' | 'sent' => {
      if (getBatch(w.tx, batch.id).state !== BatchState.Shipping) return 'moved';
      const [last] = members(w.tx, batch.id)
        .filter((m) => m.state === WorkstreamState.Done)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      if (!last) return { why: 'the batch has no finished task to send them to' };
      const task = getTask(w.tx, last.taskId);
      if (task.status !== TaskStatus.Done)
        return {
          why: `its last task, "${task.title}", ${task.status === TaskStatus.Cancelled ? 'was closed' : `is ${task.status}`}`,
        };
      const implement = last.steps.filter((s) => s.role === StepRole.Implement).at(-1);
      if (!implement) return { why: `its last task, "${task.title}", ran no implement step` };
      const reason = `conflict markers in ${String(update.paths.length)} file(s) from the merge of the base`;
      transitionBatch(w, batch.id, {
        to: BatchState.Failed,
        patch: { failure: BatchFailure.BaseConflict },
        reason,
      });
      settleLeftOutCards(
        w,
        transitionBatch(w, batch.id, {
          to: BatchState.Open,
          patch: { failure: null },
          reason: 'a session resolves the merge',
        }),
      );
      setTaskStatus(w, task.id, TaskStatus.Open);
      const next = insertPlannedWorkstream(
        w,
        task.id,
        {
          flowName: 'merge',
          overBudget: [],
          steps: [
            {
              role: implement.role,
              personaId: implement.personaId,
              personaName: implement.personaName,
              tools: implement.tools,
              score: implement.score,
              profileId: implement.profileId,
              model: implement.model,
              effort: implement.effort,
              need: implement.need,
              reason: implement.reason,
              overBudget: implement.overBudget,
              pinned: implement.pinned,
              status: StepStatus.Pending,
              attempts: 0,
              startedAt: null,
              sessionFloor: 0,
              result: null,
              earlier: [],
              sentBack: 0,
            },
          ],
        },
        batch.id,
      );
      patchWorkstream(w, next.id, null, {
        nextAction: { kind: 'merge', base: `origin/${batch.baseBranch}`, paths: [...update.paths] },
      });
      return 'sent';
    });
    if (outcome === 'moved') return;
    if (outcome === 'sent') {
      deps.logger.info(
        { batchId: batch.id, files: update.paths },
        'shipping gate found the base merge conflicted; the last task resolves it',
      );
      deps.onWorkQueued();
      return;
    }
    fail(batch, shipCards.baseConflict(batch, update.paths, outcome.why));
  }

  /**
   * A shipped or closed batch's worktree goes, in the ship queue, after the state is recorded, so a
   * crash between the two leaves recovery a finished batch to clean up rather than a half-shipped one.
   */
  async function retire(batchId: BatchId): Promise<void> {
    await retireWorktree(deps, batchId).catch((error: unknown) => {
      deps.logger.warn(
        { batchId, err: error instanceof Error ? error.message : String(error) },
        'batch worktree not removed',
      );
    });
  }

  /**
   * After a batch ends, in its project's ship queue: a worktree batch's worktree goes, and a shared
   * batch's checkout is switched back to where the cut found it and its branch settled, which a
   * worktree batch's removal does itself.
   */
  async function afterEnd(batchId: BatchId, worktreePath: string | null): Promise<void> {
    if (worktreePath !== null) {
      await retire(batchId);
      return;
    }
    await returnCheckout(deps, batchId);
    await settleBranch(deps, batchId).catch((error: unknown) => {
      deps.logger.warn(
        { batchId, err: error instanceof Error ? error.message : String(error) },
        'batch branch not settled',
      );
    });
  }

  /**
   * A gate that failed only in tests which passed when their files were rerun: the flakes are a notice
   * on the batch's tasks and one Icebox task per test file (a file with an open task gets the flake
   * added to it), filed against the batch's newest task.
   */
  function recordFlakes(batch: BatchDto, tests: readonly FlakyTest[]): void {
    deps.logger.info(
      { batchId: batch.id, tests: tests.map((t) => `${t.file} > ${t.name ?? ''}`) },
      'ship gate failed only in tests that passed when rerun; going on',
    );
    deps.state.write((w) => {
      const [newest] = members(w.tx, batch.id).sort((a, b) =>
        a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
      );
      if (newest) fileFlakyTests(w, newest.taskId, tests);
    });
    showNotice(deps.state, batch.id, gateNotices.flakyPassed(tests));
  }

  /**
   * Runs the check before the push (the pre-check or the gate) on the batch branch, recording its
   * process group for recovery. `beforeStart` runs once it holds its gate slot; a false answer stops
   * it as an abort would.
   */
  async function runGate(
    batch: BatchDto,
    project: ProjectDto,
    signal: AbortSignal,
    beforeStart: () => Promise<boolean>,
    /** Run this instead of the project's check: the rerun of a failed check's failing test files. */
    command?: string,
  ): Promise<GateResult | null> {
    const gateCommand = command ?? shipCheck(project)?.command;
    // The caller skips the gate step for a project without a gate.
    if (gateCommand === undefined)
      throw new InvalidError('This project has no gate command to run');
    let recording: Promise<void> = Promise.resolve();
    const logPath = join(
      deps.dataDir,
      'logs',
      'gate',
      `batch-${batch.id}-${String(deps.clock.now().getTime())}.log`,
    );
    deps.logger.info({ batchId: batch.id, command: gateCommand, logPath }, 'gate started');
    const result = await deps.gate.run({
      project,
      command: gateCommand,
      logPath,
      timeoutMs: deps.limits.gateTimeoutMs,
      env: deps.sessionEnv(project),
      // The batch spans tasks, so only the project's own hosts and read paths open.
      rules: listPermissionRules(deps.state.db, project.id, null),
      checkouts: allCheckouts(deps.state.db),
      signal,
      beforeStart,
      onWaiting: (ahead) => {
        deps.logger.info(
          { batchId: batch.id, ahead },
          'ship gate is waiting for another gate to finish',
        );
      },
      onSpawn: (pid) => {
        recording = (deps.identifyProcess?.(pid) ?? Promise.resolve(null)).then((gatePidStart) => {
          if (gatePidStart !== null)
            deps.state.write((w) => patchBatch(w, batch.id, { gatePid: pid, gatePidStart }));
        });
      },
    });
    await recording.catch(() => undefined);
    deps.logger.info(
      {
        batchId: batch.id,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logPath: result.logPath,
        timedOut: result.timedOut,
        aborted: result.aborted,
      },
      'gate finished',
    );
    deps.state.write((w) =>
      patchBatch(w, batch.id, {
        gatePid: null,
        gatePidStart: null,
        ...(result.aborted ? {} : { gateExitCode: result.exitCode, gateLogPath: result.logPath }),
      }),
    );
    // Shutdown killed the gate: record nothing; the batch stays SHIPPING and recovery re-runs it.
    if (result.aborted) return null;
    // A host the sandbox blocked is the builder's to allow; the card names it and the gate's tail says so.
    if (result.blockedHosts.length > 0) await takeFoundHostsReading(deps, project.id);
    raiseGateHostCards(deps, {
      projectId: project.id,
      run: BlockedRun.Gate,
      command: gateCommand,
      hosts: result.blockedHosts,
    });
    return result;
  }

  /**
   * Whether a failed gate failed only in tests the batch couldn't have caused: every failing step
   * named failing tests, none of them is in a file the batch changed since its base, and each of the
   * batch's done tasks passed its own last gate. Anything 10db can't read counts as the batch's.
   */
  async function outsideTheBatch(
    batchId: BatchId,
    checkout: string,
    steps: readonly GateStepFailure[],
  ): Promise<boolean> {
    if (steps.length === 0 || steps.some((s) => s.tests.length === 0)) return false;
    const done = members(db, batchId).filter((m) => m.state === WorkstreamState.Done);
    if (done.length === 0) return false;
    const ownGatesPassed = done.every(
      (m) =>
        listEvidence(db, m.id)
          .filter((e) => e.kind === EvidenceKind.Gate)
          .at(-1)?.exitCode === 0,
    );
    if (!ownGatesPassed) return false;
    // The base the branch holds now: a merge before the gate moved it, and its files aren't the batch's.
    const base = getBatch(db, batchId).baseSha;
    if (base === null) return false;
    try {
      const changed = await deps.git.filesChangedBetween(
        checkout,
        base,
        await deps.git.head(checkout),
      );
      return steps.every((s) => s.tests.every((t) => !touchedBy(t.file, changed)));
    } catch (error) {
      deps.logger.warn(
        { batchId, err: error instanceof Error ? error.message : String(error) },
        "batch's changed files not read",
      );
      return false;
    }
  }

  /** Waits `ms` on the injected clock; a shutdown (the signal) ends the wait early. */
  function pause(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = deps.clock.setTimeout(done, ms);
      function done(): void {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }
      function onAbort(): void {
        timer.cancel();
        done();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Logs the push's duration and output, landed or refused, so what git printed is on record. A push
   * GitHub's server fails (`GitNetworkFailure.ServerError`) is pushed again, at most
   * `PUSH_SERVER_RETRIES` more times with a short wait between; the last failure is thrown.
   */
  async function pushBranch(
    batch: BatchDto,
    project: ProjectDto,
    branch: string,
    signal: AbortSignal,
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const run = await deps.git.push(project.repoPath, branch, pushCall(deps, signal));
        deps.logger.info(
          { batchId: batch.id, branch, durationMs: run.durationMs, output: run.output, attempt },
          'git push finished',
        );
        return;
      } catch (error) {
        if (error instanceof GitNetworkError)
          deps.logger.warn(
            {
              batchId: batch.id,
              branch,
              kind: error.kind,
              durationMs: error.durationMs,
              output: error.output,
              attempt,
            },
            'git push failed',
          );
        const retry =
          error instanceof GitNetworkError &&
          error.kind === GitNetworkFailure.ServerError &&
          attempt < PUSH_SERVER_RETRIES &&
          !signal.aborted;
        if (!retry) throw error;
        await pause(deps.limits.pushRetryWaitMs, signal);
      }
    }
  }

  /**
   * The one scope the repo's `.10db/pr-scopes.json` at the batch's base gives every file the batch
   * committed, or null. The list is read from the base, which the builder's branch holds, not from
   * commits a lane made. The scope only labels the title, so a git failure here leaves it off rather
   * than failing the ship.
   */
  async function scopeFor(
    batch: BatchDto,
    target: { readonly checkout: string; readonly baseSha: string },
    sha: string,
  ): Promise<string | null> {
    try {
      const [paths, scopes] = await Promise.all([
        deps.git.filesChangedBetween(target.checkout, target.baseSha, sha),
        readPrScopes(deps.git, target.checkout, target.baseSha, deps.logger),
      ]);
      return scopeOf(paths, scopes);
    } catch (error) {
      deps.logger.warn(
        { batchId: batch.id, err: error instanceof Error ? error.message : String(error) },
        'pr scope not read',
      );
      return null;
    }
  }

  /**
   * The project's title prefix when it sets one; otherwise the type from the tasks whose work shipped
   * (every task when none finished) and the batch's scope.
   */
  async function prefixFor(
    batch: BatchDto,
    project: ProjectDto,
    tasks: readonly { readonly title: string; readonly state: WorkstreamState }[],
    target: { readonly checkout: string; readonly baseSha: string },
    sha: string,
  ): Promise<string> {
    if (project.prTitlePrefix !== null) return project.prTitlePrefix;
    const done = tasks.filter((task) => task.state === WorkstreamState.Done);
    return titlePrefix(done.length > 0 ? done : tasks, await scopeFor(batch, target, sha));
  }

  /**
   * `target` is the batch's repo, branch and base, which step 0 checked are set; `checkout` is where
   * it was built.
   */
  async function createPr(
    batch: BatchDto,
    project: ProjectDto,
    target: {
      readonly repo: string;
      readonly branch: string;
      readonly baseSha: string;
      readonly checkout: string;
    },
    signal: AbortSignal,
  ): Promise<string> {
    const tasks = [];
    const subjects = [];
    const current = members(db, batch.id);
    for (const w of latestPerTask(listWorkstreams(db, { batchId: batch.id }))) {
      const member = current.some((m) => m.id === w.id);
      const task = getTask(db, w.taskId);
      // A retried run whose commits are still reverted has no work in the branch, so the body must
      // not list its task as finished.
      const out = leftOut(w) || (await revertedAway(batch.id, w, target));
      // A task that left the batch may still name it, whether or not its run stayed a member (a
      // superseded attempt stays one until its replacement is cut, and closing a task leaves its failed
      // run in place). Its work is in the pull request only if a run of it has commits on the branch.
      const left =
        !member ||
        superseded(db, w) ||
        w.state === WorkstreamState.Cancelled ||
        task.status === TaskStatus.Cancelled;
      const noWork =
        out ||
        (left && (await commitsOf(batch.id, w, target.checkout, target.branch)).length === 0);
      subjects.push({ title: w.taskTitle, state: w.state, noWork });
      if (member)
        tasks.push({
          title: w.taskTitle,
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          state: w.state,
          leftOut: out,
        });
    }
    const sha = await deps.git.head(target.checkout);
    const file = join(deps.dataDir, 'delivery', `${batch.id}-pr-body.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      prBody({
        batch,
        tasks,
        gate: {
          command: project.gateCommand,
          precheck: shipCheck(project)?.kind === 'precheck' ? project.precheckCommand : null,
        },
        ci: { repo: target.repo, sha },
        template: await readPrTemplate(deps.git, target.checkout, sha, deps.logger),
      }),
    );
    const prUrl = await deps.gh.prCreate(
      {
        repo: target.repo,
        base: batch.baseBranch,
        head: target.branch,
        title: prTitle(
          await prefixFor(
            batch,
            project,
            tasks.filter((t) => !t.leftOut),
            target,
            sha,
          ),
          prSubject(batch.title, subjects),
        ),
        bodyFile: file,
      },
      ghCall(deps, signal),
    );
    deps.logger.info(
      {
        batchId: batch.id,
        repo: target.repo,
        baseBranch: batch.baseBranch,
        branch: target.branch,
        prUrl,
      },
      'gh pr create finished',
    );
    return prUrl;
  }

  /**
   * Shows on the batch's tasks why its pull request waits for the builder, or clears that with null once
   * it is set to merge (or merged). The cards an earlier build raised for it close too: the batch's
   * refusal card and its pre-check-only card always, and the project's auto-merge-is-off card once a
   * pull request was set to merge, which shows the setting is on.
   */
  function tellMerge(batch: BatchDto, notice: Notice | null): void {
    if (notice === null) hideNotices(deps.state, batch.id, [NOTICE_KEY.merge]);
    else showNotice(deps.state, batch.id, notice);
    withdraw(deps.state, deps.inbox, batch.projectId, [
      autoMergeRefusedKey(batch.id),
      preCheckOnlyKey(batch.id),
      ...(notice === null ? [autoMergeOffKey(batch.projectId)] : []),
    ]);
  }

  /**
   * Has GitHub merge the batch's pull request by itself once its required checks pass, when the
   * batch asked for that. The pull request is open either way, so a repository that doesn't allow
   * auto-merge, or a refusal from GitHub, is a notice on the batch's tasks and the pull request waits for
   * the builder (no Inbox card: it asks nothing, and the tasks' cards say what they wait for); only a
   * shutdown stops the ship.
   */
  async function turnOnAutoMerge(
    batch: BatchDto,
    repo: string,
    prUrl: string,
    signal: AbortSignal,
    precheckOnly: boolean,
    rearm = false,
  ): Promise<void> {
    const call = ghCall(deps, signal);
    try {
      if (!(await deps.gh.repoAllowsAutoMerge(repo, call))) {
        deps.logger.info(
          { batchId: batch.id, repo, prUrl },
          'repository does not allow auto-merge',
        );
        autoMergeArmed.delete(batch.id);
        tellMerge(batch, mergeNotices.notAllowed(repo, prUrl));
        return;
      }
      await deps.gh.prAutoMerge({ repo, url: prUrl }, call);
      autoMergeArmed.add(batch.id);
      tellMerge(batch, null);
      deps.logger.info({ batchId: batch.id, repo, prUrl }, 'auto-merge turned on');
    } catch (error) {
      if (signal.aborted) throw error;
      if (nothingToWaitFor(error)) {
        autoMergeArmed.delete(batch.id);
        if (precheckOnly) await mergeIfRequiredChecksPassed(batch, repo, prUrl, signal);
        else await mergeNow(batch, repo, prUrl, signal);
        return;
      }
      if (rearm) {
        // A fix batch re-arms a pull request whose auto-merge is probably on already, and gh's answer
        // to that is not known (docs/architecture/research/spike-15-gh-ci-checks.md): any error
        // counts as armed, never as the refused card.
        deps.logger.info(
          { batchId: batch.id, prUrl, err: error instanceof Error ? error.message : String(error) },
          'auto-merge answered an error on a re-arm; treated as armed',
        );
        tellMerge(batch, null);
        return;
      }
      autoMergeArmed.delete(batch.id);
      deps.logger.warn(
        { batchId: batch.id, prUrl, err: error instanceof Error ? error.message : String(error) },
        'auto-merge not turned on',
      );
      tellMerge(batch, mergeNotices.refused(prUrl, error));
    }
  }

  /**
   * GitHub said the pull request has nothing to wait for, and only the pre-check ran on the Mac, so
   * merging on that answer alone could land work nothing but the pre-check checked. It says the same
   * when the base has no required checks and when they already passed on this head, so read them:
   * passing merges at once; none leaves the pull request open with a notice; anything else (pending,
   * cancelled, failing, a read that failed) merges nothing and raises nothing, and the pull request watch takes over.
   */
  async function mergeIfRequiredChecksPassed(
    batch: BatchDto,
    repo: string,
    prUrl: string,
    signal: AbortSignal,
  ): Promise<void> {
    let required: RequiredChecks;
    try {
      required = await deps.gh.prRequiredChecks({ repo, url: prUrl }, ghCall(deps, signal));
    } catch (error) {
      if (signal.aborted) throw error;
      deps.logger.warn(
        { batchId: batch.id, prUrl, err: error instanceof Error ? error.message : String(error) },
        'required checks not read; pull request not merged at once',
      );
      return;
    }
    deps.logger.info(
      { batchId: batch.id, prUrl, required: required.state },
      'only the pre-check ran; required checks read',
    );
    switch (required.state) {
      case 'passing':
        await mergeNow(batch, repo, prUrl, signal);
        return;
      case 'none':
        tellMerge(batch, mergeNotices.preCheckOnly(batch, prUrl));
        return;
      case 'pending':
      case 'cancelled':
      case 'failing':
        return;
    }
  }

  /**
   * GitHub said the pull request has nothing to wait for (its base has no required checks), so
   * auto-merge has no use: squash-merge it now, as auto-merge would have. The pull request watch
   * reads the merge next, which is what puts its tasks in Done. A refusal is a notice on its tasks.
   */
  async function mergeNow(
    batch: BatchDto,
    repo: string,
    prUrl: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await deps.gh.prMerge({ repo, url: prUrl }, ghCall(deps, signal));
      tellMerge(batch, null);
      deps.logger.info({ batchId: batch.id, repo, prUrl }, 'pull request merged at once');
    } catch (error) {
      if (signal.aborted) throw error;
      deps.logger.warn(
        { batchId: batch.id, prUrl, err: error instanceof Error ? error.message : String(error) },
        'pull request not merged at once',
      );
      tellMerge(batch, mergeNotices.mergeRefused(batch, prUrl, error));
    }
  }

  /**
   * Batch delivery spec §6, steps 0–5, in the batch's worktree when it has one (made whole first) and
   * in the project's checkout otherwise; the push always runs in the project's checkout, whose pin
   * holds the origin the builder trusted. Each step is safe to repeat, so a restart runs them all again.
   */
  async function shipSteps(batchId: BatchId, signal: AbortSignal): Promise<void> {
    const batch = getBatch(db, batchId);
    // A function, so the check in the catch below is not narrowed away by this one.
    const stopped = (): boolean => signal.aborted;
    // Queued before shutdown: leave it SHIPPING for recovery.
    if (stopped() || batch.state !== BatchState.Shipping) return;
    const project = getProject(db, batch.projectId);
    const { branch, baseSha, repo, worktreePath } = batch;
    const checkout = worktreePath ?? project.repoPath;
    let step = 'making the worktree whole';
    try {
      // A worktree that is missing, half made or switched away is made whole from the branch first.
      if (worktreePath !== null) {
        const whole = await ensureWorktreeWhole(deps, batch, signal);
        if (stopped()) return;
        if (whole === 'refused') {
          failWith(batch, BatchFailure.WrongBranch, 'its worktree could not be made whole', null);
          return;
        }
      }
      // 0. The branch and a clean checkout.
      step = 'checking the branch';
      const current = await deps.git.currentBranch(checkout);
      if (branch === null || baseSha === null || repo === null || current !== branch) {
        fail(batch, {
          failure: BatchFailure.WrongBranch,
          card: wrongBranchCard(batch, current, checkout, 'not_shipped'),
        });
        return;
      }
      // Before anything can close the batch and remove its worktree: uncommitted work is never
      // thrown away, so a dirty checkout fails here with its card and the worktree is kept.
      const dirty = await deps.git.changedPaths(checkout);
      if (dirty.length > 0) {
        fail(batch, shipCards.dirtyCheckout(batch, dirty, worktreePath ?? undefined));
        return;
      }
      // 0b. A CI fix batch pushes to a pull request that already exists, so it reads the pull request
      // first: one that merged or closed meanwhile, or a fix that wrote nothing, ends the batch with
      // nothing pushed.
      let fixPr: PullRequest | null = null;
      if (batch.ciFixHead !== null) {
        step = 'gh pr view';
        const status = await deps.gh.prStatus({ repo, ref: branch }, ghCall(deps, signal));
        if (status === null)
          throw new Error(`GitHub has no pull request for ${branch} to push the fix to`);
        // In the merge queue: a push would take it out. Read here, not trusted from the watch's read.
        step = 'checking the merge queue';
        const queued =
          status.state === PrState.Open &&
          (await deps.gh.prInMergeQueue({ repo, url: status.url }, ghCall(deps, signal)));
        step = 'checking the fix for commits';
        const own =
          status.state === PrState.Open && !queued
            ? await deps.git.ownCommitsSince(checkout, batch.ciFixHead, `refs/heads/${branch}`)
            : [];
        if (status.state !== PrState.Open || queued || own.length === 0) {
          let reason = `its pull request is ${status.state.toLowerCase()}`;
          if (queued)
            reason = 'its pull request is in the merge queue, where a push would remove it';
          else if (status.state === PrState.Open) reason = 'the fix made no commits of its own';
          deps.state.write((w) => transitionBatch(w, batchId, { to: BatchState.Closed, reason }));
          deps.logger.info({ batchId, reason, prUrl: status.url }, 'fix batch closed');
          await afterEnd(batchId, worktreePath);
          return;
        }
        fixPr = { url: status.url, state: status.state };
      }
      // 1. Nothing beyond the base: nothing to push. (A fix batch's own commits were counted above.)
      if (
        batch.ciFixHead === null &&
        (await deps.git.commitsSince(checkout, baseSha, `refs/heads/${branch}`)).length === 0
      ) {
        const reason = 'no commits beyond the base';
        deps.state.write((w) => transitionBatch(w, batchId, { to: BatchState.Closed, reason }));
        deps.logger.info({ batchId, reason }, 'batch closed');
        await afterEnd(batchId, worktreePath);
        return;
      }
      // 2. The gate, or the pre-check in its place when the project sets one, on the branch as it
      // will be pushed: a worktree batch's with its base as origin has it now merged in, so it tests
      // what the pull request would merge. A project with no gate was checked by the builder, task by
      // task, as it was, so neither runs.
      const check = shipCheck(project);
      if (check !== null) {
        const name: ShipCheckName = check.kind === 'precheck' ? 'pre-check' : 'gate';
        step = `the ${name}`;
        // A notice from an earlier ship attempt's rerun says nothing of this one's gate.
        hideNotices(deps.state, batchId, [NOTICE_KEY.gateRerun, NOTICE_KEY.gateFlaky]);
        // Once the gate holds its slot and no other gate of the batch runs, so no other gate's
        // merge changes the tree under it.
        const gateOnce = async (): Promise<{
          gate: GateResult;
          note: string | null;
          /** When the gate got to start, after any wait for a slot or for the Mac to calm down. */
          startedAt: Date;
        } | null> => {
          const before: { update: BaseUpdate | null; startedAt: Date } = {
            update: null,
            startedAt: deps.clock.now(),
          };
          const gate = await deps.baseUpdates.gate(batchId, signal, () =>
            runGate(batch, projectAtCheckout(project, checkout), signal, async () => {
              before.startedAt = deps.clock.now();
              // The batch's last task is the session to send when the base's conflicts need one.
              const update = await deps.baseUpdates.beforeGate(batchId, signal, {
                inSession: true,
                raisesUncarried: true,
              });
              before.update = update;
              // Markers in the branch fail any gate, and the stale branch isn't what would merge. A
              // broken install fails every tool of the gate, whatever the batch's code is. A lost
              // custom migration fails none of them, which is why it stops the gate here.
              return (
                update.kind !== 'aborted' &&
                update.kind !== 'conflicted' &&
                update.kind !== 'install_broken' &&
                update.kind !== 'uncarried'
              );
            }),
          );
          if (gate === null) {
            if (before.update?.kind === 'conflicted' && !stopped())
              sendToMerge(batch, before.update);
            if (before.update?.kind === 'install_broken' && !stopped())
              fail(
                batch,
                shipCards.installBroken(batch, before.update.note, before.update.noPnpm === true),
              );
            if (before.update?.kind === 'uncarried' && !stopped())
              fail(batch, shipCards.migrationsLost(batch, before.update));
            return null;
          }
          return {
            gate,
            note: gateNote(before.update ?? { kind: 'up_to_date', note: null }),
            startedAt: before.startedAt,
          };
        };
        // A failed gate's card says so when the Mac was overloaded at any time while the gate ran.
        const cardNote = (run: { note: string | null; startedAt: Date }): string | null => {
          const load = deps.load?.overloadedSince(run.startedAt);
          if (!load) return run.note;
          return run.note === null ? overloadNote(load) : `${run.note}\n\n${overloadNote(load)}`;
        };
        const first = await gateOnce();
        if (first === null) return;
        if (first.gate.timedOut) {
          fail(
            batch,
            shipCards.gateTimedOut(
              batch,
              deps.limits.gateTimeoutMs,
              first.gate.logPath,
              cardNote(first),
              name,
            ),
          );
          return;
        }
        // A check that failed only in tests is run again on just the failing files, once, before any
        // card. A pass lets the batch ship with the flakes on record; a fail is the failure it was.
        let flakesPassed = false;
        if (first.gate.exitCode !== 0) {
          const flaky = await rerunFlaky({
            checkout,
            output: first.gate.tail,
            run: async (rerun) =>
              deps.baseUpdates.gate(batchId, signal, () =>
                runGate(
                  batch,
                  projectAtCheckout(project, checkout),
                  signal,
                  () => Promise.resolve(true),
                  rerun,
                ),
              ),
          });
          if (flaky.kind === 'stopped') return;
          if (flaky.kind === 'flaky') {
            flakesPassed = true;
            recordFlakes(batch, flaky.tests);
          }
        }
        if (first.gate.exitCode !== 0 && !flakesPassed) {
          const steps = await readGateFailures(checkout, first.gate.tail);
          if (!(await outsideTheBatch(batchId, checkout, steps))) {
            fail(
              batch,
              shipCards.gateFailed(batch, first.gate, cardNote(first), steps, false, name),
            );
            return;
          }
          // Every failing test is one the batch couldn't have caused: one more run, by itself,
          // before the builder hears of it, and never a fix session.
          deps.logger.info(
            { batchId, tests: steps.flatMap((s) => s.tests).length },
            'ship gate failed only in tests the batch did not change; running it again',
          );
          const second = await gateOnce();
          if (second === null) return;
          if (second.gate.timedOut) {
            fail(
              batch,
              shipCards.gateTimedOut(
                batch,
                deps.limits.gateTimeoutMs,
                second.gate.logPath,
                cardNote(second),
                name,
              ),
            );
            return;
          }
          if (second.gate.exitCode !== 0) {
            const again = await readGateFailures(checkout, second.gate.tail);
            fail(
              batch,
              (await outsideTheBatch(batchId, checkout, again))
                ? shipCards.gateFailedUnrelated(batch, cardNote(second), again)
                : shipCards.gateFailed(batch, second.gate, cardNote(second), again, true, name),
            );
            return;
          }
          showNotice(deps.state, batchId, gateNotices.rerunPassed(steps));
        }
      } else {
        // No gate brings the base in here, but a lane's launch may have, and lost a migration.
        const standing = await deps.baseUpdates.beforeGate(batchId, signal, {
          standingOnly: true,
        });
        if (standing.kind === 'aborted') return;
        if (standing.kind === 'uncarried') {
          fail(batch, shipCards.migrationsLost(batch, standing));
          return;
        }
      }
      // 3. Push, never forced.
      step = 'git push';
      await pushBranch(batch, project, branch, signal);
      // 4. Any PR for the branch, in any state; create one only when there is none.
      step = 'gh pr view';
      const existing = fixPr ?? (await deps.gh.prView({ repo, ref: branch }, ghCall(deps, signal)));
      step = 'gh pr create';
      // The base the branch holds now: a merge before the gate moved it.
      const base = getBatch(db, batchId).baseSha ?? baseSha;
      const prUrl =
        existing?.url ??
        (await createPr(batch, project, { repo, branch, baseSha: base, checkout }, signal));
      // 4b. A pull request the batch wants merged by itself, unless an earlier run already closed
      // or merged it.
      if (batch.autoMerge && (existing === null || existing.state === PrState.Open)) {
        step = 'gh pr merge --auto';
        await turnOnAutoMerge(
          batch,
          repo,
          prUrl,
          signal,
          check?.kind === 'precheck',
          fixPr !== null,
        );
      }
      // 5. Record it.
      deps.state.write((w) =>
        transitionBatch(w, batchId, {
          to: BatchState.Shipped,
          patch: { prUrl },
          reason: 'pull request open',
        }),
      );
      deps.logger.info({ batchId, branch, prUrl }, 'batch shipped');
      resolveShipCards(db, deps.inbox, getBatch(db, batchId));
      await afterEnd(batchId, worktreePath);
    } catch (error) {
      // Shutdown: leave SHIPPING; recovery re-runs from step 0.
      if (stopped()) return;
      fail(batch, stepFailure(batch, step, error, deps.limits));
    }
  }

  function toShipping(batchId: BatchId, reason: string): BatchDto {
    return deps.state.write((w) =>
      transitionBatch(w, batchId, { to: BatchState.Shipping, patch: { failure: null }, reason }),
    );
  }

  function checkBatch(batchId: BatchId): void {
    // The batch stays open; the check that follows the drain ships it.
    if (deps.holdShips?.()) return;
    const moved = deps.state.write((w) => {
      const batch = getBatch(w.tx, batchId);
      if (batch.state !== BatchState.Open) return false;
      const current = members(w.tx, batchId);
      const left = current
        .filter((m) => superseded(w.tx, m) && committed(w.tx, m) && !leftOut(m))
        .map((m) => m.taskTitle);
      // Commits on the branch are the heavier warning, so they take the notice's one slot.
      const refused = current
        .filter((m) => superseded(w.tx, m) && !committed(w.tx, m) && replacementRefused(w.tx, m))
        .map((m) => m.taskTitle);
      if (left.length > 0) setBatchNotice(w, batchId, supersededNotices.committed(batch, left));
      else if (refused.length > 0)
        setBatchNotice(w, batchId, supersededNotices.refusedStart(refused));
      else clearBatchNotice(w, batchId, NOTICE_KEY.supersededAttempt);
      // The builder chose to ship without a left-out run, and its commits are gone: it holds nothing up.
      const held = current.filter((m) => !leftOut(m)).map((m) => m.state);
      if (shipReadiness(held) !== ShipReadiness.Ready) return false;
      transitionBatch(w, batchId, {
        to: BatchState.Shipping,
        reason: 'every workstream is done or cancelled',
      });
      return true;
    });
    if (moved) resume(batchId);
  }

  /** The refusal while a member still runs, waits or is queued; null once every member settled or failed. */
  function unfinishedWork(batch: BatchDto): ConflictError | null {
    const current = members(db, batch.id);
    if (shipReadiness(current.map((m) => m.state)) !== ShipReadiness.Blocked) return null;
    const blockers = current
      .filter((m) => !isTerminal(m.state))
      .map((m) => `${m.taskTitle} (${m.state.toLowerCase()})`);
    return new ConflictError(
      `Batch "${batch.title}" still has unfinished work: ${blockers.join(', ')}`,
    );
  }

  /** A ship the builder asked for begins nothing while an update drains the factory. */
  function refuseWhileHeld(batch: BatchDto): void {
    if (deps.holdShips?.())
      throw new ConflictError(
        `Batch "${batch.title}" can't ship yet: a waiting update has paused new ships until it installs. Ship it after the restart, or turn Update 10db by itself off in Settings.`,
      );
  }

  function ship(batchId: BatchId): BatchDto {
    const batch = getBatch(db, batchId);
    const unfinished = unfinishedWork(batch);
    switch (batch.state) {
      case BatchState.Open: {
        if (unfinished) throw unfinished;
        refuseWhileHeld(batch);
        const shipping = toShipping(batchId, 'shipped anyway by the builder');
        resume(batchId);
        return shipping;
      }
      case BatchState.Failed: {
        if (unfinished) {
          // Never ship unfinished work: resume it; the batch ships itself when it settles. A
          // worktree batch reopens once its worktree is whole, in the cut queue.
          if (batch.worktreePath !== null) {
            reopenWorktreeBatch(deps, batchId, 'retried with unfinished work');
            return batch;
          }
          const reopened = deps.state.write((w) =>
            transitionBatch(w, batchId, {
              to: BatchState.Open,
              patch: { failure: null },
              reason: 'retried with unfinished work',
            }),
          );
          deps.onWorkQueued();
          return reopened;
        }
        refuseWhileHeld(batch);
        const shipping = toShipping(batchId, 'retried by the builder');
        resume(batchId);
        return shipping;
      }
      case BatchState.Cutting:
      case BatchState.Shipping:
      case BatchState.Shipped:
      case BatchState.Closed:
      case BatchState.Abandoned:
        throw new ConflictError(
          `Batch "${batch.title}" is ${batch.state.toLowerCase()}; only an open or failed batch ships`,
        );
    }
  }

  /** Every run of the task of `member` in the batch, oldest first. */
  function runsOf(batchId: BatchId, member: WorkstreamDto): WorkstreamDto[] {
    return listWorkstreams(db, { batchId }).filter((run) => run.taskId === member.taskId);
  }

  /**
   * Every commit `runs` made through the commit tool, in the order recorded. With `redoing`, the ones
   * that resolved conflict markers of a base merge are left out.
   */
  function commitsMadeBy(
    runs: readonly WorkstreamDto[],
    options: { readonly redoing?: boolean } = {},
  ): string[] {
    const made: string[] = [];
    for (const run of runs)
      for (const result of listToolOpResults(db, run.id, McpToolName.Commit)) {
        if (options.redoing === true && commitResolvedMarkers(result)) continue;
        const parsed = McpToolOutputs.commit.safeParse(result);
        if (parsed.success && !made.includes(parsed.data.sha)) made.push(parsed.data.sha);
      }
    return made;
  }

  /**
   * Whether a task run again after Ship without it has none of its work on the branch: one of its runs
   * was left out or retried after that, and no run that was told of the revert made a commit it does
   * not cover. The revert undid every earlier commit of the task, and 10db never undoes a revert, so it
   * is taken to be on the branch. A retry tells its session, and so does a start that joins the batch
   * (`insertJoinedWorkstream`). Only a run that was told counts: the shipping gate sends a merge run to
   * a task that finished, and its commit resolves the base's conflicts without bringing any of the work
   * back. The same goes for a told run's own commit that resolved conflict markers of its gate's base
   * merge: the commit tool records those, and they do not count.
   */
  async function revertedAway(
    batchId: BatchId,
    member: WorkstreamDto,
    target: { readonly checkout: string; readonly branch: string },
  ): Promise<boolean> {
    // The notes the sessions were given are the record: a wait may have replaced a run's notice, and a
    // merge run has neither. A run left out and never retried has only its notice, which names the same
    // revert. A run left out again holds a later revert than its own note, and `revertOfRun` reads that
    // one. A later run started from the revert before it, so the last record is the latest.
    const records = runsOf(batchId, member).flatMap((run) => {
      const record = revertOfRun({ notice: run.notice, evidence: listEvidence(db, run.id) });
      return record === null ? [] : [{ run, ...record }];
    });
    const revert = records.at(-1)?.revert;
    if (revert === undefined) return false;
    const told = records.filter((r) => r.told);
    for (const sha of commitsMadeBy(
      told.map((t) => t.run),
      { redoing: true },
    ))
      if (
        (await deps.git.hasCommit(target.checkout, sha)) &&
        (await deps.git.isAncestor(target.checkout, sha, `refs/heads/${target.branch}`)) &&
        !(await deps.git.isAncestor(target.checkout, sha, revert))
      )
        return false;
    return true;
  }

  /**
   * The commits a failed run's task made through the commit tool that are still on the batch's
   * branch, oldest first. Commits on a shared branch mix in other lanes', so the task's own tool-op
   * records are what say which are its. They are read for every run of the task in the batch, because
   * a finished task the shipping gate sends to merge gets a second run there, and a failure of that
   * one is a failure of all of the task's work.
   */
  async function commitsOf(
    batchId: BatchId,
    member: WorkstreamDto,
    checkout: string,
    branch: string,
  ): Promise<string[]> {
    const made = commitsMadeBy(runsOf(batchId, member));
    const kept: string[] = [];
    for (const sha of made)
      if (
        (await deps.git.hasCommit(checkout, sha)) &&
        (await deps.git.isAncestor(checkout, sha, `refs/heads/${branch}`))
      )
        kept.push(sha);
    return kept;
  }

  /**
   * The revert that undid each commit, read from the branch: every Ship without it's revert commit
   * lists what it undid as `- <sha> (<title>)`. A card or a notice can be missing after a failed write,
   * and an ancestor of a revert is not a commit it undid, so the branch itself is what says. Where
   * several reverts list a commit the newest is kept, and `order` ranks the reverts oldest first.
   * A listed commit that is not in the revert's own history, or not in the repository at all, is
   * ignored, and so is any commit a session made: only a revert 10db wrote counts, so a message saying
   * a commit was reverted cannot get it shipped under a notice saying the same.
   */
  async function undoneOnBranch(
    checkout: string,
    branch: string,
  ): Promise<{ readonly by: Map<string, string>; readonly order: Map<string, number> }> {
    const by = new Map<string, string>();
    const order = new Map<string, number>();
    const reverts = await deps.git.ownCommitsWithSubject(checkout, branch, LEFT_OUT_SUBJECT);
    for (const [index, revert] of reverts.entries()) {
      order.set(revert.sha, index);
      for (const line of revert.message.split('\n')) {
        const sha = /^- ([0-9a-f]{40}) \(/.exec(line)?.[1];
        if (
          sha !== undefined &&
          (await deps.git.hasCommit(checkout, sha)) &&
          (await deps.git.isAncestor(checkout, sha, revert.sha))
        )
          by.set(sha, revert.sha);
      }
    }
    return { by, order };
  }

  /**
   * Ship without a failed run (`Shipper.shipWithout`), in the ship queue. The commits of every member
   * that failed are undone in one commit, so one stopped revert leaves the branch whole and no other
   * failed task's commits ride along with the finished work. Each run gets its notice and the batch
   * moves to shipping in one write, which also closes the other runs' failed cards, and the ship then
   * runs as any other. Nothing moves until the revert has worked; a revert that cannot is a card and
   * the batch stays as it was.
   *
   * `given` is the revert the answered card names, with the runs it covers: one an answer before this
   * left on the branch without getting as far as the notices. Another card of the batch may be the
   * one answered (a task started
   * into the batch later failed), and its detail names none, so the batch's open left-out card, which
   * holds the revert, is read as well. Which commits an earlier revert undid is read from the branch
   * (`undoneOnBranch`), not from either card: those are not asked of git again, because undoing
   * commits that built on each other once more conflicts with the tip that no longer has them. They
   * count as this answer's, under the revert that undid them, and a run's notice counts all of them.
   * A commit no revert listed is reverted as usual, whether or not it is an ancestor of a revert.
   * A card's revert still only decides what the cards this answer raises say it left on the branch,
   * and with none, so does a revert on the branch whose notices no run's record names. A revert a
   * record names is finished business: the cards stay the ordinary ones, because this answer's own
   * commits are not in it.
   */
  async function leaveOut(
    batchId: BatchId,
    workstreamId: WorkstreamId,
    given: KeptRevert | null,
    signal: AbortSignal,
  ): Promise<void> {
    const batch = getBatch(db, batchId);
    const earlier = given ?? keptRevertOf(db, batch);
    const member = getWorkstream(db, workstreamId);
    // A function, so a check after an await is not narrowed away by the one before it.
    const stopped = (): boolean => signal.aborted;
    const failed = members(db, batchId).filter(
      (m) => m.state === WorkstreamState.Failed && !leftOut(m),
    );
    // An earlier Ship without it may have left the answered run out already; its gate failed since.
    const titles = failed.length > 0 ? failed.map((m) => m.taskTitle) : [member.taskTitle];
    const named = titles.map((t) => `"${t}"`).join(', ');
    // `titles` is what this answer tries; `covers` stays what the revert undid unless it makes one.
    let attempt: LeftOutAttempt = {
      workstreamId,
      titles,
      revert: earlier?.revert ?? null,
      covers: earlier?.covers ?? [],
    };
    // The revert commit this answer made, once there is one.
    let revert: string | null = null;
    // Any revert on the branch: from then on a stop must not leave the branch unexplained.
    const kept = (): string | null => revert ?? attempt.revert ?? null;
    /** The card for a batch that moved on while the job ran, which offers nothing it would refuse. */
    const overtaken = (state: BatchState): Card => {
      const reverted = kept();
      return reverted !== null
        ? leftOutCards.revertKept(
            batch,
            attempt,
            reverted,
            `The batch became ${state.toLowerCase()} while the answer ran, so its notices were not written.`,
            state,
          )
        : leftOutCards.notStarted(batch, attempt, `the batch is ${state.toLowerCase()}`, false);
    };
    /** Null when the state cannot be read: a stopping daemon may have closed the database. */
    const stateNow = (): BatchState | null => {
      try {
        return getBatch(db, batchId).state;
      } catch {
        return null;
      }
    };
    const stopWith = (stop: Card): void => {
      // `abandon` does not wait for this job, and nothing closes a card raised after it: a card with
      // answers is rewritten here, so it can't offer one the abandoned batch refuses.
      const card =
        (stop.options?.length ?? 0) > 0 && stateNow() === BatchState.Abandoned
          ? overtaken(BatchState.Abandoned)
          : stop;
      deps.logger.warn({ batchId, workstreamId, title: card.title }, 'ship without a run stopped');
      try {
        raise(deps.inbox, batch.projectId, card);
      } catch (error) {
        // A daemon that is stopping may have closed the database: the log is all that is left.
        deps.logger.error(
          { batchId, workstreamId, err: detailOf(error) },
          'ship without a run could not raise its card',
        );
      }
    };
    // The failed card is resolved already, so a stop that leaves nothing would be a silent answer.
    const notStarted = (why: string, answerable = true): void => {
      stopWith(leftOutCards.notStarted(batch, attempt, why, answerable));
    };
    // A second answer, queued before the first job moved the batch on: nothing is left to leave out, so
    // the answer has been carried out and a card saying it was not would be false.
    const carriedOut = (state: BatchState): boolean =>
      failed.length === 0 && leftOut(member) && state !== BatchState.Abandoned;
    const answerable = batch.state === BatchState.Open || batch.state === BatchState.Failed;
    if (!answerable && carriedOut(batch.state)) return;
    // Whatever changed since the card was answered, the answer no longer fits: nothing moves, and a card says why.
    const unfinished = unfinishedWork(batch);
    const refusal: { readonly why: string; readonly answerable: boolean } | null = !answerable
      ? { why: `the batch is ${batch.state.toLowerCase()}`, answerable: false }
      : member.state !== WorkstreamState.Failed
        ? {
            why: `${member.taskTitle} is ${member.state.toLowerCase()}, not failed`,
            answerable: false,
          }
        : stopped()
          ? { why: '10db was stopping', answerable: true }
          : unfinished
            ? { why: unfinished.message, answerable: true }
            : deps.holdShips?.()
              ? {
                  why: 'a waiting update has paused new ships until it installs',
                  answerable: true,
                }
              : null;
    if (refusal) {
      notStarted(refusal.why, refusal.answerable);
      return;
    }
    try {
      const { branch } = batch;
      const checkout = batch.worktreePath ?? getProject(db, batch.projectId).repoPath;
      if (batch.worktreePath !== null) {
        const whole = await ensureWorktreeWhole(deps, batch, signal);
        if (stopped()) {
          notStarted('10db was stopping');
          return;
        }
        if (whole === 'refused') {
          stopWith(
            leftOutCards.failed(batch, attempt, "the batch's worktree could not be made whole"),
          );
          return;
        }
      }
      const current = await deps.git.currentBranch(checkout);
      if (branch === null || current !== branch) {
        stopWith(
          leftOutCards.failed(
            batch,
            attempt,
            `The checkout is on ${current ?? 'a detached HEAD'}, the batch branch is ${branch ?? '(not cut)'}`,
          ),
        );
        return;
      }
      const standing =
        earlier !== null &&
        (await deps.git.hasCommit(checkout, earlier.revert)) &&
        (await deps.git.isAncestor(checkout, earlier.revert, `refs/heads/${branch}`))
          ? earlier.revert
          : null;
      if (standing === null) attempt = { ...attempt, revert: null, covers: [] };
      // What the branch says earlier reverts undid, whichever card was answered and whether or not a
      // card or notice names the revert.
      const undone = await undoneOnBranch(checkout, branch);
      const commits: {
        readonly run: WorkstreamDto;
        /** Its commits this answer reverts. */
        readonly shas: readonly string[];
        /** How many of its commits an earlier revert undid. */
        readonly covered: number;
        /** The newest earlier revert that undid one of them. */
        readonly coveredBy: string | null;
        /** The reverts its run records name. */
        readonly recorded: readonly string[];
        /** The revert of an earlier answer that its record names and the branch still holds. */
        readonly prior: string | null;
      }[] = [];
      for (const run of failed) {
        const left: string[] = [];
        let covered = 0;
        let coveredBy: string | null = null;
        for (const sha of await commitsOf(batchId, run, checkout, branch)) {
          const by = undone.by.get(sha);
          if (by === undefined) {
            left.push(sha);
            continue;
          }
          covered += 1;
          if (
            coveredBy === null ||
            (undone.order.get(by) ?? 0) > (undone.order.get(coveredBy) ?? 0)
          )
            coveredBy = by;
        }
        // A run left out before and retried keeps its revert on the branch. If this answer reverts
        // nothing of it, as when the retry committed nothing, its notice still names that revert, so
        // the next Retry tells the session.
        const recorded = runsOf(batchId, run).flatMap((r) => {
          const found = revertOfRun({ notice: r.notice, evidence: listEvidence(db, r.id) });
          return found === null ? [] : [found.revert];
        });
        const record = recorded.at(-1);
        const prior =
          record !== undefined &&
          (await deps.git.hasCommit(checkout, record)) &&
          (await deps.git.isAncestor(checkout, record, `refs/heads/${branch}`))
            ? record
            : null;
        commits.push({ run, shas: left, covered, coveredBy, recorded, prior });
      }
      // A revert on the branch that no card and no run's record names lost its notices, so it stands
      // for the cards this answer raises. A run's newest revert is the one to ask about: a record holds
      // the latest only, and a notice for it counted what the reverts before it undid.
      if (standing === null) {
        const recorded = new Set(commits.flatMap((c) => c.recorded));
        const unrecorded = commits.filter(
          (c) => c.coveredBy !== null && !recorded.has(c.coveredBy),
        );
        let newest: string | null = null;
        for (const { coveredBy } of unrecorded)
          if (
            coveredBy !== null &&
            (newest === null ||
              (undone.order.get(coveredBy) ?? 0) > (undone.order.get(newest) ?? 0))
          )
            newest = coveredBy;
        if (newest !== null)
          attempt = { ...attempt, revert: newest, covers: unrecorded.map((c) => c.run.id) };
      }
      const shas = commits.flatMap((c) => c.shas);
      if (shas.length > 0) {
        const reverted = await deps.git.revertCommits({
          repo: checkout,
          branch,
          shas,
          message: [
            `revert: leave out ${named}`,
            `10db reverted ${String(shas.length)} commit${shas.length === 1 ? '' : 's'} of ${named}, which failed in this batch, because the builder chose Ship without it:`,
            commits.flatMap((c) => c.shas.map((sha) => `- ${sha} (${c.run.taskTitle})`)).join('\n'),
          ].join('\n\n'),
        });
        // Only a revert that committed must go on whatever the signal says; a stop leaves the rest unchanged.
        if (reverted.kind === 'reverted') {
          revert = reverted.head;
          // This revert stands on the earlier one, so it covers each failed run with commits undone.
          // A run that has not failed since keeps the revert it was told of, on its own record.
          attempt = {
            ...attempt,
            covers: commits.filter((c) => c.shas.length + c.covered > 0).map((c) => c.run.id),
          };
        } else if (stopped()) {
          notStarted('10db was stopping');
          return;
        }
        if (reverted.kind === 'conflict') {
          stopWith(leftOutCards.conflict(batch, attempt, reverted.paths));
          return;
        }
        if (reverted.kind === 'markers') {
          stopWith(leftOutCards.markers(batch, attempt, reverted.paths));
          return;
        }
        if (reverted.kind === 'blocked') {
          stopWith(leftOutCards.blocked(batch, attempt, reverted.changed));
          return;
        }
      }
      // From here a stop of the daemon changes nothing: the revert commit is on the branch, so the
      // notice and the move are written whatever the signal says. The ship itself is what a stopping
      // daemon leaves queued, and a restart resumes a SHIPPING batch.
      const moved = deps.state.write((w) => {
        const now = getBatch(w.tx, batchId);
        if (now.state !== BatchState.Open && now.state !== BatchState.Failed) return false;
        for (const { run, shas: own, covered, coveredBy, prior } of commits)
          setWorkstreamNotice(
            w,
            run.id,
            revert !== null && own.length > 0
              ? leftOutNotices.reverted(own.length + covered, revert)
              : coveredBy !== null
                ? leftOutNotices.reverted(covered, coveredBy)
                : prior !== null
                  ? leftOutNotices.alreadyReverted(prior)
                  : leftOutNotices.nothingToRevert(),
          );
        // Every failed member's commits are gone now, so no attempt's are left for its notice to warn of.
        clearBatchNotice(w, batchId, NOTICE_KEY.supersededAttempt);
        for (const run of failed)
          for (const item of openItemsForWorkstream(w.tx, run.id))
            if (item.detail?.[BATCH_CARD_DETAIL] !== undefined) withdrawCard(w, item.id);
        // The notices hold the revert now. Left open, this card would outlive them until the batch
        // shipped, naming an older revert than the one a later answer writes.
        withdrawIn(w, batch.projectId, [leftOutFoldKey(batchId)]);
        transitionBatch(w, batchId, {
          to: BatchState.Shipping,
          patch: { failure: null },
          reason: `shipped without ${named} by the builder`,
        });
        return true;
      });
      if (moved) {
        if (!stopped()) resume(batchId);
        return;
      }
      const { state } = getBatch(db, batchId);
      if (revert === null && carriedOut(state)) return;
      stopWith(overtaken(state));
    } catch (error) {
      const reverted = kept();
      if (reverted !== null) {
        // The write that threw held the withdrawal of the other failed tasks' cards. With the batch
        // still answerable they are withdrawn on their own; the answered run's card is the one this
        // card folds into, and the card offers the same answer.
        let state: BatchState | null = null;
        try {
          state = getBatch(db, batchId).state;
          if (state === BatchState.Open || state === BatchState.Failed)
            deps.state.write((w) => {
              for (const run of failed)
                if (run.id !== workstreamId)
                  for (const item of openItemsForWorkstream(w.tx, run.id))
                    if (item.detail?.[BATCH_CARD_DETAIL] !== undefined) withdrawCard(w, item.id);
            });
        } catch (again) {
          deps.logger.warn(
            { batchId, workstreamId, err: detailOf(again) },
            'ship without a run could not withdraw the other failed cards',
          );
        }
        stopWith(leftOutCards.revertKept(batch, attempt, reverted, detailOf(error), state));
        return;
      }
      if (stopped()) notStarted('10db was stopping');
      else stopWith(leftOutCards.failed(batch, attempt, detailOf(error)));
    }
  }

  /**
   * A shipped batch whose pull request 10db keeps landing: the one that opened it (not a CI fix), set
   * to merge by itself. A pull request held for the builder is the builder's to update.
   */
  function landsItself(batch: BatchDto): boolean {
    return (
      batch.state === BatchState.Shipped &&
      batch.ciFixOf === null &&
      batch.autoMerge &&
      batch.prUrl !== null &&
      batch.branch !== null &&
      batch.repo !== null
    );
  }

  /** Pull requests being caught up or merged again, so a watch round that meets one again queues nothing twice. */
  const catchingUp = new Set<BatchId>();
  const retrying = new Set<BatchId>();
  /** Each pull request's last catch-up: the head it conflicted at, and when it ran. */
  const lastCatchUp = new Map<BatchId, { readonly head: string | null; readonly at: number }>();
  /**
   * Each pull request's merge a catch-up wrote, did not push, and could not put back: the one tip
   * ahead of GitHub's head a later catch-up may rewind. In memory: after a restart that tip gets the card.
   */
  const unpushedHead = new Map<BatchId, string>();
  /**
   * Pull requests 10db pushed to, or could not update, whose merge is asked for again once GitHub says
   * they are clean. In memory: a restart forgets it. What a restart keeps: a refused merge's notice,
   * and, once a catch-up stopped and hid that notice, its card, which the watch reports as it withdraws it.
   */
  const mergeAgain = new Set<BatchId>();
  /**
   * Pull requests whose auto-merge GitHub accepted in this run. In memory: a restart forgets it, and
   * a retry then reports an error as the refused notice rather than assuming auto-merge is on.
   */
  const autoMergeArmed = new Set<BatchId>();
  const lastMergeRetry = new Map<BatchId, number>();

  /**
   * Brings the base into a shipped batch's conflicting pull request, in a worktree made for it from
   * the branch: the merge, the install and the generators of a gate's base update, the pre-check or the
   * gate on the result, then the push. A worktree made here goes again at the end, whatever happened.
   */
  async function catchUpSteps(
    batchId: BatchId,
    signal: AbortSignal,
    cause: CatchUpCause,
  ): Promise<void> {
    // A function, so a check after an await is not narrowed away by the one before it.
    const stopped = (): boolean => signal.aborted;
    const batch = getBatch(db, batchId);
    const { branch, repo, prUrl } = batch;
    if (stopped() || !landsItself(batch) || branch === null || repo === null || prUrl === null)
      return;
    const project = getProject(db, batch.projectId);
    const main = project.repoPath;
    let status: PullRequestStatus | null;
    let queued: boolean;
    try {
      status = await deps.gh.prStatus({ repo, ref: prUrl }, ghCall(deps, signal));
      // A push takes the pull request out of its base's merge queue, and the watch read it a round
      // ago: ask again just before. A queue that cannot be read is no answer, so nothing is pushed.
      queued =
        status?.state === PrState.Open
          ? await deps.gh.prInMergeQueue({ repo, url: prUrl }, ghCall(deps, signal))
          : false;
    } catch (error) {
      if (!stopped())
        deps.logger.warn({ batchId, err: detailOf(error) }, 'pull request not read to catch it up');
      return;
    }
    if (status?.state !== PrState.Open) return;
    if (queued) {
      deps.logger.info({ batchId, prUrl }, 'pull request is in the merge queue: not caught up');
      return;
    }
    // The watch saw this a round ago: a check that has appeared since, running or finished, is
    // never pushed over.
    if (cause === 'checks' ? !checksNeverStarted(status) : !conflicting(status)) return;
    if (cause === 'conflict') {
      const startedAt = deps.clock.now().getTime();
      const last = lastCatchUp.get(batchId);
      // Once per head until the retry time: a failure that raised its card is not tried every round.
      if (last?.head === status.headSha && startedAt - last.at < CATCH_UP_RETRY_MS) return;
      lastCatchUp.set(batchId, { head: status.headSha, at: startedAt });
    }
    /** Raises the one card; neither notice says the same thing as well. */
    const stop = (why: CatchUpStop): void => {
      if (cause === 'checks') {
        // Not a conflict: the watch's notice says the checks never started, and the card would not fit.
        deps.logger.warn({ batchId, prUrl, stop: why.kind }, 'checks not started again');
        return;
      }
      raise(deps.inbox, batch.projectId, prCards.catchUpStopped(getBatch(db, batchId), why));
      hideNotices(deps.state, batchId, [NOTICE_KEY.baseConflict, NOTICE_KEY.merge]);
      mergeAgain.add(batchId);
      deps.logger.warn({ batchId, prUrl, stop: why.kind }, 'pull request not caught up');
    };
    let made = false;
    let before: string | null = null;
    /** The head the base update wrote (its merge, then the generators' commit); null while none has. */
    let wrote: string | null = null;
    let pushed = false;
    let keptAt: string | null = null;
    try {
      const holder = await deps.git.branchInUse(main, branch);
      // The batch's own worktree, kept after it shipped for a file 10db didn't seed: merged there, and kept.
      const kept =
        holder !== null &&
        batch.worktreePath !== null &&
        samePath(comparablePath(holder), comparablePath(batch.worktreePath));
      if (holder !== null && !kept) {
        // A CI fix of this pull request that still runs lets go of the branch when it ends: asked
        // again next round. Until then the pull request says it conflicts, as no card does yet.
        if (heldByRunningFix(batch, holder)) {
          if (cause === 'checks') return;
          lastCatchUp.delete(batchId);
          showNotice(deps.state, batchId, updateNotices.waiting(getBatch(db, batchId)));
          return;
        }
        stop({
          kind: 'other',
          why: `${branch} is checked out at ${holder}, so 10db can't merge ${batch.baseBranch} into it. Close that checkout, or update the pull request on GitHub.`,
        });
        return;
      }
      // The branch as GitHub has it: a fix, or Update branch, may have moved it past the local one.
      const head = status.headSha;
      const tip = await deps.git.branchTip(main, branch);
      if (head === null) {
        if (tip === null) {
          stop({
            kind: 'other',
            why: `10db has no local branch ${branch} and GitHub did not say where the pull request's branch is.`,
          });
          return;
        }
      } else if (tip !== head) {
        if (!(await deps.git.hasCommit(main, head)))
          await deps.git.fetchCommit(main, head, networkCall(deps, signal));
        if (tip === null || (await deps.git.isAncestor(main, tip, head))) {
          // A checked-out branch can't be moved under its files: the kept worktree takes it as a merge.
          if (kept && batch.worktreePath !== null)
            await deps.git.mergeIntoBranch({
              repo: batch.worktreePath,
              branch,
              from: head,
              message: `Merge the pull request's branch ${branch} from GitHub`,
            });
          else await deps.git.fastForwardBranch(main, branch, head);
        } else if (await deps.git.isAncestor(main, head, tip)) {
          // Only the merge an earlier catch-up of this run wrote, and neither pushed nor put back, goes:
          // this one starts from the head. Anything else, a merge the builder made included, stays.
          const recorded = unpushedHead.get(batchId);
          if (recorded !== tip) {
            // When the tip descends from the merge 10db left unpushed, that merge is 10db's, not a
            // commit to push: only the commits after it are named.
            const ownMerge =
              recorded !== undefined && (await deps.git.isAncestor(main, recorded, tip))
                ? recorded
                : null;
            const extra = (await deps.git.commitsSince(main, ownMerge ?? head, tip)).reverse();
            const shown = extra.slice(0, 5).map((sha) => sha.slice(0, 7));
            const one = extra.length === 1;
            const them = one ? 'it' : 'them';
            // Pushing commits that sit on 10db's merge would push the merge too: they move onto the head first.
            const action =
              ownMerge === null
                ? ` Push ${them} to the pull request, or drop ${them} from the local branch.`
                : ` ${one ? 'It sits' : 'They sit'} on 10db's own unpushed merge ${ownMerge.slice(0, 7)}, which was not gated: pushing ${them} as ${one ? 'it is' : 'they are'} would push that merge too. Move ${them} onto the pull request's head with \`git rebase --onto ${head.slice(0, 7)} ${ownMerge.slice(0, 7)} ${branch}\` and push, or drop ${them} from the local branch.`;
            stop({
              kind: 'other',
              why: `${branch} here has ${one ? 'a commit' : `${String(extra.length)} commits`} the pull request's branch on GitHub lacks that 10db did not write (${shown.join(', ')}${extra.length > shown.length ? ', …' : ''}), so 10db left it alone.${action}`,
            });
            return;
          }
          unpushedHead.delete(batchId);
          await deps.git.rewindBranch(
            kept && batch.worktreePath !== null ? batch.worktreePath : main,
            branch,
            tip,
            head,
          );
        } else {
          stop({
            kind: 'other',
            why: `${branch} here and the pull request's branch on GitHub each have commits the other lacks, so 10db can't tell which is current.`,
          });
          return;
        }
      }
      // Where the branch stands before 10db merges into it: where it goes back to unless the merge is pushed.
      before = await deps.git.branchTip(main, branch);
      if (kept) keptAt = batch.worktreePath;
      let path = batch.worktreePath ?? '';
      if (!kept) {
        path = worktreePathFor(madeWorktreeRoot(deps.worktreeRoot), project, branch);
        deps.state.write((w) => patchBatch(w, batchId, { worktreePath: path }));
        made = true;
      }
      // Its own card says why when it refuses.
      if ((await ensureWorktreeWhole(deps, getBatch(db, batchId), signal)) === 'refused') return;
      if (stopped()) return;
      const check = shipCheck(project);
      let update: BaseUpdate | null = null;
      const bringBaseIn = async (): Promise<boolean> => {
        update = await deps.baseUpdates.beforeGate(batchId, signal, { forPullRequest: true });
        // The head 10db wrote, the generators' commit included: read from the answer, not the branch,
        // since the install and the generators run long enough for the builder to commit meanwhile.
        if (
          update.kind === 'merged' ||
          update.kind === 'uncarried' ||
          update.kind === 'unregenerated'
        )
          wrote = update.head;
        // A broken install still left its merge on the branch: it goes back with the others.
        else if (update.kind === 'install_broken' && update.head !== undefined) wrote = update.head;
        return update.kind === 'merged';
      };
      const gate = await deps.baseUpdates.gate(batchId, signal, async () => {
        if (check === null) {
          await bringBaseIn();
          return null;
        }
        return runGate(
          getBatch(db, batchId),
          projectAtCheckout(project, path),
          signal,
          bringBaseIn,
        );
      });
      const brought = update as BaseUpdate | null;
      if (brought === null || brought.kind === 'aborted' || stopped()) return;
      if (brought.kind === 'not_merged') {
        if (brought.held?.reason === 'conflict')
          stop({ kind: 'conflict', paths: brought.held.paths });
        else stop({ kind: 'other', why: brought.note });
        return;
      }
      if (brought.kind === 'install_broken') {
        // Answered only for a merge this update made. The packages do not resolve, so no check could
        // start and the generators did not run: the merge is not pushed, and goes back.
        const left = brought.unregenerated ?? [];
        stop({
          kind: 'other',
          why: `${brought.note}\n\nNo ${check === null ? 'check' : check.kind === 'precheck' ? 'pre-check' : 'gate'} ran and nothing was pushed.${left.length === 0 ? '' : ` The merge's generated directories ${left.join(', ')} could not be regenerated.`}`,
        });
        return;
      }
      if (brought.kind === 'up_to_date') {
        // GitHub says conflict, the branch holds the base: its answer is stale, or the base moved again.
        deps.logger.info(
          { batchId, prUrl },
          'pull request conflicts but its branch holds the base',
        );
        return;
      }
      if (brought.kind === 'uncarried') {
        stop({ kind: 'other', why: `10db pushed nothing. ${brought.note}` });
        return;
      }
      if (brought.kind === 'unregenerated') {
        // The merge has the base's generated directories, without the batch's changes in them: with
        // or without a check, it is not pushed, and goes back with the others. The card says nothing
        // of that: it is raised before the rewind, which leaves a merge under a builder's commit.
        stop({
          kind: 'other',
          why: `${brought.note}\n\nNo ${check === null ? 'check' : check.kind === 'precheck' ? 'pre-check' : 'gate'} ran and nothing was pushed.`,
        });
        return;
      }
      if (check !== null) {
        if (gate === null) return;
        if (gate.timedOut || gate.exitCode !== 0) {
          stop({
            kind: 'gate',
            name: check.kind === 'precheck' ? 'pre-check' : 'gate',
            logPath: gate.logPath,
            settled: (brought.kind === 'merged' ? (brought.resolved ?? []) : []).map((r) => r.path),
          });
          return;
        }
      }
      await pushBranch(getBatch(db, batchId), project, branch, signal);
      pushed = true;
      const resolved = brought.kind === 'merged' ? (brought.resolved ?? []) : [];
      // The base update left this to the push: a merge put back renumbered nothing the batch holds.
      const renumbered = brought.kind === 'merged' ? (brought.renumbered ?? []) : [];
      if (renumbered.length > 0)
        showNotice(
          deps.state,
          batchId,
          migrationNotices.renumbered(
            getBatch(db, batchId).notices.find((n) => n.key === NOTICE_KEY.migrationsRenumbered),
            renumbered,
          ),
        );
      showNotice(
        deps.state,
        batchId,
        cause === 'checks'
          ? updateNotices.restarted(getBatch(db, batchId), resolved)
          : updateNotices.merged(getBatch(db, batchId), resolved),
      );
      hideNotices(deps.state, batchId, [NOTICE_KEY.baseConflict]);
      withdraw(deps.state, deps.inbox, batch.projectId, [prCardKey.catchUp(batchId)]);
      mergeAgain.add(batchId);
      deps.logger.info(
        { batchId, prUrl, files: resolved.map((r) => r.path) },
        'base merged into the pull request',
      );
    } catch (error) {
      if (stopped()) return;
      stop({
        kind: 'other',
        why: `10db hit an error while it merged ${batch.baseBranch} into the pull request: ${detailOf(error)}`,
      });
    } finally {
      if (made) await retire(batchId);
      // A merge that was not pushed is not kept: the next catch-up would find the branch ahead of
      // GitHub's, and, once the builder updates the pull request there, apart from it.
      if (pushed) unpushedHead.delete(batchId);
      else if (before !== null) await rewind(batchId, main, branch, before, wrote, keptAt);
    }
  }

  /**
   * Puts a branch 10db merged into, and did not push, back where it was; a failure is logged. Only
   * the head the base update wrote (`wrote`) goes: a tip past it holds a commit the builder made
   * meanwhile, and a tip with no head written (a stop before the update answered) is not known to be
   * 10db's, so either stays, and the next catch-up's card names the commits.
   */
  async function rewind(
    batchId: BatchId,
    main: string,
    branch: string,
    to: string,
    wrote: string | null,
    keptAt: string | null,
  ): Promise<void> {
    let tip: string | null = null;
    try {
      tip = await deps.git.branchTip(main, branch);
      if (tip === null || tip === to) return;
      if (tip !== wrote) {
        deps.logger.warn(
          { batchId, branch, tip, wrote },
          'branch left as it is after a catch-up that was not pushed: it holds more than 10db wrote',
        );
        return;
      }
      await deps.git.rewindBranch(keptAt ?? main, branch, tip, to);
      unpushedHead.delete(batchId);
    } catch (error) {
      // The merge stays on the branch: the next catch-up of this run may take it back from GitHub's head.
      if (tip !== null && tip !== to) unpushedHead.set(batchId, tip);
      deps.logger.warn(
        { batchId, branch, err: detailOf(error) },
        'branch not put back after a catch-up that was not pushed',
      );
    }
  }

  /**
   * True when `holder` is the worktree of a CI fix of this batch's pull request that is still running.
   * Any other holder, such as a fix that failed and kept its worktree, lets go of the branch only when
   * the builder removes it, so waiting for it would hide that the pull request conflicts.
   */
  function heldByRunningFix(batch: BatchDto, holder: string): boolean {
    const where = comparablePath(holder);
    return listBatches(db, { projectId: batch.projectId }).some(
      (other) =>
        other.ciFixOf === batch.id &&
        other.worktreePath !== null &&
        RUNNING_BATCH.includes(other.state) &&
        samePath(comparablePath(other.worktreePath), where),
    );
  }

  /** Returns false when a drain holds it and nothing was queued; the watch must ask again. */
  function queueCatchUp(batchId: BatchId, cause: CatchUpCause): boolean {
    // A catch-up runs the shipping gate, so none begins during a drain.
    if (deps.holdShips?.()) return false;
    const batch = getBatch(db, batchId);
    if (!landsItself(batch) || catchingUp.has(batchId)) return true;
    catchingUp.add(batchId);
    deps.jobs.run(jobKey(batch, JobQueue.Ship), async (signal) => {
      try {
        await deps.git.operation(() => catchUpSteps(batchId, signal, cause));
      } finally {
        catchingUp.delete(batchId);
      }
    });
    return true;
  }

  const catchUp = (batchId: BatchId): void => {
    queueCatchUp(batchId, 'conflict');
  };
  const restartCi = (batchId: BatchId): boolean => queueCatchUp(batchId, 'checks');

  function retryMerge(batchId: BatchId, opts: RetryMergeOptions = {}): void {
    const batch = getBatch(db, batchId);
    const again = mergeAgain.has(batchId) || opts.catchUpCardWasOpen === true;
    if (!landsItself(batch) || catchingUp.has(batchId) || retrying.has(batchId)) return;
    if (!again && !batch.notices.some((n) => n.key === NOTICE_KEY.merge)) return;
    const startedAt = deps.clock.now().getTime();
    const last = lastMergeRetry.get(batchId);
    if (!again && last !== undefined && startedAt - last < MERGE_RETRY_MS) return;
    lastMergeRetry.set(batchId, startedAt);
    retrying.add(batchId);
    const project = getProject(db, batch.projectId);
    deps.jobs.run(jobKey(batch, JobQueue.Ship), async (signal) => {
      try {
        const now = getBatch(db, batchId);
        const { repo, prUrl } = now;
        if (signal.aborted || !landsItself(now) || repo === null || prUrl === null) return;
        mergeAgain.delete(batchId);
        await turnOnAutoMerge(
          now,
          repo,
          prUrl,
          signal,
          shipCheck(project)?.kind === 'precheck',
          // A re-arm only for a pull request known to have been armed; otherwise an error is the refused notice.
          again && autoMergeArmed.has(batchId),
        );
      } finally {
        retrying.delete(batchId);
      }
    });
  }

  return {
    catchUp,
    restartCi,
    retryMerge,
    checkBatch,
    checkOpenBatches() {
      for (const batch of listBatches(db, { states: [BatchState.Open] })) checkBatch(batch.id);
    },
    checkSupersededBatches() {
      for (const batch of listBatches(db, { states: [BatchState.Open] })) {
        if (listWorkstreams(db, { batchId: batch.id }).some((m) => superseded(db, m)))
          checkBatch(batch.id);
      }
    },
    resume,
    ship,
    shipAnyway(batchId) {
      const unfinished = unfinishedWork(getBatch(db, batchId));
      if (unfinished) throw unfinished;
      return ship(batchId);
    },
    shipWithout(batchId, workstreamId, kept) {
      const batch = getBatch(db, batchId);
      if (batch.state !== BatchState.Open && batch.state !== BatchState.Failed)
        throw new ConflictError(
          `Batch "${batch.title}" is ${batch.state.toLowerCase()}; only an open or failed batch ships`,
        );
      const all = members(db, batchId);
      const left = all.find((m) => m.id === workstreamId);
      if (left?.state !== WorkstreamState.Failed)
        throw new ConflictError(`That run did not fail in batch "${batch.title}"`);
      const unfinished = unfinishedWork(batch);
      if (unfinished) throw unfinished;
      if (!all.some((m) => m.state === WorkstreamState.Done))
        throw new ConflictError(
          `Nothing would be left to ship: no other task in batch "${batch.title}" finished`,
        );
      refuseWhileHeld(batch);
      deps.jobs.run(jobKey(batch, JobQueue.Ship), (signal) =>
        deps.git.operation(() => leaveOut(batchId, workstreamId, kept ?? null, signal)),
      );
      return batch;
    },
    abandon(batchId) {
      const batch = getBatch(db, batchId);
      if (batch.state !== BatchState.Open && batch.state !== BatchState.Failed)
        throw new ConflictError(
          `Batch "${batch.title}" is ${batch.state.toLowerCase()}; only an open or failed batch can be abandoned`,
        );
      const all = listWorkstreams(db, { batchId });
      const running = all.filter(
        (w) =>
          LANE_STATES.includes(w.state) ||
          w.state === WorkstreamState.TakenOver ||
          (w.state === WorkstreamState.WaitingHuman && w.currentSessionId !== null) ||
          deps.isRunning(w.id),
      );
      if (running.length > 0)
        throw new ConflictError(
          `${String(running.length)} workstream(s) in batch "${batch.title}" are running: ${running.map((w) => w.taskTitle).join(', ')}. Cancel them first.`,
        );
      const toCancel = all.filter((w) => !isTerminal(w.state));
      const abandoned = deps.state.write((w) => {
        for (const ws of toCancel) {
          transitionWorkstream(w, ws.id, {
            to: WorkstreamState.Cancelled,
            fence: null,
            patch: { currentSessionId: null },
            reason: 'batch abandoned',
          });
          releaseClaims(w, ws.id);
          clearLease(w, ws.id);
        }
        const moved = transitionBatch(w, batchId, {
          to: BatchState.Abandoned,
          reason: 'abandoned by the builder',
        });
        settleLeftOutCards(w, moved);
        return moved;
      });
      for (const ws of toCancel) deps.inbox.cancelForWorkstream(ws.id);
      deps.jobs.run(jobKey(abandoned, JobQueue.Ship), async () => {
        await afterEnd(batchId, abandoned.worktreePath);
      });
      return abandoned;
    },
  };
}
