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
  clearLease,
  getBatch,
  getProject,
  getTask,
  listBatches,
  listEvidence,
  listPermissionRules,
  listWorkstreams,
  patchBatch,
  patchWorkstream,
  releaseClaims,
  setTaskStatus,
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
import { insertPlannedWorkstream } from '../team';
import { raiseGateHostCards } from '../inbox';
import { takeFoundHostsReading } from '../registries';
import { BlockedRun, type GateResult, type GateRunner } from '../verify';
import { gateNote, type BaseUpdate, type BaseUpdates } from './base-update';
import { settleBranch } from './branch-cleanup';
import {
  autoMergeOffKey,
  autoMergeRefusedKey,
  detailOf,
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
import { resolveShipCards } from './stale-cards';
import {
  ghCall,
  hideNotices,
  networkCall,
  pushCall,
  raise,
  showNotice,
  withdraw,
  type DeliveryContext,
  type DeliveryLimits,
} from './context';
import { readGateFailures, touchedBy, type GateStepFailure } from './gate-failures';
import { jobKey, JobQueue } from './jobs';
import { shipCheck } from './local-check';
import { gateNotices, mergeNotices, NOTICE_KEY, updateNotices } from './notices';
import { readPrScopes, scopeOf } from './pr-scopes';
import type { RetryMergeOptions } from './pr-watch';
import { prBody, prTitle, titlePrefix } from './pr-text';
import { readPrTemplate } from './pr-template';
import { retireWorktree } from './worktree-cleanup';
import { madeWorktreeRoot, worktreePathFor } from './worktree-path';
import { ensureWorktreeWhole, reopenWorktreeBatch } from './worktree-repair';

/**
 * How long a pull request 10db failed to catch up waits before 10db tries it again at the same
 * head: the base may have changed, or the builder fixed what kept it out. A new head tries at once.
 */
const CATCH_UP_RETRY_MS = 30 * 60_000;

/** How long a merge GitHub refused waits before 10db asks again while the pull request stays clean. */
const MERGE_RETRY_MS = 10 * 60_000;

/** Batch states whose work can't run again, so a worktree of theirs stays until someone removes it. */
const FINISHED_BATCH: readonly BatchState[] = [
  BatchState.Shipped,
  BatchState.Closed,
  BatchState.Abandoned,
];

/** True when GitHub says the open pull request conflicts with its base. */
const conflicting = (status: PullRequestStatus): boolean =>
  status.mergeBlocked === MergeBlocked.Conflicts || status.mergeable === PrMergeable.Conflicting;

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
}

export interface Shipper {
  checkBatch(batchId: BatchId): void;
  checkOpenBatches(): void;
  resume(batchId: BatchId): void;
  /** A task drawer on the Board: Ship anyway from OPEN, or Retry from FAILED, which reopens unfinished work. */
  ship(batchId: BatchId): BatchDto;
  /** A failed member's card: ships an open or failed batch whose work is settled, and never reopens one. */
  shipAnyway(batchId: BatchId): BatchDto;
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
   * The open pull request merges cleanly: merges it again, or turns auto-merge on again, when GitHub
   * refused that earlier, 10db just pushed to it, or the watch just withdrew the card of a catch-up
   * that stopped (`catchUpCardWasOpen`). Does nothing when no merge is due.
   */
  retryMerge(batchId: BatchId, opts?: RetryMergeOptions): void;
}

type ConflictedUpdate = Extract<BaseUpdate, { readonly kind: 'conflicted' }>;

/** A batch's members: each task's latest workstream in it. */
function members(db: DbReader, batchId: BatchId): WorkstreamDto[] {
  return latestPerTask(listWorkstreams(db, { batchId }));
}

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
      shipSteps(batchId, signal),
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
      transitionBatch(w, batch.id, { to: BatchState.Failed, patch: { failure }, reason });
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
      transitionBatch(w, batch.id, {
        to: BatchState.Open,
        patch: { failure: null },
        reason: 'a session resolves the merge',
      });
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
   * Runs the check before the push (the pre-check or the gate) on the batch branch, recording its
   * process group for recovery. `beforeStart` runs once it holds its gate slot; a false answer stops
   * it as an abort would.
   */
  async function runGate(
    batch: BatchDto,
    project: ProjectDto,
    signal: AbortSignal,
    beforeStart: () => Promise<boolean>,
  ): Promise<GateResult | null> {
    const gateCommand = shipCheck(project)?.command;
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

  /** Logs the push's duration and output, landed or refused, so what git printed is on record. */
  async function pushBranch(
    batch: BatchDto,
    project: ProjectDto,
    branch: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const run = await deps.git.push(project.repoPath, branch, pushCall(deps, signal));
      deps.logger.info(
        { batchId: batch.id, branch, durationMs: run.durationMs, output: run.output },
        'git push finished',
      );
    } catch (error) {
      if (error instanceof GitNetworkError)
        deps.logger.warn(
          {
            batchId: batch.id,
            branch,
            kind: error.kind,
            durationMs: error.durationMs,
            output: error.output,
          },
          'git push failed',
        );
      throw error;
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
    const tasks = members(db, batch.id).map((w) => {
      const task = getTask(db, w.taskId);
      return {
        title: w.taskTitle,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        state: w.state,
      };
    });
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
        title: prTitle(await prefixFor(batch, project, tasks, target, sha), batch.title),
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
   * failing, a read that failed) merges nothing and raises nothing, and the pull request watch takes over.
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
        step = 'checking the fix for commits';
        const own =
          status.state === PrState.Open
            ? await deps.git.ownCommitsSince(checkout, batch.ciFixHead, `refs/heads/${branch}`)
            : [];
        if (status.state !== PrState.Open || own.length === 0) {
          const reason =
            status.state === PrState.Open
              ? 'the fix made no commits of its own'
              : `its pull request is ${status.state.toLowerCase()}`;
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
        hideNotices(deps.state, batchId, [NOTICE_KEY.gateRerun]);
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
              });
              before.update = update;
              // Markers in the branch fail any gate, and the stale branch isn't what would merge.
              return update.kind !== 'aborted' && update.kind !== 'conflicted';
            }),
          );
          if (gate === null) {
            if (before.update?.kind === 'conflicted' && !stopped())
              sendToMerge(batch, before.update);
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
        if (first.gate.exitCode !== 0) {
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
    const moved = deps.state.write((w) => {
      const batch = getBatch(w.tx, batchId);
      if (batch.state !== BatchState.Open) return false;
      if (shipReadiness(members(w.tx, batchId).map((m) => m.state)) !== ShipReadiness.Ready)
        return false;
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

  function ship(batchId: BatchId): BatchDto {
    const batch = getBatch(db, batchId);
    const unfinished = unfinishedWork(batch);
    switch (batch.state) {
      case BatchState.Open: {
        if (unfinished) throw unfinished;
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
  async function catchUpSteps(batchId: BatchId, signal: AbortSignal): Promise<void> {
    // A function, so a check after an await is not narrowed away by the one before it.
    const stopped = (): boolean => signal.aborted;
    const batch = getBatch(db, batchId);
    const { branch, repo, prUrl } = batch;
    if (stopped() || !landsItself(batch) || branch === null || repo === null || prUrl === null)
      return;
    const project = getProject(db, batch.projectId);
    const main = project.repoPath;
    let status: PullRequestStatus | null;
    try {
      status = await deps.gh.prStatus({ repo, ref: prUrl }, ghCall(deps, signal));
    } catch (error) {
      if (!stopped())
        deps.logger.warn({ batchId, err: detailOf(error) }, 'pull request not read to catch it up');
      return;
    }
    if (status?.state !== PrState.Open || !conflicting(status)) return;
    const startedAt = deps.clock.now().getTime();
    const last = lastCatchUp.get(batchId);
    // Once per head until the retry time: a failure that raised its card is not tried every round.
    if (last?.head === status.headSha && startedAt - last.at < CATCH_UP_RETRY_MS) return;
    lastCatchUp.set(batchId, { head: status.headSha, at: startedAt });
    /** Raises the one card; neither notice says the same thing as well. */
    const stop = (why: CatchUpStop): void => {
      raise(deps.inbox, batch.projectId, prCards.catchUpStopped(getBatch(db, batchId), why));
      hideNotices(deps.state, batchId, [NOTICE_KEY.baseConflict, NOTICE_KEY.merge]);
      mergeAgain.add(batchId);
      deps.logger.warn({ batchId, prUrl, stop: why.kind }, 'pull request not caught up');
    };
    let made = false;
    let before: string | null = null;
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
        // The worktree of a batch whose work still runs, such as a CI fix's, goes when it ends: asked again next round.
        if (heldByLiveBatch(batch, holder)) {
          lastCatchUp.delete(batchId);
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
        } else if (await deps.git.isAncestor(main, head, tip))
          // A merge of an earlier catch-up that was not pushed, nor put back: it goes, and this one starts from the head.
          await deps.git.rewindBranch(
            kept && batch.worktreePath !== null ? batch.worktreePath : main,
            branch,
            tip,
            head,
          );
        else {
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
      if (brought.kind === 'up_to_date') {
        // GitHub says conflict, the branch holds the base: its answer is stale, or the base moved again.
        deps.logger.info(
          { batchId, prUrl },
          'pull request conflicts but its branch holds the base',
        );
        return;
      }
      if (check !== null) {
        if (gate === null) return;
        if (gate.timedOut || gate.exitCode !== 0) {
          stop({
            kind: 'gate',
            name: check.kind === 'precheck' ? 'pre-check' : 'gate',
            logPath: gate.logPath,
          });
          return;
        }
      }
      await pushBranch(getBatch(db, batchId), project, branch, signal);
      pushed = true;
      const resolved = brought.kind === 'merged' ? (brought.resolved ?? []) : [];
      showNotice(deps.state, batchId, updateNotices.merged(getBatch(db, batchId), resolved));
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
      if (!pushed && before !== null) await rewind(batchId, main, branch, before, keptAt);
    }
  }

  /** Puts a branch 10db merged into, and did not push, back where it was; a failure is logged. */
  async function rewind(
    batchId: BatchId,
    main: string,
    branch: string,
    to: string,
    keptAt: string | null,
  ): Promise<void> {
    try {
      const tip = await deps.git.branchTip(main, branch);
      if (tip === null || tip === to) return;
      await deps.git.rewindBranch(keptAt ?? main, branch, tip, to);
    } catch (error) {
      deps.logger.warn(
        { batchId, branch, err: detailOf(error) },
        'branch not put back after a catch-up that was not pushed',
      );
    }
  }

  /** True when `holder` is the worktree of another batch of the project whose work may still run. */
  function heldByLiveBatch(batch: BatchDto, holder: string): boolean {
    const where = comparablePath(holder);
    return listBatches(db, { projectId: batch.projectId }).some(
      (other) =>
        other.id !== batch.id &&
        other.worktreePath !== null &&
        !FINISHED_BATCH.includes(other.state) &&
        samePath(comparablePath(other.worktreePath), where),
    );
  }

  function catchUp(batchId: BatchId): void {
    const batch = getBatch(db, batchId);
    if (!landsItself(batch) || catchingUp.has(batchId)) return;
    catchingUp.add(batchId);
    deps.jobs.run(jobKey(batch, JobQueue.Ship), async (signal) => {
      try {
        await catchUpSteps(batchId, signal);
      } finally {
        catchingUp.delete(batchId);
      }
    });
  }

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
    retryMerge,
    checkBatch,
    checkOpenBatches() {
      for (const batch of listBatches(db, { states: [BatchState.Open] })) checkBatch(batch.id);
    },
    resume,
    ship,
    shipAnyway(batchId) {
      const unfinished = unfinishedWork(getBatch(db, batchId));
      if (unfinished) throw unfinished;
      return ship(batchId);
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
        return transitionBatch(w, batchId, {
          to: BatchState.Abandoned,
          reason: 'abandoned by the builder',
        });
      });
      for (const ws of toCancel) deps.inbox.cancelForWorkstream(ws.id);
      deps.jobs.run(jobKey(abandoned, JobQueue.Ship), async () => {
        await afterEnd(batchId, abandoned.worktreePath);
      });
      return abandoned;
    },
  };
}
