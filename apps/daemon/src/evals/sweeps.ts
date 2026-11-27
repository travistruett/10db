import {
  EvalLiveRefusal,
  EvalLiveRefused,
  EvalLiveRunState,
  EvalSweepDto as EvalSweepSchema,
  EvalSweepKind,
  EvalSweepReason,
  EvalSweepState,
  EvalSweepStepState,
  EventType,
  mintId,
  NotFoundError,
  type EvalCandidateDto,
  type EvalLiveModels,
  type EvalLiveRunDto,
  type EvalManifestSuite,
  type EvalSuiteKey,
  type EvalSweepDto,
  type EvalSweepId,
  type ProjectId,
  type StartEvalSweepBody,
} from '@10db/contracts';
import {
  getEvalSweep,
  getProject,
  insertEvalSweep,
  latestEvalSweep,
  listRunningEvalSweeps,
  runningEvalLiveRun,
  runningEvalSweep,
  setEvalSweepSteps,
  updateRunningEvalSweep,
  type DbReader,
  type EvalSweepRow,
} from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { previewHash, refusalText, type EvalLiveRuns } from './live-runs';
import { readEvalManifest } from './manifest-store';
import { modelEnvValue } from './model-env';
import type { EvalsService } from './service';
import { sweepNext } from './sweep-cost';

type Step = EvalSweepDto['steps'][number];
const Steps = z.array(EvalSweepSchema.shape.steps.element);
const Picks = z.array(z.string());

export interface EvalSweepsDeps {
  readonly state: StateStore;
  readonly live: Pick<EvalLiveRuns, 'start' | 'stop'>;
  /** Reads a suite's results, which a step's verdict comes from. */
  readonly evals: Pick<EvalsService, 'candidateBasis'>;
  /** The suite's candidates with their estimates, which a `cheapest` sweep sorts by. */
  readonly candidates: (
    projectId: ProjectId,
    suiteKey: EvalSuiteKey,
  ) => Promise<EvalCandidateDto[]>;
  readonly logger: Logger;
}

export interface EvalSweeps {
  /** Starts the sweep's first step; throws `EvalLiveRefused` (409) when the sweep may not start. */
  start(
    projectId: ProjectId,
    suiteKey: EvalSuiteKey,
    body: StartEvalSweepBody,
  ): Promise<EvalSweepDto>;
  /** Ends the running sweep as the builder's Stop and aborts its running step; throws NotFoundError when it is not running. */
  stop(projectId: ProjectId, sweepId: EvalSweepId): Promise<void>;
  get(projectId: ProjectId, sweepId: EvalSweepId): EvalSweepDto;
  latest(projectId: ProjectId, suiteKey: EvalSuiteKey): EvalSweepDto | null;
  /** Ends the sweeps a crash left `running`: `stopped`·interrupted; starts nothing. */
  recoverAtStart(): void;
  /** Ends every running sweep as the daemon stops, before its runs end; nothing starts after. */
  stopAll(): Promise<void>;
  /** Ends the project's running sweep as the project is archived or removed, before its runs end. */
  stopProject(projectId: ProjectId): Promise<void>;
}

type WriteCtx = Parameters<Parameters<StateStore['write']>[0]>[0];

interface Verdict {
  readonly state:
    | typeof EvalSweepStepState.Passed
    | typeof EvalSweepStepState.Failed
    | typeof EvalSweepStepState.Unreadable;
  readonly costUsd: number | null;
  readonly runId: Step['runId'];
}

interface Ending {
  readonly state: EvalSweepState;
  readonly reason: EvalSweepReason | null;
  readonly reasonText: string | null;
}

const stepsOf = (row: Pick<EvalSweepRow, 'stepsJson'>): Step[] =>
  Steps.parse(JSON.parse(row.stepsJson));

const spentOf = (steps: readonly Step[]): number =>
  steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);

function dtoOf(row: EvalSweepRow): EvalSweepDto {
  const steps = stepsOf(row);
  return {
    id: row.id,
    projectId: row.projectId,
    suiteKey: row.suiteKey,
    kind: row.kind,
    state: row.state,
    reason: row.reason,
    reasonText: row.reasonText,
    capUsd: row.capUsd,
    spentUsd: spentOf(steps),
    winner: row.winner,
    steps,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

/** The names a result may call a pick: the pick itself and, for a choice, the model it maps to. */
function aliasesOf(models: EvalLiveModels | undefined, pick: string): string[] {
  if (models === undefined || models.ids === 'openrouter') return [pick];
  const choice = models.ids.choices.find((c) => c.name === pick);
  return choice === undefined ? [pick] : [...new Set([choice.name, choice.model])];
}

/** The steps as a sweep leaves them: a step that was running is `stopped`, every one still waiting `skipped`. */
const closedSteps = (steps: readonly Step[]): Step[] =>
  steps.map((s) =>
    s.state === EvalSweepStepState.Running
      ? { ...s, state: EvalSweepStepState.Stopped }
      : s.state === EvalSweepStepState.Waiting
        ? { ...s, state: EvalSweepStepState.Skipped }
        : s,
  );

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createEvalSweeps(deps: EvalSweepsDeps): EvalSweeps {
  const { state } = deps;
  /** Set when the daemon stops: nothing starts after it. */
  let closed = false;
  /** Continuations still working, so a daemon stop waits for them. */
  const inFlight = new Set<Promise<void>>();

  function announce(ctx: WriteCtx, row: EvalSweepRow, sweepState: EvalSweepState): void {
    ctx.emit({
      type: EventType.EvalSweepChanged,
      entityType: 'project',
      entityId: row.projectId,
      data: {
        projectId: row.projectId,
        suiteKey: row.suiteKey,
        sweepId: row.id,
        state: sweepState,
      },
    });
    if (sweepState !== EvalSweepState.Running)
      ctx.emit({ type: EventType.ProjectChanged, entityType: 'project', entityId: row.projectId });
  }

  /** Ends a sweep that is still running, in one write: false when it had already ended. */
  function endRunning(
    ctx: WriteCtx,
    id: EvalSweepId,
    steps: readonly Step[],
    ending: Ending,
  ): EvalSweepRow | null {
    const winner =
      ending.state === EvalSweepState.Found
        ? (steps.find((s) => s.state === EvalSweepStepState.Passed)?.model ?? null)
        : null;
    const ended = updateRunningEvalSweep(ctx, id, {
      stepsJson: JSON.stringify(steps),
      end: { ...ending, winner },
    });
    if (ended !== null) announce(ctx, ended, ending.state);
    return ended;
  }

  /** Ends a running sweep from outside its own continuation: a Stop, a refusal, a daemon stop. */
  function endNow(id: EvalSweepId, ending: Ending): boolean {
    return state.write((ctx) => {
      const row = getEvalSweep(ctx.tx, id);
      if (row?.state !== EvalSweepState.Running) return false;
      return endRunning(ctx, id, closedSteps(stepsOf(row)), ending) !== null;
    });
  }

  /** The sweep's models are still ones the suite takes, shown to the builder as the window showed them. */
  function heldAgainst(row: EvalSweepRow, db: DbReader): string | null {
    const suite = suiteOf(db, row.projectId, row.suiteKey);
    if (suite === null) return 'The suite is no longer in the project’s evals.';
    const project = getProject(db, row.projectId);
    if (project.archivedAt !== null) return 'This project is archived.';
    return previewHash(suite, project, Picks.parse(JSON.parse(row.modelsJson))) === row.previewHash
      ? null
      : refusalText(EvalLiveRefusal.ManifestChanged);
  }

  function suiteOf(
    db: DbReader,
    projectId: ProjectId,
    suiteKey: EvalSuiteKey,
  ): EvalManifestSuite | null {
    return readEvalManifest(db, projectId)?.manifest.suites.find((s) => s.key === suiteKey) ?? null;
  }

  /** What a settled step showed: its newest report since the step began that names the step's model. */
  async function verdictOf(row: EvalSweepRow, step: Step, run: EvalLiveRunDto): Promise<Verdict> {
    const unreadable: Verdict = {
      state: EvalSweepStepState.Unreadable,
      costUsd: null,
      runId: run.id,
    };
    const suite = suiteOf(state.db, row.projectId, row.suiteKey);
    if (suite === null) return unreadable;
    const aliases = aliasesOf(suite.live?.models, step.model);
    const basis = await deps.evals.candidateBasis(
      row.projectId,
      getProject(state.db, row.projectId).repoPath,
      row.suiteKey,
    );
    // Reports carry second-precision times; the run's start is floored to match.
    const since = Math.floor(Date.parse(run.startedAt) / 1000) * 1000;
    const newest = basis.runs
      .filter((r) => Date.parse(r.at) >= since && r.models.some((m) => aliases.includes(m.model)))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (newest === undefined) return unreadable;
    const results = newest.models.filter((m) => aliases.includes(m.model));
    return {
      state: results.every((m) => m.passed) ? EvalSweepStepState.Passed : EvalSweepStepState.Failed,
      costUsd: results.some((m) => m.costUsd === null)
        ? null
        : results.reduce((sum, m) => sum + (m.costUsd ?? 0), 0),
      runId: run.id,
    };
  }

  /**
   * One write that takes a sweep to its next place: records the settled step's verdict, then ends the sweep or
   * marks the next step running. It re-reads the sweep in the write, so a sweep that ended meanwhile (a Stop,
   * a daemon stop) is left as it is. Answers the step to start, if any.
   */
  function advance(
    id: EvalSweepId,
    settled: { verdict: Verdict } | null,
  ): { projectId: ProjectId; suiteKey: EvalSuiteKey; model: string; index: number } | null {
    return state.write((ctx) => {
      const row = getEvalSweep(ctx.tx, id);
      if (row?.state !== EvalSweepState.Running) return null;
      const steps = stepsOf(row);
      if (settled !== null) {
        const at = steps.findIndex((s) => s.state === EvalSweepStepState.Running);
        const step = steps[at];
        if (step === undefined) return null;
        steps[at] = {
          ...step,
          state: settled.verdict.state,
          costUsd: settled.verdict.costUsd,
          runId: settled.verdict.runId,
        };
        if (settled.verdict.state === EvalSweepStepState.Unreadable) {
          endRunning(ctx, id, closedSteps(steps), {
            state: EvalSweepState.Stopped,
            reason: EvalSweepReason.Unreadable,
            reasonText: `The result of the run on ${step.model} could not be read.`,
          });
          return null;
        }
      }
      const next = sweepNext({ kind: row.kind, capUsd: row.capUsd, steps });
      if ('end' in next) {
        endRunning(ctx, id, closedSteps(steps), {
          state: next.end,
          reason: next.reason,
          reasonText: null,
        });
        return null;
      }
      const refused = heldAgainst(row, ctx.tx);
      if (refused !== null) {
        endRunning(ctx, id, closedSteps(steps), {
          state: EvalSweepState.Stopped,
          reason: EvalSweepReason.Refused,
          reasonText: refused,
        });
        return null;
      }
      const step = steps[next.step];
      if (step === undefined) return null;
      steps[next.step] = { ...step, state: EvalSweepStepState.Running };
      const moved = updateRunningEvalSweep(ctx, id, { stepsJson: JSON.stringify(steps) });
      if (moved === null) return null;
      announce(ctx, moved, EvalSweepState.Running);
      return {
        projectId: row.projectId,
        suiteKey: row.suiteKey,
        model: step.model,
        index: next.step,
      };
    });
  }

  /** Starts the step `advance` marked, as an ordinary live run that tells this sweep when it settles. */
  async function startStep(
    id: EvalSweepId,
    step: { projectId: ProjectId; suiteKey: EvalSuiteKey; model: string; index: number },
  ): Promise<void> {
    const project = getProject(state.db, step.projectId);
    const suite = suiteOf(state.db, step.projectId, step.suiteKey);
    if (suite === null) throw new NotFoundError('eval suite', step.suiteKey);
    const run = await deps.live.start(
      step.projectId,
      step.suiteKey,
      previewHash(suite, project, [step.model]),
      {
        models: [step.model],
        sweepId: id,
        onSettled: (settled) => {
          afterSettle(id, settled);
        },
      },
    );
    // The run id is learned here, but a settle that came first has set it already.
    try {
      state.write((ctx) => {
        const row = getEvalSweep(ctx.tx, id);
        if (row === null) return;
        const steps = stepsOf(row);
        const at = steps[step.index];
        if (at?.runId !== null) return;
        steps[step.index] = { ...at, runId: run.id };
        setEvalSweepSteps(ctx, id, JSON.stringify(steps));
      });
    } catch (error) {
      deps.logger.warn(
        { sweepId: id, err: messageOf(error) },
        'could not record a sweep step’s run',
      );
    }
  }

  /** Runs `work` for a sweep; any throw ends the sweep `stopped`·refused with its text, never leaving it running. */
  function guarded(id: EvalSweepId, work: () => Promise<void>): Promise<void> {
    const done = work()
      .catch((error: unknown) => {
        const text = messageOf(error);
        deps.logger.error({ sweepId: id, err: text }, 'a model sweep could not go on');
        try {
          endNow(id, {
            state: EvalSweepState.Stopped,
            reason: EvalSweepReason.Refused,
            reasonText: text,
          });
        } catch (again) {
          deps.logger.error(
            { sweepId: id, err: messageOf(again) },
            'could not record a model sweep’s end',
          );
        }
      })
      .finally(() => {
        inFlight.delete(done);
      });
    inFlight.add(done);
    return done;
  }

  /** A step's run has ended: read its result, then end the sweep or start the next step. */
  function afterSettle(id: EvalSweepId, run: EvalLiveRunDto): void {
    void guarded(id, async () => {
      const row = getEvalSweep(state.db, id);
      if (row?.state !== EvalSweepState.Running) return;
      const step = stepsOf(row).find((s) => s.state === EvalSweepStepState.Running);
      if (step === undefined) return;
      if (run.state === EvalLiveRunState.Stopped || run.state === EvalLiveRunState.Interrupted) {
        // Stopped from outside the sweep (the run's own Stop): nothing is read or started.
        endNow(id, {
          state: EvalSweepState.Stopped,
          reason:
            run.state === EvalLiveRunState.Stopped
              ? EvalSweepReason.ByYou
              : EvalSweepReason.Interrupted,
          reasonText: null,
        });
        return;
      }
      const verdict = await verdictOf(row, step, run);
      const next = advance(id, { verdict });
      if (next !== null) await startStep(id, next);
    });
  }

  function endAll(rows: readonly EvalSweepRow[], reasonText: string): void {
    for (const row of rows) {
      try {
        endNow(row.id, {
          state: EvalSweepState.Stopped,
          reason: EvalSweepReason.Interrupted,
          reasonText,
        });
      } catch (error) {
        deps.logger.error(
          { sweepId: row.id, err: messageOf(error) },
          'could not end a model sweep',
        );
      }
    }
  }

  return {
    async start(projectId, suiteKey, body) {
      const refuse = (refusal: EvalLiveRefusal, text = refusalText(refusal)): never => {
        throw new EvalLiveRefused(refusal, text);
      };
      if (closed) refuse(EvalLiveRefusal.Busy, '10db is stopping, so it starts no sweep.');
      const known = suiteOf(state.db, projectId, suiteKey);
      if (known === null) throw new NotFoundError('eval suite', suiteKey);
      const models = known.live?.models;
      if (models === undefined) return refuse(EvalLiveRefusal.NoModels);
      // Each pick, as the suite passes it; a repeat is one step.
      const picks = [...new Set(body.models.map((m) => modelEnvValue(models, [m])))];
      const estimates = new Map(
        (await deps.candidates(projectId, suiteKey)).map((c) => [c.model, c.estimateUsd]),
      );
      const steps: Step[] = picks.map((model) => ({
        model,
        state: EvalSweepStepState.Waiting,
        estimateUsd: estimates.get(model) ?? null,
        costUsd: null,
        runId: null,
      }));
      if (body.kind === EvalSweepKind.Cheapest)
        steps.sort((a, b) => (a.estimateUsd ?? Infinity) - (b.estimateUsd ?? Infinity));

      // Nothing below awaits before the sweep row is written, so what is checked is what is started.
      if (closed) refuse(EvalLiveRefusal.Busy, '10db is stopping, so it starts no sweep.');
      const project = getProject(state.db, projectId);
      if (project.archivedAt !== null) refuse(EvalLiveRefusal.Busy, 'This project is archived.');
      const suite = suiteOf(state.db, projectId, suiteKey);
      if (suite === null) throw new NotFoundError('eval suite', suiteKey);
      if (previewHash(suite, project, body.models) !== body.previewHash)
        refuse(EvalLiveRefusal.ManifestChanged);
      if (
        runningEvalLiveRun(state.db, projectId) !== null ||
        runningEvalSweep(state.db, projectId) !== null
      )
        refuse(EvalLiveRefusal.Busy);
      const id = mintId('EvalSweep');
      const row = state.write((ctx) => {
        const inserted = insertEvalSweep(ctx, {
          id,
          projectId,
          suiteKey,
          kind: body.kind,
          capUsd: body.capUsd,
          modelsJson: JSON.stringify(body.models),
          previewHash: body.previewHash,
          stepsJson: JSON.stringify(steps),
        });
        if (inserted !== null) announce(ctx, inserted, EvalSweepState.Running);
        return inserted;
      });
      if (row === null) return refuse(EvalLiveRefusal.Busy);
      await guarded(id, async () => {
        const first = advance(id, null);
        if (first !== null) await startStep(id, first);
      });
      const now = getEvalSweep(state.db, id);
      return dtoOf(now ?? row);
    },

    async stop(projectId, sweepId) {
      const row = getEvalSweep(state.db, sweepId);
      if (row?.projectId !== projectId || row.state !== EvalSweepState.Running)
        throw new NotFoundError('running eval sweep', sweepId);
      // The sweep ends first, so a step that settles or starts meanwhile finds it ended.
      endNow(sweepId, {
        state: EvalSweepState.Stopped,
        reason: EvalSweepReason.ByYou,
        reasonText: null,
      });
      const running = runningEvalLiveRun(state.db, projectId);
      if (running?.sweepId === sweepId) {
        try {
          await deps.live.stop(projectId, running.id);
        } catch (error) {
          // Settled on its own between the read and the stop: nothing is left to stop.
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
    },

    get(projectId, sweepId) {
      const row = getEvalSweep(state.db, sweepId);
      if (row?.projectId !== projectId) throw new NotFoundError('eval sweep', sweepId);
      return dtoOf(row);
    },

    latest(projectId, suiteKey) {
      const row = latestEvalSweep(state.db, projectId, suiteKey);
      return row === null ? null : dtoOf(row);
    },

    recoverAtStart() {
      endAll(listRunningEvalSweeps(state.db), '10db stopped while this sweep was running.');
    },

    async stopAll() {
      closed = true;
      endAll(listRunningEvalSweeps(state.db), '10db stopped while this sweep was running.');
      await Promise.allSettled([...inFlight]);
    },

    async stopProject(projectId) {
      const row = runningEvalSweep(state.db, projectId);
      if (row !== null)
        endAll([row], 'The project was archived or removed while this sweep was running.');
      await Promise.allSettled([...inFlight]);
    },
  };
}
