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
  releaseClaims,
  transitionBatch,
  transitionWorkstream,
  type DbReader,
} from '@10db/db';
import type { Clock } from '../clock';
import { GitNetworkError, GitNetworkFailure } from '../git';
import { gateNote as overloadNote, type LoadGuard } from '../load';
import { PrState } from '../github';
import { raiseGateHostCards } from '../inbox';
import { BlockedRun, type GateResult, type GateRunner } from '../verify';
import { gateNote, type BaseUpdate, type BaseUpdates } from './base-update';
import { settleBranch } from './branch-cleanup';
import {
  autoMergeOffKey,
  autoMergeRefusedKey,
  nothingToWaitFor,
  shipCards,
  wrongBranchCard,
  type Card,
  type ShipFailure,
} from './cards';
import { allCheckouts, projectAtCheckout } from './checkout';
import { returnCheckout } from './checkout-return';
import { resolveShipCards } from './stale-cards';
import {
  ghCall,
  hideNotices,
  pushCall,
  raise,
  showNotice,
  withdraw,
  type DeliveryContext,
  type DeliveryLimits,
} from './context';
import { readGateFailures, touchedBy, type GateStepFailure } from './gate-failures';
import { jobKey, JobQueue } from './jobs';
import { mergeNotices, NOTICE_KEY } from './notices';
import { readPrScopes, scopeOf } from './pr-scopes';
import { prBody, prTitle, titlePrefix } from './pr-text';
import { readPrTemplate } from './pr-template';
import { retireWorktree } from './worktree-cleanup';
import { ensureWorktreeWhole, reopenWorktreeBatch } from './worktree-repair';

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
}

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
    const project = getProject(db, getBatch(db, batchId).projectId);
    deps.jobs.run(jobKey(project, JobQueue.Ship), (signal) => shipSteps(batchId, signal));
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
   * Runs the project gate on the batch branch, recording its process group for recovery.
   * `beforeStart` runs once the gate holds its slot; a false answer stops it as an abort would.
   */
  async function runGate(
    batch: BatchDto,
    project: ProjectDto,
    signal: AbortSignal,
    beforeStart: () => Promise<boolean>,
  ): Promise<GateResult | null> {
    const gateCommand = project.gateCommand;
    // The caller skips the gate step for a project without a gate.
    if (gateCommand === null) throw new InvalidError('This project has no gate command to run');
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
        gate: { command: project.gateCommand },
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
   * refusal card always, and the project's auto-merge-is-off card once a pull request was set to merge,
   * which shows the setting is on.
   */
  function tellMerge(batch: BatchDto, notice: Notice | null): void {
    if (notice === null) hideNotices(deps.state, batch.id, [NOTICE_KEY.merge]);
    else showNotice(deps.state, batch.id, notice);
    withdraw(deps.state, deps.inbox, batch.projectId, [
      autoMergeRefusedKey(batch.id),
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
  ): Promise<void> {
    const call = ghCall(deps, signal);
    try {
      if (!(await deps.gh.repoAllowsAutoMerge(repo, call))) {
        deps.logger.info(
          { batchId: batch.id, repo, prUrl },
          'repository does not allow auto-merge',
        );
        tellMerge(batch, mergeNotices.notAllowed(repo, prUrl));
        return;
      }
      await deps.gh.prAutoMerge({ repo, url: prUrl }, call);
      tellMerge(batch, null);
      deps.logger.info({ batchId: batch.id, repo, prUrl }, 'auto-merge turned on');
    } catch (error) {
      if (signal.aborted) throw error;
      if (nothingToWaitFor(error)) {
        await mergeNow(batch, repo, prUrl, signal);
        return;
      }
      deps.logger.warn(
        { batchId: batch.id, prUrl, err: error instanceof Error ? error.message : String(error) },
        'auto-merge not turned on',
      );
      tellMerge(batch, mergeNotices.refused(prUrl, error));
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
      const dirty = await deps.git.changedPaths(checkout);
      if (dirty.length > 0) {
        fail(batch, shipCards.dirtyCheckout(batch, dirty, worktreePath ?? undefined));
        return;
      }
      // 1. Nothing beyond the base: nothing to push.
      if ((await deps.git.commitsSince(checkout, baseSha, `refs/heads/${branch}`)).length === 0) {
        const reason = 'no commits beyond the base';
        deps.state.write((w) => transitionBatch(w, batchId, { to: BatchState.Closed, reason }));
        deps.logger.info({ batchId, reason }, 'batch closed');
        await afterEnd(batchId, worktreePath);
        return;
      }
      // 2. The gate, on the branch as it will be pushed: a worktree batch's with its base as origin
      // has it now merged in, so it tests what the pull request would merge. A project with no gate
      // was checked by the builder, task by task, as it was, so neither runs.
      if (project.gateCommand !== null) {
        step = 'the gate';
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
              const update = await deps.baseUpdates.beforeGate(batchId, signal);
              before.update = update;
              return update.kind !== 'aborted';
            }),
          );
          if (gate === null) return null;
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
            ),
          );
          return;
        }
        if (first.gate.exitCode !== 0) {
          const steps = await readGateFailures(checkout, first.gate.tail);
          if (!(await outsideTheBatch(batchId, checkout, steps))) {
            fail(batch, shipCards.gateFailed(batch, first.gate, cardNote(first), steps));
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
                : shipCards.gateFailed(batch, second.gate, cardNote(second), again, true),
            );
            return;
          }
          raise(deps.inbox, batch.projectId, shipCards.gatePassedOnRerun(batch, steps));
        }
      }
      // 3. Push, never forced.
      step = 'git push';
      await pushBranch(batch, project, branch, signal);
      // 4. Any PR for the branch, in any state; create one only when there is none.
      step = 'gh pr view';
      const existing = await deps.gh.prView({ repo, ref: branch }, ghCall(deps, signal));
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
        await turnOnAutoMerge(batch, repo, prUrl, signal);
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

  return {
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
      const done = members(db, batchId)
        .filter((m) => m.state === WorkstreamState.Done)
        .map((m) => m.taskTitle);
      raise(deps.inbox, batch.projectId, shipCards.abandoned(abandoned, done));
      const project = getProject(db, batch.projectId);
      deps.jobs.run(jobKey(project, JobQueue.Ship), async () => {
        await afterEnd(batchId, abandoned.worktreePath);
      });
      return abandoned;
    },
  };
}
