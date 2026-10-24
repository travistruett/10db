import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BatchFailure,
  BatchState,
  ConflictError,
  isTerminal,
  LANE_STATES,
  latestPerTask,
  shipReadiness,
  ShipReadiness,
  WorkstreamState,
  type BatchDto,
  type BatchId,
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
  listWorkstreams,
  patchBatch,
  releaseClaims,
  transitionBatch,
  transitionWorkstream,
  type DbReader,
} from '@10db/db';
import type { Clock } from '../clock';
import { GitNetworkError, GitNetworkFailure } from '../git';
import type { GateResult, GateRunner } from '../verify';
import { shipCards, wrongBranchCard, type ShipFailure } from './cards';
import { ghCall, pushCall, raise, type DeliveryContext, type DeliveryLimits } from './context';
import { prBody, prTitle } from './pr-text';
import { readPrTemplate } from './pr-template';

export interface ShipperDeps extends DeliveryContext {
  readonly gate: GateRunner;
  readonly clock: Clock;
  readonly dataDir: string;
  /** The gate runs in the session environment, as a task's gate does. */
  sessionEnv(project: ProjectDto): Readonly<Record<string, string>>;
  identifyProcess?(pid: number): Promise<string | null>;
  /** True while a runner holds the workstream (its lane is live). */
  isRunning(id: WorkstreamId): boolean;
}

export interface Shipper {
  checkBatch(batchId: BatchId): void;
  checkOpenBatches(): void;
  resume(batchId: BatchId): void;
  /** The batch strip: Ship anyway from OPEN, or Retry from FAILED, which reopens unfinished work. */
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
 * Why a shipping step threw. The push is the only git network call in shipping: a rejected or
 * timed-out push has its own card, and any other git or gh failure is `network`.
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
    deps.jobs.run(getBatch(db, batchId).projectId, (signal) => shipSteps(batchId, signal));
  }

  function fail(batch: BatchDto, outcome: ShipFailure): void {
    const moved = deps.state.write((w) => {
      if (getBatch(w.tx, batch.id).state !== BatchState.Shipping) return false;
      transitionBatch(w, batch.id, {
        to: BatchState.Failed,
        patch: { failure: outcome.failure },
        reason: outcome.card.title,
      });
      return true;
    });
    if (moved) raise(deps.inbox, batch.projectId, outcome.card);
  }

  /** Runs the project gate on the batch branch, recording its process group for recovery. */
  async function runGate(
    batch: BatchDto,
    project: ProjectDto,
    signal: AbortSignal,
  ): Promise<GateResult | null> {
    let recording: Promise<void> = Promise.resolve();
    const result = await deps.gate.run({
      repo: project.repoPath,
      command: project.gateCommand,
      logPath: join(
        deps.dataDir,
        'logs',
        'gate',
        `batch-${batch.id}-${String(deps.clock.now().getTime())}.log`,
      ),
      timeoutMs: deps.limits.gateTimeoutMs,
      env: deps.sessionEnv(project),
      signal,
      onSpawn: (pid) => {
        recording = (deps.identifyProcess?.(pid) ?? Promise.resolve(null)).then((gatePidStart) => {
          if (gatePidStart !== null)
            deps.state.write((w) => patchBatch(w, batch.id, { gatePid: pid, gatePidStart }));
        });
      },
    });
    await recording.catch(() => undefined);
    deps.state.write((w) =>
      patchBatch(w, batch.id, {
        gatePid: null,
        gatePidStart: null,
        ...(result.aborted ? {} : { gateExitCode: result.exitCode, gateLogPath: result.logPath }),
      }),
    );
    // Shutdown killed the gate: record nothing; the batch stays SHIPPING and recovery re-runs it.
    return result.aborted ? null : result;
  }

  /** `target` is the batch's repo and branch, which step 0 checked are set. */
  async function createPr(
    batch: BatchDto,
    project: ProjectDto,
    target: { readonly repo: string; readonly branch: string },
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
    const sha = await deps.git.head(project.repoPath);
    const file = join(deps.dataDir, 'delivery', `${batch.id}-pr-body.md`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      prBody({
        batch,
        tasks,
        gate: { command: project.gateCommand },
        ci: { repo: target.repo, sha },
        template: readPrTemplate(project.repoPath),
      }),
    );
    return deps.gh.prCreate(
      {
        repo: target.repo,
        base: batch.baseBranch,
        head: target.branch,
        title: prTitle(project.prTitlePrefix, batch.title),
        bodyFile: file,
      },
      ghCall(deps, project.repoPath, signal),
    );
  }

  /** Batch delivery spec §6, steps 0–5. Each step is safe to repeat, so a restart runs them all again. */
  async function shipSteps(batchId: BatchId, signal: AbortSignal): Promise<void> {
    const batch = getBatch(db, batchId);
    // A function, so the check in the catch below is not narrowed away by this one.
    const stopped = (): boolean => signal.aborted;
    // Queued before shutdown: leave it SHIPPING for recovery.
    if (stopped() || batch.state !== BatchState.Shipping) return;
    const project = getProject(db, batch.projectId);
    const { branch, baseSha, repo } = batch;
    let step = 'checking the branch';
    try {
      // 0. The branch and a clean checkout.
      const current = await deps.git.currentBranch(project.repoPath);
      if (branch === null || baseSha === null || repo === null || current !== branch) {
        fail(batch, {
          failure: BatchFailure.WrongBranch,
          card: wrongBranchCard(batch, current, project.repoPath, 'not_shipped'),
        });
        return;
      }
      const dirty = await deps.git.status(project.repoPath);
      if (dirty.length > 0) {
        fail(
          batch,
          shipCards.dirtyCheckout(
            batch,
            dirty.map((d) => d.path),
          ),
        );
        return;
      }
      // 1. Nothing beyond the base: nothing to push.
      if ((await deps.git.commitsSince(project.repoPath, baseSha)).length === 0) {
        deps.state.write((w) =>
          transitionBatch(w, batchId, {
            to: BatchState.Closed,
            reason: 'no commits beyond the base',
          }),
        );
        return;
      }
      // 2. The gate, on the branch as it will be pushed.
      step = 'the gate';
      const gate = await runGate(batch, project, signal);
      if (gate === null) return;
      if (gate.timedOut) {
        fail(batch, shipCards.gateTimedOut(batch, deps.limits.gateTimeoutMs, gate.logPath));
        return;
      }
      if (gate.exitCode !== 0) {
        fail(batch, shipCards.gateFailed(batch, gate));
        return;
      }
      // 3. Push, never forced.
      step = 'git push';
      await deps.git.push(project.repoPath, branch, pushCall(deps, signal));
      // 4. Any PR for the branch, in any state; create one only when there is none.
      step = 'gh pr view';
      const existing = await deps.gh.prView(
        { repo, ref: branch },
        ghCall(deps, project.repoPath, signal),
      );
      step = 'gh pr create';
      const prUrl = existing?.url ?? (await createPr(batch, project, { repo, branch }, signal));
      // 5. Record it.
      deps.state.write((w) =>
        transitionBatch(w, batchId, {
          to: BatchState.Shipped,
          patch: { prUrl },
          reason: 'pull request open',
        }),
      );
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
          // Never ship unfinished work: resume it; the batch ships itself when it settles.
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
      return abandoned;
    },
  };
}
