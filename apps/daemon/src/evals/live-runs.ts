import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  EvalLiveRefusal,
  EvalLiveRefused,
  EvalLiveRunState,
  EventType,
  mintId,
  NotFoundError,
  type EvalLivePreviewDto,
  type EvalLiveRunDto,
  type EvalLiveRunId,
  type EvalManifestSuite,
  type EvalSuiteKey,
  type ProjectDto,
  type ProjectId,
} from '@10db/contracts';
import {
  finishEvalLiveRun,
  getProject,
  insertEvalLiveRun,
  interruptRunningEvalLiveRuns,
  listEvalLiveRuns,
  markEvalLiveRunStopRan,
  runningEvalLiveRun,
  type EvalLiveRunRow,
} from '@10db/db';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { openPreviewLedger, type PreviewLedger, type PreviewLedgers } from '../preview';
import type { GateRequest, GateResult, GateRunner } from '../verify';
import { readEvalManifest } from './manifest-store';
import type { EvalsService } from './service';

const REFUSAL_TEXT: Readonly<Record<EvalLiveRefusal | 'shuttingDown' | 'archived', string>> = {
  shuttingDown: '10db is stopping, so it starts no live eval.',
  archived: 'This project is archived.',
  [EvalLiveRefusal.NoLive]: 'This suite records no live run settings, so 10db has no Run for it.',
  [EvalLiveRefusal.NoSandbox]: 'This 10db runs no sandbox, so it will not run a live eval.',
  [EvalLiveRefusal.DockerOff]:
    "This suite runs in Docker and the project's Docker switch is off. Turn it on in the project's settings first.",
  [EvalLiveRefusal.ManifestChanged]:
    'The suite changed since the window showed it. Open Run again to see what it will do now.',
  [EvalLiveRefusal.Busy]: 'A live eval is already running in this project.',
};

/** A stop command ends the work inside the container; it gets this long. */
const STOP_COMMAND_MS = 2 * 60 * 1000;
const RECENT_RUNS = 5;

/** Hashes everything the confirm window shows, and the project switches the run depends on. */
export function previewHash(
  suite: EvalManifestSuite,
  project: Pick<ProjectDto, 'sandboxDocker' | 'sandboxLoopback'>,
): string {
  const live = suite.live;
  return createHash('sha256')
    .update(
      JSON.stringify([
        suite.liveCommand ?? null,
        live?.stopCommand ?? null,
        live?.docker ?? false,
        live?.hosts ?? [],
        live?.envFiles ?? [],
        live?.loopback ?? false,
        live?.timeoutMinutes ?? null,
        project.sandboxDocker,
        project.sandboxLoopback,
      ]),
    )
    .digest('hex');
}

export interface EvalLiveRunsDeps {
  /** The unslotted gate runner: a paid eval never waits for, or holds, a gate slot. */
  readonly gates: GateRunner;
  /** Where a run's processes are remembered; null refuses `no_sandbox`. */
  readonly ledgers: PreviewLedgers | null;
  /** False in a daemon with fake sessions. */
  readonly sandboxed: boolean;
  readonly dataDir: string;
  readonly state: StateStore;
  /** Reads the newest result's cost, for the confirm window. */
  readonly evals: Pick<EvalsService, 'suite'>;
  /** Every registered checkout, whose git state the command can't write. */
  readonly checkouts: () => string[];
  /** The project env the command is given, which the sandbox filters. */
  readonly env: () => Readonly<Record<string, string>>;
  readonly logger: Logger;
}

export interface EvalLiveRuns {
  preview(projectId: ProjectId, suiteKey: EvalSuiteKey): Promise<EvalLivePreviewDto>;
  /** Starts the run the window showed; throws `EvalLiveRefused` and writes no row when it may not. */
  start(projectId: ProjectId, suiteKey: EvalSuiteKey, previewHash: string): Promise<EvalLiveRunDto>;
  /** Sends the abort and answers; the run settles, and its stop command runs, in the background. Throws NotFoundError for one that is not running. */
  stop(projectId: ProjectId, runId: EvalLiveRunId): Promise<void>;
  list(projectId: ProjectId, suiteKey: EvalSuiteKey | null): EvalLiveRunDto[];
  /** Marks the runs a crash left `interrupted` at once and runs their stop commands in the background (a Run is refused busy until they settle); never starts a run. */
  recoverAtStart(): Promise<void>;
  /** Ends every run as the daemon stops: `interrupted`. */
  stopAll(): Promise<void>;
  /** Ends the project's run as the project is archived or removed: `interrupted`. */
  stopProject(projectId: ProjectId): Promise<void>;
}

/** Why a run was ended from outside: the state it settles in. */
type EndedBy = typeof EvalLiveRunState.Stopped | typeof EvalLiveRunState.Interrupted;

interface ActiveRun {
  readonly projectId: ProjectId;
  readonly abort: AbortController;
  endedBy: EndedBy | null;
  /** Why the run was cut short by 10db itself (its process could not be tracked); null otherwise. */
  failure: string | null;
  /** Set once the run's end is decided, so a Stop that comes after changes nothing. */
  decided: boolean;
  readonly settled: Promise<void>;
}

const dtoOf = (row: EvalLiveRunRow): EvalLiveRunDto => ({
  id: row.id,
  projectId: row.projectId,
  suiteKey: row.suiteKey,
  state: row.state,
  startedAt: row.startedAt,
  endedAt: row.endedAt,
  exitCode: row.exitCode,
  tail: row.tail,
  costShownUsd: row.costShownUsd,
  stopRan: row.stopRan,
});

export function createEvalLiveRuns(deps: EvalLiveRunsDeps): EvalLiveRuns {
  const { state } = deps;
  const active = new Map<EvalLiveRunId, ActiveRun>();
  /** Set when the daemon stops: nothing starts after it. */
  let closed = false;
  /** Stop commands of interrupted runs still running after a start, by project: a new Run waits for them. */
  const recovering = new Map<EvalLiveRunId, { projectId: ProjectId; done: Promise<void> }>();
  const recoveringIn = (projectId: ProjectId): boolean =>
    [...recovering.values()].some((r) => r.projectId === projectId);

  function suiteOf(projectId: ProjectId, suiteKey: EvalSuiteKey): EvalManifestSuite {
    const suite = readEvalManifest(state.db, projectId)?.manifest.suites.find(
      (s) => s.key === suiteKey,
    );
    if (suite === undefined) throw new NotFoundError('eval suite', suiteKey);
    return suite;
  }

  function refusalOf(
    suite: EvalManifestSuite,
    project: ProjectDto,
  ): { refusal: EvalLiveRefusal; running: EvalLiveRunRow | null } | null {
    if (suite.live === undefined || suite.liveCommand === undefined)
      return { refusal: EvalLiveRefusal.NoLive, running: null };
    if (!deps.sandboxed || deps.ledgers === null)
      return { refusal: EvalLiveRefusal.NoSandbox, running: null };
    if (suite.live.docker && !project.sandboxDocker)
      return { refusal: EvalLiveRefusal.DockerOff, running: null };
    const running = runningEvalLiveRun(state.db, project.id);
    if (running !== null) return { refusal: EvalLiveRefusal.Busy, running };
    return recoveringIn(project.id) ? { refusal: EvalLiveRefusal.Busy, running: null } : null;
  }

  async function lastCostUsd(project: ProjectDto, suiteKey: EvalSuiteKey): Promise<number | null> {
    try {
      const detail = await deps.evals.suite(project.id, project.repoPath, suiteKey, undefined);
      return detail.runs[0]?.costUsd ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The gate request for the suite's command: a project with no id (so nothing turns Docker on), the
   * Docker and loopback switches only where both suite and project allow them, only the suite's own hosts,
   * and only its env files open for reading.
   */
  function requestOf(
    project: ProjectDto,
    suite: EvalManifestSuite,
    command: string,
    logPath: string,
    timeoutMs: number,
    extra: Pick<GateRequest, 'signal' | 'onSpawn'>,
  ): GateRequest {
    const live = suite.live;
    const docker = (live?.docker ?? false) && project.sandboxDocker;
    return {
      project: {
        repoPath: project.repoPath,
        sandboxLoopback: (live?.loopback ?? false) && project.sandboxLoopback,
        sandboxDocker: docker,
      },
      command,
      logPath,
      timeoutMs,
      env: deps.env(),
      rules: (live?.hosts ?? []).map((pattern) => ({
        toolName: 'SandboxNetworkAccess',
        pattern,
      })),
      checkouts: deps.checkouts(),
      dotEnvReadable: docker ? (live?.envFiles ?? []) : [],
      ...extra,
    };
  }

  function openLedger(): PreviewLedger | null {
    if (deps.ledgers === null) return null;
    return openPreviewLedger(deps.ledgers, (failure, error) => {
      deps.logger.warn(
        { failure, err: error instanceof Error ? error.message : String(error) },
        'could not track a live eval run’s processes',
      );
    });
  }

  /** Tracks a spawned group in the ledger; `lost` runs when it can't be, since the group would outlive the daemon. */
  const tracking =
    (ledger: PreviewLedger, lost: (message: string) => void) =>
    (pid: number): void => {
      ledger.track(pid).catch((error: unknown) => {
        lost(error instanceof Error ? error.message : String(error));
      });
    };

  /** Runs the suite's stop command once, in the run's ledger; true when it ran to an answer. */
  async function runStop(
    project: ProjectDto,
    suite: EvalManifestSuite,
    runId: EvalLiveRunId,
    ledger: PreviewLedger,
  ): Promise<boolean> {
    const command = suite.live?.stopCommand;
    if (command === undefined) return false;
    try {
      await deps.gates.run(
        requestOf(
          project,
          suite,
          command,
          join(deps.dataDir, 'logs', 'evals', `${runId}.stop.log`),
          STOP_COMMAND_MS,
          {
            onSpawn: tracking(ledger, (message) => {
              deps.logger.warn(
                { runId, err: message },
                'could not track a live eval’s stop command',
              );
            }),
          },
        ),
      );
      return true;
    } catch (error) {
      deps.logger.warn(
        { runId, err: error instanceof Error ? error.message : String(error) },
        'a live eval’s stop command failed',
      );
      return false;
    }
  }

  function announce(
    ctx: Parameters<Parameters<StateStore['write']>[0]>[0],
    row: Pick<EvalLiveRunRow, 'projectId' | 'suiteKey' | 'id'>,
    runState: EvalLiveRunState,
  ): void {
    ctx.emit({
      type: EventType.EvalLiveRunChanged,
      entityType: 'project',
      entityId: row.projectId,
      data: { projectId: row.projectId, suiteKey: row.suiteKey, runId: row.id, state: runState },
    });
  }

  function end(
    row: EvalLiveRunRow,
    runState: EvalLiveRunState,
    result: { readonly exitCode: number | null; readonly tail: string },
    stopRan: boolean,
  ): void {
    state.write((ctx) => {
      const changed = finishEvalLiveRun(ctx, row.id, {
        state: runState,
        exitCode: result.exitCode,
        tail: result.tail,
        stopRan,
      });
      if (!changed) return;
      announce(ctx, row, runState);
      // The Evals page and a covered task's block refetch on the project's change.
      ctx.emit({ type: EventType.ProjectChanged, entityType: 'project', entityId: row.projectId });
    });
  }

  async function execute(
    row: EvalLiveRunRow,
    project: ProjectDto,
    suite: EvalManifestSuite,
    ledger: PreviewLedger,
    run: ActiveRun,
  ): Promise<void> {
    let result: GateResult | null = null;
    let crashed: string | null = null;
    try {
      result = await deps.gates.run(
        requestOf(
          project,
          suite,
          row.command,
          row.logPath,
          (suite.live?.timeoutMinutes ?? 60) * 60_000,
          {
            signal: run.abort.signal,
            onSpawn: tracking(ledger, (message) => {
              // A paid run no ledger holds would outlive the daemon: end it.
              run.failure ??= `The run's processes could not be tracked, so it was ended: ${message}`;
              run.abort.abort();
            }),
          },
        ),
      );
    } catch (error) {
      crashed = error instanceof Error ? error.message : String(error);
      deps.logger.warn({ runId: row.id, err: crashed }, 'a live eval run failed to run');
    }
    // The end is decided here, once: a Stop that comes while the stop command or the ledger settles is too late.
    let finalState: EvalLiveRunState;
    if (run.endedBy !== null) finalState = run.endedBy;
    else if (result?.timedOut === true) finalState = EvalLiveRunState.TimedOut;
    else finalState = result?.exitCode === 0 ? EvalLiveRunState.Passed : EvalLiveRunState.Failed;
    run.decided = true;
    const cut = run.endedBy !== null || result?.timedOut === true || run.failure !== null;
    let outcome = { exitCode: result?.exitCode ?? null, tail: result?.tail ?? '' };
    const why = run.failure ?? (crashed === null ? null : `The run could not start: ${crashed}`);
    if (why !== null)
      outcome = { exitCode: outcome.exitCode, tail: `${why}\n${outcome.tail}`.trim() };
    try {
      const stopRan = cut ? await runStop(project, suite, row.id, ledger) : false;
      await ledger.end();
      end(row, finalState, outcome, stopRan);
    } finally {
      active.delete(row.id);
    }
  }

  /** Runs the stop command of a run a crash left, when its suite still hashes as the run did. */
  async function stopLeftBy(row: EvalLiveRunRow): Promise<void> {
    const project = getProject(state.db, row.projectId);
    const suite = readEvalManifest(state.db, row.projectId)?.manifest.suites.find(
      (s) => s.key === row.suiteKey,
    );
    // A suite that changed since the run began may stop something else: its stop command stays unrun.
    if (suite === undefined || previewHash(suite, project) !== row.previewHash) return;
    if (!deps.sandboxed) return;
    const ledger = openLedger();
    if (ledger === null) return;
    const ran = await runStop(project, suite, row.id, ledger);
    await ledger.end();
    if (!ran) return;
    state.write((ctx) => {
      markEvalLiveRunStopRan(ctx, row.id);
      ctx.emit({ type: EventType.ProjectChanged, entityType: 'project', entityId: row.projectId });
    });
  }

  async function endAll(by: EndedBy, only: ProjectId | null): Promise<void> {
    if (only === null) closed = true;
    const runs = [...active.values()].filter((r) => only === null || r.projectId === only);
    for (const r of runs) {
      r.endedBy ??= by;
      r.abort.abort();
    }
    const left = [...recovering.values()].filter((r) => only === null || r.projectId === only);
    await Promise.all([...runs.map((r) => r.settled), ...left.map((r) => r.done)]);
  }

  return {
    async preview(projectId, suiteKey) {
      const project = getProject(state.db, projectId);
      const suite = suiteOf(projectId, suiteKey);
      const refused = refusalOf(suite, project);
      const live = suite.live;
      return {
        suiteKey,
        command: suite.liveCommand ?? '',
        stopCommand: live?.stopCommand ?? null,
        docker: live?.docker ?? false,
        hosts: live?.hosts ?? [],
        envFiles: live?.envFiles ?? [],
        loopback: live?.loopback ?? false,
        timeoutMinutes: live?.timeoutMinutes ?? 0,
        lastRunCostUsd: await lastCostUsd(project, suiteKey),
        previewHash: previewHash(suite, project),
        refusal: refused?.refusal ?? null,
        running: refused?.running ? dtoOf(refused.running) : null,
      };
    },

    async start(projectId, suiteKey, shown) {
      const cost = await lastCostUsd(getProject(state.db, projectId), suiteKey);
      // Nothing below awaits before the run is registered, so a stop that comes during the cost read, or
      // after, finds the run or refuses it: nothing starts once the daemon or the project is stopping.
      if (closed) throw new EvalLiveRefused(EvalLiveRefusal.Busy, REFUSAL_TEXT.shuttingDown);
      const project = getProject(state.db, projectId);
      if (project.archivedAt !== null)
        throw new EvalLiveRefused(EvalLiveRefusal.Busy, REFUSAL_TEXT.archived);
      const suite = suiteOf(projectId, suiteKey);
      const refused = refusalOf(suite, project);
      if (refused !== null)
        throw new EvalLiveRefused(refused.refusal, REFUSAL_TEXT[refused.refusal]);
      if (previewHash(suite, project) !== shown) {
        throw new EvalLiveRefused(
          EvalLiveRefusal.ManifestChanged,
          REFUSAL_TEXT[EvalLiveRefusal.ManifestChanged],
        );
      }
      const live = suite.live;
      const command = suite.liveCommand;
      // Refused above when either is missing.
      if (live === undefined || command === undefined)
        throw new EvalLiveRefused(EvalLiveRefusal.NoLive, REFUSAL_TEXT[EvalLiveRefusal.NoLive]);
      const ledger = openLedger();
      if (ledger === null)
        throw new EvalLiveRefused(
          EvalLiveRefusal.NoSandbox,
          REFUSAL_TEXT[EvalLiveRefusal.NoSandbox],
        );
      const id = mintId('EvalLiveRun');
      let row: EvalLiveRunRow | null;
      try {
        row = state.write((ctx) => {
          const inserted = insertEvalLiveRun(ctx, {
            id,
            projectId,
            suiteKey,
            command,
            stopCommand: live.stopCommand ?? null,
            previewHash: shown,
            docker: live.docker,
            hostsJson: JSON.stringify(live.hosts),
            envFilesJson: JSON.stringify(live.envFiles),
            costShownUsd: cost,
            logPath: join(deps.dataDir, 'logs', 'evals', `${id}.log`),
          });
          if (inserted !== null) announce(ctx, inserted, EvalLiveRunState.Running);
          return inserted;
        });
      } catch (error) {
        await ledger.end();
        throw error;
      }
      if (row === null) {
        await ledger.end();
        throw new EvalLiveRefused(EvalLiveRefusal.Busy, REFUSAL_TEXT[EvalLiveRefusal.Busy]);
      }
      const started = row;
      const abort = new AbortController();
      let settle: () => void = () => undefined;
      const run: ActiveRun = {
        projectId,
        abort,
        endedBy: null,
        failure: null,
        decided: false,
        settled: new Promise<void>((resolve) => {
          settle = resolve;
        }),
      };
      active.set(id, run);
      void execute(started, project, suite, ledger, run)
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          deps.logger.error({ runId: id, err: message }, 'a live eval run could not be settled');
          // The row must not stay running: it would hold the project busy until the next start.
          try {
            end(started, EvalLiveRunState.Failed, { exitCode: null, tail: message }, false);
          } catch (again) {
            deps.logger.error(
              { runId: id, err: again instanceof Error ? again.message : String(again) },
              'could not record a live eval run’s end',
            );
          }
        })
        .finally(() => {
          active.delete(id);
          settle();
        });
      return dtoOf(started);
    },

    // Answers once the abort is sent: the run's own end, and its stop command, settle in the background.
    stop(projectId, runId) {
      const found = active.get(runId);
      const run = found?.projectId === projectId ? found : undefined;
      if (run === undefined) return Promise.reject(new NotFoundError('running eval run', runId));
      if (!run.decided) {
        run.endedBy ??= EvalLiveRunState.Stopped;
        run.abort.abort();
      }
      return Promise.resolve();
    },

    list(projectId, suiteKey) {
      return listEvalLiveRuns(state.db, projectId, suiteKey, RECENT_RUNS).map(dtoOf);
    },

    recoverAtStart() {
      const rows = state.write((ctx) => {
        const interrupted = interruptRunningEvalLiveRuns(ctx);
        for (const row of interrupted) {
          announce(ctx, row, EvalLiveRunState.Interrupted);
          ctx.emit({
            type: EventType.ProjectChanged,
            entityType: 'project',
            entityId: row.projectId,
          });
        }
        return interrupted;
      });
      // The stop commands can take minutes: they run after start, tracked, and a new Run is refused busy until they settle.
      for (const row of rows) {
        if (row.stopCommand === null) continue;
        const done = stopLeftBy(row)
          .catch((error: unknown) => {
            deps.logger.warn(
              { runId: row.id, err: error instanceof Error ? error.message : String(error) },
              'could not stop what an interrupted live eval left running',
            );
          })
          .finally(() => {
            recovering.delete(row.id);
          });
        recovering.set(row.id, { projectId: row.projectId, done });
      }
      return Promise.resolve();
    },

    stopAll: () => endAll(EvalLiveRunState.Interrupted, null),
    stopProject: (projectId) => endAll(EvalLiveRunState.Interrupted, projectId),
  };
}
