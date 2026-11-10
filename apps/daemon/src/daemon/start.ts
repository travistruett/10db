import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, upgradeWebSocket, type WebSocketServerLike } from '@hono/node-server';
import {
  BRAINSTORM_REFUSED_ON_CHATGPT,
  EventType,
  InvalidError,
  PROTOCOL_VERSION,
  Provider,
  providerOf,
  StepRole,
  type Effort,
  type InboxAnswer,
  type InboxItemDto,
  type ProjectDto,
  type AccountId,
  type ProjectId,
  type ShapeId,
  type SystemCheckDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  addStockHazardCommands,
  countBatchesInFlight,
  countWaitingOnCard,
  isLaneWaitingOnCard,
  createStore,
  DB_MIGRATIONS_DIR,
  deleteAppSetting,
  getWorkstreamRow,
  deleteJudgeCallsBefore,
  lanesByAccount,
  getAccountRow,
  listModelProfiles,
  listAccountModels,
  getAppSetting,
  getProject,
  listPermissionRules,
  listProjects,
  migrateDatabase,
  openDatabase,
  patchAccount,
  seedDefaultAccount,
  setAppSetting,
} from '@10db/db';
import { HARNESS_PLUGIN_DIR, readDefaultPersonas, readSkillBody } from '@10db/harness';
import { WebSocketServer } from 'ws';
import {
  createAccountCardAnswers,
  createAccountLimits,
  createAccountMoves,
  createAccountPauses,
  createAccountPreparer,
  createAccountRuntime,
  createAccountService,
  createModelListWait,
  createListRefresh,
  createMoveBack,
  MoveCause,
  createStartGate,
  createUsageReports,
  type AccountLimits,
} from '../accounts';
import { createApp, type SelfUpdateServices } from '../api';
import { createBenchmarkSync, type BenchmarkSync } from '../benchmarks';
import {
  createAccountLists,
  createCatalogueSync,
  readCatalogueSnapshot,
  reconcileProfiles,
  resumeModelMarks,
  type Catalogue,
} from '../catalogue';
import { createJudge, JUDGE_LOG_RETENTION_MS, type JudgeService } from '../judge';
import { createJudgeServices } from './judge-services';
import {
  backupDatabase,
  hasPendingMigrations,
  pruneBackups,
  scheduleNightlyBackup,
} from '../backups';
import { systemClock, type Clock } from '../clock';
import {
  allCheckouts,
  createBaseUpdates,
  createDependencyChanges,
  createMigrationsBase,
  createBatchCardAnswers,
  createBranchCardAnswers,
  createCiStopAnswers,
  createGhCardAnswers,
  createStartCardAnswers,
  createLostMigrationsAnswers,
  createWorktreeCardAnswers,
  createBatchStarter,
  createDeliveryJobs,
  createPrWatch,
  answerPassMoveCard,
  createKeptWorkGate,
  createPassPullRequests,
  passGateKind,
  createShipper,
  createWorktreeDependencies,
  createWorktreeGenerators,
  DEFAULT_DELIVERY_LIMITS,
  flagWorktreeMissing,
  flagWrongBranch,
  moveRetiredLandings,
  openPass,
  readPnpmVersion,
  recoverBatches,
  removeMergedBranches,
  resolvePnpm,
  resumePassSettles,
  subscribeKeptWorkLanding,
  subscribePassSettles,
  subscribePrWatch,
  subscribeShipTrigger,
  type DeliveryContext,
  type DeliveryLimits,
  type PassOpenDeps,
} from '../delivery';
import type { LogLevel } from '../env';
import {
  ACCOUNT_NAMES_VERIFIED_ON,
  CODEX_VERIFIED_ON,
  createLauncher,
  exportAwsCredentials,
  REQUIRED_TOOLS,
  OPENROUTER_KEY_ACCOUNT,
  unavailableKeychain,
  type AgentTools,
  type Keychain,
  type GhLoginProbe,
  type ResolvedTools,
} from '../environment';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit, memoryPinStore, resolveGit } from '../git';
import { createHazardAssessor, subscribeHazardAssessment } from '../hazards';
import { createGh, createSystemGhExec, resolveGh, type Gh } from '../github';
import { createInboxService, createParkAnswers } from '../inbox';
import { repairKnowledgeIndex } from '../knowledge';
import { createKeepAwake, systemCaffeinate, type CaffeinateSpawner } from '../keep-awake';
import { createLaneTempDirs, createLoadMonitor, type LoadMonitorOptions } from '../load';
import { createLogger, fileDestination, rotateLogFile, type Logger } from '../log';
import { protectedPaths } from '../guard';
import { createBuilderMcpHandler } from '../builder';
import {
  ClaimWaits,
  createClaimDeadlockAnswers,
  createMcpHandler,
  forgetEndedYields,
  withdrawStaleClaimWaits,
} from '../mcp';
import {
  answerMoveToCopy,
  answerPassCard,
  askSignOff,
  cancelSignOffWait,
  closeGateOf,
  createPassCloses,
  putBackKeptWork,
  resumePassWork,
  startAbandon,
  startSignOff,
  subscribeMergedPasses,
  subscribeSignOffWaits,
  takeOut,
  type AbandonDeps,
  type MoveToCopyDeps,
  type PassWorkDeps,
  type TakeOutDeps,
} from '../pass';
import { recoverOnStartup, systemProcesses, type ProcessTerminator } from '../recovery';
import { chooseModel, offeredModels, PLAN_NEED } from '../routing';
import { createScreenBroker, createScreens, renderMayRead } from '../screens';
import { createShapeJev, createShapeService, shapeAgentModels } from '../shape';
import { createKnowledgeServices } from './knowledge-services';
import { createShapeServices } from './shape-services';
import { createShapePreparer } from './shape-session-tools';
import {
  applyCheckAnswer,
  RunnerNotStartedError,
  type StartSignOff,
  createLiveSessions,
  createRunner,
  DEFAULT_RUNNER_LIMITS,
  type Runner,
  type RunnerLimits,
  type StopPassLane,
} from '../runner';
import { resolveSandboxRuntime } from '../paths';
import {
  claimSandboxRoots,
  createGateSandbox,
  createLaneSandbox,
  createLedgerSweep,
  reapLaneProcessLedgers,
  sweepSystemTempDirs,
  sweepSystemTempFiles,
  type SweepReport,
  systemProcessTable,
  tmutilExclusion,
  type BackupExclusion,
  type LaneProcessSetup,
  type LedgerSweep,
  type SandboxRuntime,
} from '../sandbox';
import { createScheduler, type Scheduler } from '../scheduler';
import {
  createDrain,
  createScriptInstaller,
  createSelfUpdate,
  githubHeadOfMain,
  githubMainIsAhead,
  holdBoth,
  midSessionWork,
  cannotUpdate,
  selfUpdateSetting,
  selfUpdateWaitMinutes,
  setSelfUpdateChoice,
  setSelfUpdateWaitMinutes,
  type BuildInfo,
  type ScriptInstaller,
  type SelfUpdate,
} from '../self-update';
import type { SessionAdapter } from '../sessions';
import { routingInputs, seedTeam } from '../team';
import { createThreadService } from '../thread';
import { createGateRunner, createGateSlots, limitGates } from '../verify';
import { CLIENT_APP } from '../version';
import { createWatcher, systemWatch, type WatchFn } from '../watcher';
import { autoDocker } from './auto-docker';
import { createProjectPinStore } from './checkout-pins';
import {
  createCheckoutTrustedHandler,
  createGitCardAnswers,
  createGitRefusalHandler,
  refusedTrustCheckouts,
} from './git-refusal';
import { acquireInstanceLock } from './instance-lock';
import { removeRuntimeFiles, writeRuntimeFiles } from '../runtime-files';
import { createAreaNamer } from './area-namer';
import { createServices } from './services';
import {
  allSandboxRootsOf,
  keepRootsOutOfBackups,
  laneWrittenRootsOf,
  namedSandboxRoots,
  openSandboxRoots,
  sandboxDepsOf,
  sandboxesFor,
  type SandboxRootOptions,
} from './sandbox-roots';
import { assertWorktreeRootAllowed, DEFAULT_WORKTREE_BASE, worktreeRootFor } from './worktree-root';

export interface DaemonOptions {
  readonly dataDir: string;
  readonly port: number;
  /** An adapter, or a factory that gets the daemon's logger (the Claude adapter logs into daemon.log). */
  readonly adapter: SessionAdapter | ((logger: Logger) => SessionAdapter);
  readonly logLevel: LogLevel;
  /**
   * The sandbox every lane and every gate runs under. Its roots (tests) move what it makes off the
   * machine's: `tmpRoot` the temp dirs of Claude lanes, gates and MCP servers (`laneTempRoot()`),
   * `codexLaneTempRoot` a ChatGPT lane's (`~/.10db/lanes`), `filesRoot` the sealed files, env files
   * and process ledgers (`~/.10db/run`), and `systemTempRoots` the system temp dirs every ChatGPT
   * lane writes (`SYSTEM_TEMP_ROOTS`), swept once the daemon listens. `runtime` (tests) replaces srt,
   * which runs the gate. Required,
   * so no caller can forget it: null runs lanes and gates unsandboxed, which only fake sessions and
   * tests ask for, and the Claude adapter refuses such a session. `processes` (tests) replaces how
   * lane processes are read and signalled, for the sessions and for the start-up sweep of a dead
   * daemon's leftovers. `backups` (tests) replaces `tmutil addexclusion`, which asks Time Machine to
   * skip each root.
   */
  readonly sandbox:
    | (SandboxRootOptions & {
        readonly runtime?: SandboxRuntime;
        readonly processes?: LaneProcessSetup;
        readonly backups?: BackupExclusion;
      })
    | null;
  /**
   * Where worktrees are made: a base directory, under which a level named after the data dir is
   * added. Defaults to `~/.10db/worktrees`. Nothing is created there until the first worktree is cut.
   */
  readonly worktreeRoot?: string;
  /** better_sqlite3.node for bundled runs; source runs leave it unset. */
  readonly sqliteBinding?: string;
  readonly clock?: Clock;
  /** Lane caps across all projects; each account has its own `laneCap`. */
  readonly caps?: { readonly global: number };
  /** Recovery attempts, fix attempts, the gate timeout and the gate slots; merged over the runner defaults. */
  readonly limits?: Partial<RunnerLimits>;
  /** How long a lane lease lasts before the scheduler renews it. */
  readonly leaseMs?: number;
  /** How often the scheduler looks for work when nothing asks it to. */
  readonly tickMs?: number;
  /** The GitHub CLI wrapper; tests pass a fake. */
  readonly gh?: Gh;
  /** The login environment fetch, push and gh run in (main.ts builds it from the login shell). */
  readonly networkEnv?: () => Readonly<Record<string, string>>;
  readonly deliveryLimits?: Partial<DeliveryLimits>;
  /** How often shipped pull requests are read; defaults to 2 minutes. */
  readonly prWatchIntervalMs?: number;
  /** How long a provider stays paused when its usage limit gives no reset time. */
  readonly defaultPauseMs?: number;
  /** The environment sessions and gates start from: the captured login shell in production. */
  readonly loginEnv?: Readonly<Record<string, string>>;
  /** Where account secrets are read and written: the login Keychain in production. */
  readonly keychain?: Keychain;
  readonly processes?: ProcessTerminator;
  readonly migrationsDir?: string;
  /** The builder's Artificial Analysis key (the Keychain in production); absent means no sync. */
  readonly aaKey?: () => string | null;
  readonly fetch?: typeof fetch;
  /**
   * Fetch the model catalogue from models.dev and keep it fresh. Off unless given, so a test never reaches
   * the network; the entry point turns it on unless `TENDB_CATALOGUE=off`.
   */
  readonly catalogueSync?: boolean;
  /** The file holding the catalogue the release embeds, read when nothing is stored; absent or missing means none. */
  readonly catalogueSnapshot?: string;
  /** `TENDB_JUDGE=off`: the OpenRouter key is never read and no decision calls OpenRouter. */
  readonly judgeOff?: boolean;
  /** The harness plugin folder the default personas are read from. */
  readonly harnessDir?: string;
  readonly allowedOrigins?: readonly string[];
  /** The one browser origin to accept beside `allowedOrigins` or the webview's (`TENDB_DEV_UI_ORIGIN`). */
  readonly devUiOrigin?: string;
  /** A fixed UI token (dev and Playwright); otherwise a random one per start. */
  readonly uiToken?: string;
  readonly caffeinate?: CaffeinateSpawner;
  /** The system check, given the git and gh the daemon resolved so it reports the ones it runs. */
  readonly systemCheck?: (
    resolved: ResolvedTools,
    ghLogin: GhLoginProbe,
  ) => Promise<SystemCheckDto>;
  /** The pinned Claude Code and Codex the daemon runs; the system check reports them. None where nothing is managed (tests). */
  readonly agents?: AgentTools;
  /** `false` turns the file watcher off (tests that don't need it). */
  readonly watch?: WatchFn | false;
  /**
   * What this bundle was built from (main.ts reads `build-info.json`); absent for a run from source,
   * which shows no commit and never updates itself. The bundle replaces itself only when `updatable`.
   */
  readonly build?: BuildInfo | null;
  /** Self-update overrides: tests pass a short interval, a fake head of main and a fake installer. */
  readonly selfUpdate?: {
    readonly intervalMs?: number;
    readonly headOf?: (repo: string) => Promise<string>;
    readonly isAhead?: (repo: string, base: string, head: string) => Promise<boolean>;
    readonly installer?: ScriptInstaller;
  };
  /** What reads the load and the busy processes, and how much and how long counts as overloaded; tests replace them. */
  readonly load?: Pick<
    LoadMonitorOptions,
    'read' | 'processes' | 'sampleMs' | 'overloadFactor' | 'sustainedMs' | 'clearFactor'
  >;
}

export interface RunningDaemon {
  readonly url: string;
  readonly port: number;
  readonly mcpUrl: string;
  readonly token: string;
  readonly state: StateStore;
  readonly runner: Runner;
  readonly scheduler: Scheduler;
  readonly benchmarks: BenchmarkSync;
  /**
   * Fetches the catalogue, reads every account's list again, rebuilds the model profiles and then updates scores. A
   * call during a run joins it. With `force` every account is read even when the fetch failed; without it a failed
   * fetch leaves alone the accounts read in the last day. Does nothing when `catalogueSync` is off.
   */
  refreshModels(opts: { readonly force: boolean }): Promise<void>;
  /** What routine decisions ask; reads the OpenRouter key from `keychain` for each call. */
  readonly judge: JudgeService;
  stop(): Promise<void>;
}

/** The Tauri webview's origins. A browser origin, such as a Vite dev UI, is opted in by `devUiOrigin`. */
const UI_ORIGINS = ['tauri://localhost', 'http://tauri.localhost'] as const;
/** Written by stop() after every runner has stopped; its absence at start means the last run crashed. */
const CLEAN_SHUTDOWN_KEY = 'daemon.clean_shutdown';
/** How long a Shape tool call may take: propose_plan validates and writes, and answers at once. */
const SHAPE_TOOL_TIMEOUT_MS = 60_000;
/** The most of a Makefile or script read from the base to see whether a gate calls docker. */
const MAX_DOCKER_SCAN_BYTES = 256 * 1024;

/** The session env when none is wired (tests): enough PATH for a gate to find git and test. */
const DEFAULT_SESSION_PATH = '/usr/bin:/bin';

const DEFAULTS = {
  caps: { global: 4 },
  leaseMs: 60_000,
  tickMs: 2_000,
  defaultPauseMs: 30 * 60_000,
  nightlyBackupHour: 3,
  nightlyBackupsKept: 7,
  /** How often main is looked at: one cheap gh call a minute, so a new commit is seen within one. */
  selfUpdateIntervalMs: 60_000,
} as const;

/** Used when no system check is wired (tests): every tool reads as not found. */
function noSystemCheck(): Promise<SystemCheckDto> {
  return Promise.resolve({
    loginEnv: { source: 'inherited', warning: 'The login environment was not captured' },
    claudeCode: { verifiedOn: ACCOUNT_NAMES_VERIFIED_ON, warning: null },
    codex: { verifiedOn: CODEX_VERIFIED_ON, warning: null },
    tools: REQUIRED_TOOLS.map((t) => ({
      name: t.name,
      path: null,
      version: null,
      required: t.required,
      signedIn: null,
    })),
    agents: [],
    benchmarkSync: null,
  });
}

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  // Before anything runs git: the one git every daemon git call runs, from a fixed install prefix,
  // never a PATH, and only one that can be told to read no attributes.
  const gitBin = await resolveGit();
  // gh from the same prefixes; a missing one fails each gh call as not installed, as the system check says.
  const ghBin = resolveGh();
  const clock = opts.clock ?? systemClock;
  const startedAt = clock.now();
  mkdirSync(join(opts.dataDir, 'logs'), { recursive: true });
  const lock = acquireInstanceLock(opts.dataDir);
  const logPath = join(opts.dataDir, 'logs', 'daemon.log');
  rotateLogFile(logPath);
  const logFile = fileDestination(logPath);
  const logger = createLogger({ level: opts.logLevel, destination: logFile });
  /**
   * Ends the log file and waits for its descriptor to close. A stop right after start would otherwise
   * leak the descriptor, and the stream's late open fails once a test has removed the data directory.
   */
  function closeLog(): Promise<void> {
    return new Promise((resolve) => {
      logFile.once('close', () => {
        resolve();
      });
      // SonicBoom emits 'error', not 'close', when its open or close fails, and an unlistened 'error' throws.
      logFile.once('error', () => {
        resolve();
      });
      logFile.end();
    });
  }
  const adapter = typeof opts.adapter === 'function' ? opts.adapter(logger) : opts.adapter;

  const db = openDatabase(
    join(opts.dataDir, '10db.sqlite'),
    opts.sqliteBinding ? { nativeBinding: opts.sqliteBinding } : {},
  );
  const migrationsDir = opts.migrationsDir ?? DB_MIGRATIONS_DIR;
  const backupsDir = join(opts.dataDir, 'backups');
  if (hasPendingMigrations(db, migrationsDir)) {
    await backupDatabase(db, backupsDir, 'pre-migrate', startedAt);
  }
  migrateDatabase(db, migrationsDir);
  // An index out of step with its table is rebuilt and logged; one that can't be rebuilt leaves search
  // off (the list route says so) and the daemon running. No card: it asks the builder nothing.
  const knowledgeIndex = repairKnowledgeIndex(db, logger.child({ component: 'knowledge' }));

  // The sandbox's roots, made private before anything is put there. A refused one refuses every lane
  // session and gate, as a temp dir the sandbox can't make does.
  const sandboxRoots = opts.sandbox ? openSandboxRoots(opts.sandbox, homedir()) : null;
  /** Logs what a sweep of the system temp dirs removed, or which daemon's mark kept it. */
  const logSweep = (report: SweepReport, what: string): void => {
    if (report.removed === 0 && report.failed === 0 && report.sharedWith === null) return;
    logger.info(
      { removed: report.removed, failed: report.failed, sharedWith: report.sharedWith },
      `swept ${what} from the system temp dirs`,
    );
  };
  // The roots lanes write: Claude lanes', ChatGPT lanes', and the system temp dirs, which Codex's base
  // policy opens to every ChatGPT lane. With no sandbox no lane runs, so none is.
  const laneWrittenRoots = sandboxRoots === null ? [] : laneWrittenRootsOf(sandboxRoots);
  const allSandboxRoots = sandboxRoots === null ? [] : allSandboxRootsOf(sandboxRoots);
  // Where this daemon's worktrees live, as a real path. A root that could hold lane-written files or
  // the daemon's own is refused before anything else starts.
  let worktreeRoot: string;
  try {
    worktreeRoot = worktreeRootFor(opts.worktreeRoot ?? DEFAULT_WORKTREE_BASE, opts.dataDir);
    assertWorktreeRootAllowed(worktreeRoot, {
      checkouts: listProjects(db).map((project) => project.repoPath),
      dataDir: opts.dataDir,
      sandboxRoots: allSandboxRoots,
    });
  } catch (error) {
    db.$client.close();
    lock.release();
    await closeLog();
    throw error;
  }

  const bus = createEventBus((error) => {
    logger.error({ err: error }, 'event listener failed');
  });
  const state = createStateStore(
    createStore(db, () => clock.now()),
    bus,
  );
  // A malformed persona file throws and the daemon doesn't start, the same policy as a failed migration.
  seedTeam(state, readDefaultPersonas(opts.harnessDir ?? HARNESS_PLUGIN_DIR));
  // Projects keep the hazard lists they were added with; give them the stock commands added since, once.
  state.write((ctx) => {
    addStockHazardCommands(ctx);
  });
  const launcher = createLauncher({
    base: opts.loginEnv ?? { PATH: DEFAULT_SESSION_PATH },
    clientApp: CLIENT_APP,
    keychain: opts.keychain ?? unavailableKeychain,
  });
  // The builder's current login is the default account, so a project made without one binds to it: the
  // login shell's own Claude Code directory, else Claude Code's default.
  const seeded = state.write((ctx) =>
    seedDefaultAccount(ctx, { expectedIdentity: null, configDir: launcher.loginConfigDir() }),
  );
  // A relative login directory was ignored, so the default account landed on Claude Code's default directory: say so when it is seeded.
  const ignoredLoginDir = launcher.loginConfigDirWarning();
  if (seeded && ignoredLoginDir) logger.warn({}, ignoredLoginDir);
  const benchmarks = createBenchmarkSync({
    state,
    clock,
    fetch: opts.fetch ?? fetch,
    readKey: opts.aaKey ?? (() => null),
    logger: logger.child({ component: 'benchmarks' }),
  });
  benchmarks.start();
  // The accounts' lists and the refresh that follows each fetch are made further down, once the adapter and the
  // start gate exist; they are named here so the catalogue can reach them when it runs.
  let snapshot: { readonly value: Catalogue | null } | undefined;
  const catalogue = createCatalogueSync({
    state,
    clock,
    fetch: opts.fetch ?? fetch,
    logger: logger.child({ component: 'catalogue' }),
    snapshot: () => {
      // The file is part of the install and does not change while the process runs.
      snapshot ??= {
        value: opts.catalogueSnapshot ? readCatalogueSnapshot(opts.catalogueSnapshot) : null,
      };
      return snapshot.value;
    },
    onChanged: (changed) => {
      rebuildProfiles(changed);
    },
    afterSync: (fetched) => refreshAccountModels(fetched),
  });
  const accountLists = createAccountLists({
    state,
    clock,
    catalogue: () => catalogue.catalogue(),
    logger: logger.child({ component: 'catalogue' }),
  });
  const judgeKeychain = opts.keychain ?? unavailableKeychain;
  const judge = createJudge({
    state,
    clock,
    fetch: opts.fetch ?? fetch,
    readKey: () =>
      opts.judgeOff === true
        ? Promise.resolve(null)
        : judgeKeychain.readAsync(OPENROUTER_KEY_ACCOUNT),
    off: opts.judgeOff === true,
    logger: logger.child({ component: 'judge' }),
  });
  state.write((ctx) =>
    deleteJudgeCallsBefore(
      ctx,
      new Date(clock.now().getTime() - JUDGE_LOG_RETENTION_MS).toISOString(),
    ),
  );
  const instanceId = randomUUID();
  const live = createLiveSessions();
  const limits: RunnerLimits = { ...DEFAULT_RUNNER_LIMITS, ...opts.limits };
  const processes = opts.processes ?? systemProcesses;
  let mcpUrl = '';
  // The inbox, pauses and runner call into each other, so each reaches the others through these
  // references; they are set before anything can fire a callback.
  let runner: Runner | null = null;
  let scheduler: Scheduler | null = null;
  // A waiting update drains the factory: no lane, session, task gate or ship starts until it installs.
  const updateDrain = createDrain();
  // Up from the moment an install takes over until the app quits or the install fails. An install at
  // an idle moment has no drain, and a Shape turn does not go through the scheduler it pauses.
  const installHold = createDrain();
  // A task that starts waiting for a claim may be waiting on one that needs a lane to finish.
  const claimWaits = new ClaimWaits({
    onWait: () => {
      scheduler?.requestTick();
    },
    // During the drain a holder that runs nothing (queued, parked before its next session or gate, or
    // waiting on a card with a live session) frees no claim until the update installs. A wait on it
    // would keep its session running, and the update waits for that session to end, so the wait is
    // refused and the session ends by itself.
    parked: (id) =>
      updateDrain.draining &&
      runner !== null &&
      (!runner.isRunning(id) || runner.isParked(id) || isLaneWaitingOnCard(state.db, id)),
  });
  let answerBatchCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerAccountCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerGitCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerBranchCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerCiStopCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerGhCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerStartCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerLostMigrationsCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerWorktreeCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerPassCards: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let startPageSignOff: StartSignOff | null = null;

  // A claim deadlock card's answer makes a task yield its claim, or cancels it as the Board does.
  const answerDeadlockCard = createClaimDeadlockAnswers({
    state,
    cancel: (id) => {
      if (!runner) throw new RunnerNotStartedError();
      return runner.cancel(id);
    },
    waits: claimWaits,
    log: logger,
  });
  // "Park the task" on a lane's question stops the run, as a cancel from the Board does, and parks it.
  const parkAnswers = createParkAnswers({
    state,
    cancel: (id) => {
      if (!runner) throw new RunnerNotStartedError();
      return runner.cancel(id);
    },
    log: logger,
  });
  const inbox = createInboxService({
    state,
    onParkedAnswer: (target, item) => {
      runner?.deliverParkedAnswer(target, item);
    },
    onParkAnswer: parkAnswers,
    log: logger,
    onCheckAnswer: (ctx, item, answer) => {
      const signOffPage = startPageSignOff;
      if (!runner || !signOffPage) throw new RunnerNotStartedError();
      return applyCheckAnswer(runner, ctx, item, answer, signOffPage);
    },
    onFlagAnswer: (item, answer) => {
      runner?.retryTurn(item, answer);
      answerBatchCard?.(item, answer);
      answerAccountCard?.(item, answer);
      answerGitCard?.(item, answer);
      answerBranchCard?.(item, answer);
      answerCiStopCard?.(item, answer);
      answerGhCard?.(item, answer);
      answerStartCard?.(item, answer);
      answerLostMigrationsCard?.(item, answer);
      answerWorktreeCard?.(item, answer);
      answerPassCards?.(item, answer);
      answerDeadlockCard(item, answer);
    },
  });
  // A lane that finds no model profile for its account waits for the profiles instead of retrying every tick.
  const modelWait = createModelListWait({
    db,
    clock,
    inbox,
    logger: logger.child({ component: 'catalogue' }),
    onReleased: () => {
      scheduler?.requestTick();
    },
  });
  /**
   * Writes the model profiles from `catalogue` and ends the wait of every account they now cover. The rebuild is
   * idempotent, so it runs from a fetch, an account list, the catalogue the daemon already holds at start and
   * when an account is created, with no network.
   */
  function rebuildProfiles(from: Catalogue): void {
    state.write((ctx) => {
      reconcileProfiles(ctx, from);
    });
    modelWait.release((id) => {
      const provider = providerOf(getAccountRow(db, id).kind);
      return listModelProfiles(db).some((p) => p.provider === provider);
    });
  }
  // Sustained overload holds new lane sessions and gates and raises one card naming what is busy.
  const laneTempDirs = createLaneTempDirs();
  const loadGuard = createLoadMonitor({
    state,
    inbox,
    clock,
    logger: logger.child({ component: 'load' }),
    daemonPid: process.pid,
    tempRoot: sandboxRoots?.temp ?? null,
    tempDirs: laneTempDirs,
    onCleared: () => {
      scheduler?.requestTick();
    },
    ...opts.load,
  });
  // What holds a lane's next session and a task's gate: an overloaded Mac, or the drain.
  const startHold = holdBoth([loadGuard, updateDrain]);
  const git = createGit({
    onRefused: createGitRefusalHandler({ db: state.db, inbox, logger }),
    onTrusted: createCheckoutTrustedHandler({ db: state.db, inbox }),
    onBookkeepingDropped: (root, dropped) => {
      for (const { rel, writtenBy } of dropped)
        logger.info(
          { root, path: rel, writtenBy },
          'left a Claude Code bookkeeping file out of a commit',
        );
    },
    refusedCheckouts: refusedTrustCheckouts(state.db),
    pins: createProjectPinStore(state, memoryPinStore()),
    bin: gitBin,
    checkouts: () => listProjects(state.db).map((project) => project.repoPath),
    // Where sandboxed lanes and gates make their temp dirs, and the system temp dir every ChatGPT
    // lane writes. With no sandbox no lane runs, so nothing lane-written lies in them.
    laneRoots: [...laneWrittenRoots, worktreeRoot],
    worktreeRoot,
  });
  // srt, which runs every gate and every repo stdio MCP server.
  const runtime = opts.sandbox ? (opts.sandbox.runtime ?? resolveSandboxRuntime()) : null;
  if (sandboxRoots?.refusal) {
    logger.error(
      { err: sandboxRoots.refusal.message },
      'a sandbox root was refused, so no lane session or gate can start',
    );
  }
  // Before any session or gate starts: what a crashed run left in the roots is stale. A refused root
  // is neither swept nor claimed.
  const claimedRoots =
    sandboxRoots?.refusal === null
      ? claimSandboxRoots([sandboxRoots.temp, sandboxRoots.codexLanes, sandboxRoots.files])
      : null;
  // Off the event loop and never waited on by a start: `tmutil` can be slow, and a root it could
  // not exclude costs backup space, not a lane. `stop()` ends what still runs.
  const backupsAbort = new AbortController();
  const rootsKeptOutOfBackups =
    sandboxRoots === null
      ? Promise.resolve()
      : keepRootsOutOfBackups(
          sandboxRoots,
          opts.sandbox?.backups ?? tmutilExclusion,
          logger.child({ component: 'sandbox' }),
          backupsAbort.signal,
        );
  if (
    claimedRoots &&
    (claimedRoots.removed > 0 || claimedRoots.failed > 0 || claimedRoots.sharedWith !== null)
  ) {
    logger.info(
      {
        removed: claimedRoots.removed,
        failed: claimedRoots.failed,
        sharedWith: claimedRoots.sharedWith,
      },
      'swept the sandbox roots',
    );
  }
  // Before recovery and before any session: processes the lane sessions of a daemon that died left
  // running (a lane's background loops reparent to launchd when their session goes) are stopped
  // from the ledgers those sessions kept in the files root. Each ledger names its daemon: one
  // sharing the root that still runs keeps its own, and every dead one's is reaped even then. What a
  // machine whose processes can't be read leaves is swept again while the daemon runs, and so is
  // what a session of this daemon could not stop as it ended; the next start takes whatever is
  // still left.
  const laneProcesses = opts.sandbox?.processes ?? { table: systemProcessTable };
  let ledgerSweep: LedgerSweep | null = null;
  if (sandboxRoots !== null && sandboxRoots.refusal === null) {
    const ledgerRoot = sandboxRoots.files;
    let sweepFailing = false;
    ledgerSweep = createLedgerSweep(ledgerRoot, laneProcesses, {
      onSwept: (report) => {
        sweepFailing = false;
        if (report.ledgers === 0) return;
        logger.info(
          { ledgers: report.ledgers, stopped: report.stopped },
          'stopped the processes ended lane sessions left running',
        );
      },
      onFailed: (error) => {
        // Once until a sweep reads the machine again: one runs every half minute meanwhile.
        if (sweepFailing) return;
        sweepFailing = true;
        logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'could not stop the processes ended lane sessions left running; trying again',
        );
      },
    });
    try {
      const reaped = await reapLaneProcessLedgers(ledgerRoot, laneProcesses);
      if (reaped.ledgers > 0) {
        logger.info(
          { ledgers: reaped.ledgers, stopped: reaped.stopped },
          'stopped the processes a previous daemon’s lane sessions left running',
        );
      }
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'could not stop the processes a previous daemon’s lane sessions left running; trying again while the daemon runs',
      );
      ledgerSweep.later();
    }
  }
  // After the reap, before any lane session or gate can start: a sealed file of 10db's in a system
  // temp dir is readable to every ChatGPT lane, and a ledger there could be one a lane wrote.
  if (sandboxRoots !== null) {
    logSweep(sweepSystemTempFiles(sandboxRoots.systemTemps), "10db's files");
  }
  // Every lane session and every gate runs in one of these; over a refused root both refuse.
  const sandboxes =
    opts.sandbox && sandboxRoots && runtime
      ? sandboxesFor(sandboxRoots, {
          lane: () =>
            createLaneSandbox({
              home: homedir(),
              dataDir: opts.dataDir,
              loginConfigDir: launcher.loginConfigDir(),
              loginCodexHome: launcher.loginCodexHome(),
              gitDirs: (repo) => git.gitDirs(repo),
              ...sandboxDepsOf(sandboxRoots),
              ...(opts.sandbox?.processes === undefined
                ? {}
                : { processes: opts.sandbox.processes }),
              ...(ledgerSweep === null ? {} : { ledgers: ledgerSweep }),
              log: logger.child({ component: 'sandbox' }),
              runtime,
              worktreeRoot,
            }),
          gate: () =>
            createGateSandbox({
              home: homedir(),
              dataDir: opts.dataDir,
              loginConfigDir: launcher.loginConfigDir(),
              loginCodexHome: launcher.loginCodexHome(),
              gitDirs: (repo) => git.gitDirs(repo),
              ...sandboxDepsOf(sandboxRoots),
              log: logger.child({ component: 'sandbox' }),
              runtime,
            }),
        })
      : null;
  // Shared by every gate: a task's, at its green run, and a batch's, at ship. One limiter caps them
  // all, so the machine never runs more than `limits.gateSlots` at once.
  // Every project's gate gets its Docker switch as it stands, and 10db turns it on when the gate
  // needs Docker (`auto-docker.ts`); an install or a generator names no project and is left alone.
  const gateRunner = autoDocker(
    createGateRunner({
      sandbox: sandboxes?.gate ?? null,
      logger: logger.child({ component: 'gate' }),
    }),
    {
      state,
      inbox,
      logger: logger.child({ component: 'gate' }),
      readBase: async (repoPath, ref, path) => {
        const read = await git.fileAt(repoPath, ref, path, MAX_DOCKER_SCAN_BYTES);
        return read.kind === 'file' ? read.text : null;
      },
    },
  );
  const gateSlots = createGateSlots(limits.gateSlots);
  // A task's gate has no hold here: the runner holds it, for the load and the drain, before it takes
  // its batch's turn and its slot, so a held gate keeps neither.
  const gate = limitGates(gateRunner, {
    slots: gateSlots,
    clock,
    logger: logger.child({ component: 'gate' }),
  });
  // A batch's shipping gate belongs to a ship that has begun, and a drain lets that finish: only
  // the load holds it. No new ship begins during the drain (`holdShips`).
  const shipGate = limitGates(gateRunner, {
    slots: gateSlots,
    clock,
    logger: logger.child({ component: 'gate' }),
    hold: loadGuard,
  });
  const answerGit = createGitCardAnswers(git);
  answerGitCard = (item, answer) => {
    // A re-trust reads the checkout first; a refusal it meets raises its own card.
    answerGit(item, answer).catch((error: unknown) => {
      logger.error({ err: error }, 'could not re-trust a checkout');
    });
  };
  const deliveryJobs = createDeliveryJobs(logger.child({ component: 'delivery' }));
  // What the install and the generators of a worktree run with: the gate's sandbox and login env.
  const worktreeTools = {
    gate: gateRunner,
    clock,
    dataDir: opts.dataDir,
    logger: logger.child({ component: 'worktree-install' }),
    sessionEnv: () => launcher.projectEnv(),
    rules: (project: ProjectDto) => listPermissionRules(state.db, project.id, null),
    checkouts: () => allCheckouts(state.db),
    timeoutMs: limits.gateTimeoutMs,
    resolvePnpm,
    pnpmVersion: readPnpmVersion,
  };
  const delivery: DeliveryContext = {
    state,
    git,
    gh: opts.gh ?? createGh(createSystemGhExec({ gh: ghBin, git: gitBin })),
    inbox,
    jobs: deliveryJobs,
    logger: logger.child({ component: 'delivery' }),
    clock,
    limits: {
      ...DEFAULT_DELIVERY_LIMITS,
      gateTimeoutMs: limits.gateTimeoutMs,
      ...opts.deliveryLimits,
    },
    networkEnv: opts.networkEnv ?? (() => ({ PATH: DEFAULT_SESSION_PATH })),
    onWorkQueued: () => {
      scheduler?.requestTick();
    },
    // An ordinary start of a taken-out task puts its saved work back in the checkout it runs in.
    putBack: (input) =>
      putBackKeptWork({ state, git, inbox, jobs: deliveryJobs, logger, clock }, input),
    worktreeRoot,
    // Not behind the gate slots: waiting out a long gate would hold the cut. Each cut downloads the
    // worktree's whole tree (the run's store is empty), so several cuts at once are several downloads.
    dependencies: createWorktreeDependencies(worktreeTools),
    generators: createWorktreeGenerators(worktreeTools),
  };
  answerBranchCard = createBranchCardAnswers(delivery);
  answerCiStopCard = createCiStopAnswers(delivery);
  // A pass's work in Your folder, and its cards (set below, once its take-outs are built).
  const passWork: PassWorkDeps = { state, git, inbox, jobs: delivery.jobs, logger, clock };
  const starter = createBatchStarter(delivery);
  answerStartCard = createStartCardAnswers({ state, starter });
  answerLostMigrationsCard = createLostMigrationsAnswers(delivery);
  // One for the runner and the shipper alike, so a batch's verify and shipping gates run in turn.
  const baseUpdates = createBaseUpdates(delivery);
  // Before a task gets the migrations hazard, from request_claim or at its start.
  const migrationsBase = createMigrationsBase(delivery, baseUpdates);
  // A lane's dependency change, installed in the batch's turn by the daemon (install_dependencies).
  const dependencyChanges = createDependencyChanges(delivery, baseUpdates);
  const shipper = createShipper({
    ...delivery,
    gate: shipGate,
    holdShips: () => updateDrain.draining,
    baseUpdates,
    clock,
    dataDir: opts.dataDir,
    sessionEnv: () => launcher.projectEnv(),
    identifyProcess: (pid) => processes.identify(pid),
    isRunning: (id) => runner?.isRunning(id) ?? false,
    load: loadGuard,
  });
  // A pass's pull request: its push and draft in the delivery key, its gate and one review outside it.
  const passPullRequests = createPassPullRequests({
    ...delivery,
    gate: shipGate,
    holdShips: () => updateDrain.draining,
    clock,
    dataDir: opts.dataDir,
    sessionEnv: () => launcher.projectEnv(),
    identifyProcess: (pid) => processes.identify(pid),
    review: {
      adapter,
      launch: (accountId, model) => {
        const session = launcher.session(
          getAccountRow(state.db, accountId),
          model,
          listAccountModels(state.db, accountId),
        );
        return { model: session.model, env: session.env, expect: session.expect };
      },
      scratchRoot: tmpdir(),
    },
  });
  answerWorktreeCard = createWorktreeCardAnswers(delivery, {
    starter,
    abandon: (id) => shipper.abandon(id),
  });
  answerBatchCard = createBatchCardAnswers({
    retry: (id, note) => {
      starter.retry(id, note);
      scheduler?.requestTick();
    },
    shipper,
  });
  const watcher =
    opts.watch === false
      ? null
      : createWatcher({
          state,
          bus,
          inbox,
          git,
          logger,
          clock,
          watch: opts.watch ?? systemWatch,
        });
  const keepAwake = createKeepAwake({
    state,
    spawn: opts.caffeinate ?? systemCaffeinate,
    daemonPid: process.pid,
    logger,
  });
  const accountPauses = createAccountPauses({
    state,
    clock,
    inbox,
    stopAccount: (id) => runner?.stopAccount(id, 'paused') ?? Promise.resolve(),
    onResume: () => {
      scheduler?.requestTick();
    },
  });
  const accounts = createAccountRuntime({
    state,
    clock,
    inbox,
    pauses: accountPauses,
    defaultPauseMs: opts.defaultPauseMs ?? DEFAULTS.defaultPauseMs,
  });
  const reports = createUsageReports({
    clock,
    staleMs: opts.defaultPauseMs ?? DEFAULTS.defaultPauseMs,
  });
  // Built after the moves, which tell it when a project moved.
  let accountLimits: AccountLimits | null = null;
  const moveBack = createMoveBack({
    state,
    clock,
    inbox,
    pauses: accountPauses,
    reports,
    defaultPauseMs: opts.defaultPauseMs ?? DEFAULTS.defaultPauseMs,
    back: (projectId, to) => {
      moves.move(projectId, to, { cause: MoveCause.MoveBack });
    },
  });
  const moves = createAccountMoves({
    state,
    inbox,
    pauses: accountPauses,
    moveBack,
    handOff: (projectId, accountId, reason) => {
      runner?.handOff(projectId, accountId, reason);
    },
    onMoved: (projectId) => {
      accountLimits?.forget(projectId);
      scheduler?.requestTick();
    },
  });
  accountLimits = createAccountLimits({
    state,
    clock,
    inbox,
    pauses: accountPauses,
    moves,
    reports,
  });
  answerAccountCard = createAccountCardAnswers({
    resume: (id, about) => {
      accountPauses.resume(id, about);
    },
    confirm: (id, identity, answering) => {
      state.write((ctx) => patchAccount(ctx, id, { expectedIdentity: identity }));
      accounts.saved(id, answering);
      scheduler?.requestTick();
    },
    move: (projectId, to, why, answering) => {
      moves.move(projectId, to, why, { answering });
    },
    stay: (projectId) => {
      moves.stay(projectId);
    },
    recheck: (id, projectId, answering, forgetIdentity) => {
      preparer.retry(getAccountRow(state.db, id), projectId, answering, { forgetIdentity });
    },
    raiseCap: (id, toUsd, answering) => {
      // A cap raised since the card was written is never lowered by it.
      const raised = Math.max(toUsd, getAccountRow(state.db, id).monthlyCapUsd ?? 0);
      state.write((ctx) => patchAccount(ctx, id, { monthlyCapUsd: raised }));
      accounts.saved(id, answering);
      scheduler?.requestTick();
    },
  });
  const startGate = createStartGate();
  const preparer = createAccountPreparer({
    state,
    clock,
    inbox,
    adapter,
    lists: accountLists,
    launcher,
    startGate,
    dataDir: opts.dataDir,
    logger: logger.child({ component: 'accounts' }),
    onReady: () => {
      scheduler?.requestTick();
    },
  });
  const listRefresh = createListRefresh({
    state,
    clock,
    adapter,
    launcher,
    startGate,
    lists: accountLists,
    dataDir: opts.dataDir,
    logger: logger.child({ component: 'catalogue' }),
  });
  // What runs after every fetch of the catalogue: each account's list is read again through the identity probe, then
  // the profiles are rebuilt from what the accounts now offer. Scores for the models that changed are read after the
  // profiles exist, so a new model has a row to put them on.
  async function refreshAccountModels(fetched: boolean): Promise<void> {
    // After a failed fetch only accounts not read in the last day are read, so a retry loop does not probe them all;
    // the builder's own refresh reads every account.
    const everyAccount = fetched || forced;
    const builderAsked = forced;
    forced = false;
    await listRefresh.readAll({ staleOnly: !everyAccount });
    const current = catalogue.catalogue();
    if (current !== null) rebuildProfiles(current);
    // Scores come last, so every new model has a row to put them on; with no key or benchmarks off nothing is fetched.
    await benchmarks.syncForCatalogue({ force: builderAsked });
  }
  // One path for the daily timer, the start-up catch-up and the Models page: a call during a run joins it.
  // Off, nothing is fetched and no account is probed.
  const modelRefreshOn = opts.catalogueSync === true;
  /** A forced refresh is waiting for the run in flight to read the accounts. */
  let forced = false;
  const refreshModels = async ({ force }: { readonly force: boolean }): Promise<void> => {
    if (!modelRefreshOn) return;
    forced ||= force;
    await catalogue.sync();
    // A run already past its read never saw the request: read once more.
    if (forced) await refreshAccountModels(true);
  };
  // Profiles come from the catalogue the daemon holds (the stored copy, else the release's snapshot), not from a
  // fetch: a daemon that never fetches still plans and launches on real models. The rebuild is idempotent, so a
  // fetch that lands later only changes what differs.
  const held = catalogue.catalogue();
  if (held !== null) rebuildProfiles(held);
  if (modelRefreshOn) catalogue.start();
  const accountService = createAccountService({
    state,
    clock,
    dataDir: opts.dataDir,
    keychain: opts.keychain ?? unavailableKeychain,
    launcher,
    adapter,
    lists: accountLists,
    // Off, a finished sign-in reads no list either.
    listRefresh: modelRefreshOn ? listRefresh : { readOne: () => Promise.resolve() },
    startGate,
    runtime: accounts,
    pauses: accountPauses,
    logger: logger.child({ component: 'accounts' }),
    liveLanes: (id) => lanesByAccount(db).get(id) ?? 0,
    onSaved: () => {
      scheduler?.requestTick();
    },
    onCreated: () => {
      const held = catalogue.catalogue();
      if (held !== null) rebuildProfiles(held);
    },
  });
  // The data directory, and the default account's sign-in wherever the login shell keeps it.
  const guarded = protectedPaths({
    dataDir: opts.dataDir,
    home: homedir(),
    loginConfigDir: launcher.loginConfigDir(),
  });
  // Shape conversations (spec §5): a read-only session per conversation on the project's account and
  // the `plan` role's model. The MCP address is known once the server listens, so it is read lazily.
  // `see_screen` (§5.5): the window draws a screen on the daemon's request, held to reads by a token
  // that belongs to that one request.
  const screenBroker = createScreenBroker();
  const screens = createScreens({
    state,
    broker: screenBroker,
    filesDir: join(opts.dataDir, 'shapes'),
  });
  // Judged on the account the conversation runs on, which can differ from the project's provider.
  const brainstormRefusal = (projectId: ProjectId): string | null =>
    providerOf(getAccountRow(db, getProject(db, projectId).accountId).kind) === Provider.Codex
      ? BRAINSTORM_REFUSED_ON_CHATGPT
      : null;
  // The model a Plan conversation runs on: what the builder's settings choose for the plan role, by the role's
  // default and never by score, so a conversation is never refused for want of one. Undefined when the account
  // offers nothing to run it on.
  const planModel = (project: ProjectDto): { model: string; effort: Effort } | undefined => {
    const choice = chooseModel({
      ...routingInputs(db, project),
      def: { role: StepRole.Plan, need: PLAN_NEED },
      persona: undefined,
      task: { riskTags: [], acceptanceCriteria: [], areas: [], modelSetting: null },
      project,
      stakes: { retry: false },
      byScore: false,
    });
    return choice.profile === null && choice.model === choice.tier
      ? undefined
      : { model: choice.model, effort: choice.effort };
  };
  const laneSandbox = sandboxes?.lane ?? null;
  const shape = createShapeService({
    state,
    adapter,
    clock,
    log: logger.child({ component: 'shape' }),
    filesDir: join(opts.dataDir, 'shapes'),
    joiningProblem: (taskId) => starter.joiningProblem(taskId),
    screens,
    // A waiting update starts no new Shape turn: a conversation's session is no lane, and the
    // install would cut off one that began during the drain, or while the install starts.
    hold: holdBoth([updateDrain, installHold]),
    jev: createShapeJev({
      state,
      judge,
      log: logger.child({ component: 'shape-jev' }),
      now: () => clock.now(),
    }),
    mcp: {
      get url() {
        return mcpUrl;
      },
      toolTimeoutMs: SHAPE_TOOL_TIMEOUT_MS,
    },
    brainstormRefusal,
    // A Plan conversation runs commands only in a read-only lane sandbox; with none it runs none.
    ...(laneSandbox === null
      ? {}
      : {
          prepare: createShapePreparer({
            state,
            inbox,
            git,
            logger: logger.child({ component: 'shape' }),
            laneSandbox,
            protectedPaths: guarded,
            projectEnv: () => launcher.projectEnv(),
            exportAwsCredentials,
          }),
        }),
    models(projectId) {
      // A conversation that can't run on the project's account has no model to choose.
      if (brainstormRefusal(projectId) !== null) return { default: null, offered: [] };
      const project = getProject(db, projectId);
      const inputs = routingInputs(db, project);
      return {
        default: planModel(project)?.model ?? null,
        offered: offeredModels(inputs.profiles),
      };
    },
    launch(projectId, chosen) {
      const project = getProject(db, projectId);
      const row = getAccountRow(db, project.accountId);
      const refusal = brainstormRefusal(projectId);
      if (refusal !== null) throw new InvalidError(refusal);
      const profile = planModel(project);
      if (profile === undefined)
        throw new InvalidError(`${row.label} offers no model for planning`);
      // The builder's pick runs at the plan role's effort, while the account still offers it; one it has
      // stopped offering since gives way to the role's.
      const offered = offeredModels(routingInputs(db, project).profiles).map((o) => o.model);
      const modelId = chosen !== null && offered.includes(chosen) ? chosen : profile.model;
      const session = launcher.session(row, modelId, listAccountModels(db, row.id));
      return {
        cwd: project.repoPath,
        model: session.model,
        modelId,
        effort: profile.effort,
        agentModels: shapeAgentModels(row.kind),
        env: session.env,
        account: session.expect,
        access: {
          checkout: project.repoPath,
          home: homedir(),
          protectedReads: guarded.map((p) => p.path),
          sandboxRoots: allSandboxRootsOf(sandboxRoots ?? namedSandboxRoots({}, homedir())),
        },
      };
    },
  });
  // The marks from an error's wording that ended, or will end, while the daemon was down.
  resumeModelMarks({ state, clock });
  const createdRunner = createRunner({
    protectedPaths: guarded,
    laneSandbox,
    codexLaneTempRoot: (sandboxRoots ?? namedSandboxRoots({}, homedir())).codexLanes,
    worktreeRoot,
    hold: startHold,
    laneTempDirs,
    state,
    adapter,
    inbox,
    git,
    jobs: deliveryJobs,
    gate,
    baseUpdates,
    migrationsBase,
    judge,
    clock,
    logger,
    exportAwsCredentials,
    dataDir: opts.dataDir,
    live,
    limits,
    mcpUrl: () => mcpUrl,
    skillBody: (name) => readSkillBody(name, opts.harnessDir ?? HARNESS_PLUGIN_DIR),
    launcher,
    startGate,
    modelWait,
    accounts: {
      ...accounts,
      prepare: (account, projectId) => {
        preparer.prepare(account, projectId);
      },
      usageReported: (accountId, report) => {
        accountLimits.usageReported(accountId, report);
      },
    },
    onLaneFreed: () => {
      scheduler?.requestTick();
    },
    ...(watcher
      ? { afterSession: (id: WorkstreamId) => watcher.stepEnd(id).then(() => undefined) }
      : {}),
    identifyProcess: (pid) => processes.identify(pid),
  });
  runner = createdRunner;
  const createdScheduler = createScheduler({
    state,
    runner: createdRunner,
    accounts: {
      ...accounts,
      prepare: (account, projectId) => {
        preparer.prepare(account, projectId);
      },
      // Off, no session start reads a list.
      ...(modelRefreshOn
        ? {
            readList: (id: AccountId) => {
              void listRefresh.readIfStale(id);
            },
          }
        : {}),
    },
    connecting: () => accountService.connecting(),
    // A run in Your folder of a local project waits for its task's saved work to go back (call 33).
    keptWork: createKeptWorkGate(delivery),
    modelWait,
    clock,
    instanceId,
    logger,
    caps: opts.caps ?? DEFAULTS.caps,
    leaseMs: opts.leaseMs ?? DEFAULTS.leaseMs,
    tickMs: opts.tickMs ?? DEFAULTS.tickMs,
    branches: git,
    onWrongBranch: (batch, current, checkout) => {
      flagWrongBranch(inbox, batch, current, checkout);
    },
    onWorktreeMissing: (batch, path) => {
      flagWorktreeMissing(inbox, batch, path);
    },
    awaitedHolders: () => claimWaits.awaitedHolders(),
    held: () => loadGuard.overloaded || updateDrain.draining,
  });
  scheduler = createdScheduler;

  const cleanShutdown = getAppSetting(db, CLEAN_SHUTDOWN_KEY) !== undefined;
  state.write((ctx) => {
    deleteAppSetting(ctx, CLEAN_SHUTDOWN_KEY);
  });
  await recoverOnStartup({
    state,
    inbox,
    git,
    jobs: deliveryJobs,
    clock,
    processes,
    maxRecoveryAttempts: limits.maxRecoveryAttempts,
    logger,
    cleanShutdown,
  });
  // A pass's take-outs and Abandon stop its lanes through the runner, and tell the watcher which
  // files their put-back wrote.
  const stopLane: StopPassLane = (id) => createdRunner.stopPassLane(id);
  const passTakeOuts: TakeOutDeps = {
    ...passWork,
    stopLane,
    wrote: (repo, paths) => watcher?.daemonWrote(repo, paths) ?? Promise.resolve(),
  };
  // A Ready page's Sign Off, from its route or its check item; one waiting for another page's hold
  // goes on once that hold closes.
  startPageSignOff = (taskId) => {
    startSignOff(passTakeOuts, taskId);
  };
  const unsubscribeSignOffWaits = subscribeSignOffWaits(bus, passTakeOuts);
  // A pass page that asked for migrations or deps: Move to a Separate Copy takes it out and starts
  // it in a copy, as the Board's Start does.
  const passMoves: MoveToCopyDeps = {
    ...passTakeOuts,
    startInCopy: (taskId) => {
      starter.startTask(taskId);
      createdScheduler.requestTick();
    },
  };
  answerPassCards = (item, answer) => {
    answerPassCard(passWork, item, answer);
    answerPassMoveCard(delivery, item, answer);
    void answerMoveToCopy(passMoves, item, answer);
  };
  // A task has saved work only once a take-out has kept it; a later pass puts it back.
  const passOpenDeps: PassOpenDeps = {
    leaseMs: opts.leaseMs ?? DEFAULTS.leaseMs,
    putBack: (input) => putBackKeptWork(passWork, input),
  };
  // Close Pass, its steps under the delivery key with its gate and pull request through 7b's seam;
  // a pass whose pull request merged while it was open closes by itself, its unfinished pages
  // carried over to a follow-on pass.
  const passCloses = createPassCloses({
    ...passTakeOuts,
    ship: passPullRequests,
    gateWhere: (pass) => closeGateOf(passGateKind(getProject(state.db, pass.projectId))),
    openFollowOn: (input) => openPass(delivery, input, passOpenDeps),
  });
  const unsubscribeMergedPasses = subscribeMergedPasses(bus, state.db, passCloses);
  // Abandon Pass stops what ships for the pass first: its pull request's checks and its close.
  const passAbandons: AbandonDeps = {
    ...passTakeOuts,
    stopShip: async (passId) => {
      await passPullRequests.stopPassChecks(passId);
      await passCloses.abort(passId);
    },
  };
  // Each open pass goes on from its rows: its folder card, a put-back, take-outs and sign-offs cut short.
  await resumePassWork(passTakeOuts);
  // A close a restart cut short goes on from its last step.
  passCloses.resume();
  // The previous daemon's claim waits ended with it; their cards would name holders nobody waits for.
  withdrawStaleClaimWaits(state, inbox);
  accountPauses.restore();
  // A move back that came due reads the pauses.
  moveBack.restore();
  await recoverBatches({
    state,
    git,
    inbox,
    processes,
    shipper,
    starter,
    logger: logger.child({ component: 'delivery' }),
    worktrees: { ctx: delivery, root: worktreeRoot },
  });
  // Tasks made for a branch that is gone from origin land in their project's default now. It asks
  // origin, so it runs beside the start (an offline start waits on no timeout) and ends with it.
  const retiredLandingsAbort = new AbortController();
  const retiredLandings = moveRetiredLandings(delivery, retiredLandingsAbort.signal).catch(
    (error: unknown) => {
      logger.warn({ err: error }, 'tasks on retired landing branches not moved');
    },
  );
  const unsubscribeShip = subscribeShipTrigger(bus, state.db, shipper);
  // A pass that closes unsettled gets its Move card, and each closed pass is looked at again; a
  // started task's saved work goes once its work lands.
  const unsubscribePassSettles = subscribePassSettles(bus, delivery);
  const unsubscribeKeptWork = subscribeKeptWorkLanding(bus, delivery);
  resumePassSettles(delivery);
  // Outside the delivery job queues: a slow or offline gh never holds a cut or a ship.
  const prWatch = createPrWatch({
    ctx: delivery,
    clock,
    ciFix: { dataDir: opts.dataDir },
    // A pull request that conflicts gets its base merged in, and a merge GitHub refused is retried.
    landing: shipper,
    // A pull request that merges or closes ends the fix session still working on it.
    endFixes: {
      cancel: (id) => createdRunner.cancel(id),
      abandon: (id) => shipper.abandon(id),
    },
    ...(opts.prWatchIntervalMs ? { intervalMs: opts.prWatchIntervalMs } : {}),
    // A merged pull request's local branch goes in the round that reads the merge.
    afterRound: (signal) => removeMergedBranches(delivery, signal),
  });
  const unsubscribePrWatch = subscribePrWatch(bus, prWatch);
  answerGhCard = createGhCardAnswers(prWatch);

  // Lanes start and stop through workstream events; keep-awake and the watcher follow them.
  const unsubscribeLanes = bus.subscribe((event) => {
    if (event.type === EventType.WorkstreamCreated || event.type === EventType.WorkstreamChanged) {
      keepAwake.refresh();
      watcher?.sync();
    }
  });
  // A yield the builder chose for a task that then ended is never delivered; drop it.
  const unsubscribeYields = forgetEndedYields(bus, claimWaits);
  keepAwake.refresh();
  watcher?.sync();

  const token = opts.uiToken ?? randomBytes(32).toString('base64url');
  const areaNamer = createAreaNamer({ adapter, launcher, db: state.db, scratchRoot: tmpdir() });
  // Reads each project's repository for its hazards: when it is added, when a commit changes a
  // manifest, lockfile, makefile, compose file or AGENTS.md, and when Settings asks. The model gets text
  // and no tool, like the area namer, and when it is unavailable or slow nothing changes.
  const hazardAssessor = createHazardAssessor({ state, git, asker: areaNamer, logger });
  const unsubscribeHazards = subscribeHazardAssessment(
    bus,
    {
      projectOfWorkstream: (id) => {
        try {
          return getWorkstreamRow(state.db, id).projectId;
        } catch {
          return null;
        }
      },
    },
    hazardAssessor,
  );
  const services = createServices({
    state,
    clock,
    bus,
    runner: createdRunner,
    scheduler: createdScheduler,
    moves,
    inbox,
    keepAwake,
    systemCheck: () =>
      opts.systemCheck
        ? opts.systemCheck({ git: gitBin, gh: ghBin }, () =>
            delivery.gh.authLogin({
              env: delivery.networkEnv(),
              timeoutMs: delivery.limits.networkTimeoutMs,
            }),
          )
        : noSystemCheck(),
    agents: opts.agents ?? null,
    benchmarks,
    catalogue,
    refreshModels,
    catalogueOn: modelRefreshOn,
    judge: createJudgeServices({
      state,
      keychain: judgeKeychain,
      judge,
      off: opts.judgeOff === true,
    }),
    shape: createShapeServices({ shape, state, clock }),
    thread: createThreadService({
      state,
      dataDir: opts.dataDir,
      pages: {
        deliver: (taskId, messageId, how) => createdRunner.deliverMessage(taskId, messageId, how),
      },
    }),
    knowledge: createKnowledgeServices({
      state,
      searchAvailable: knowledgeIndex.failed.length === 0,
    }),
    starter,
    openPass: (input) => openPass(delivery, input, passOpenDeps),
    takeOut: (input) => takeOut(passTakeOuts, input),
    abandonPass: (passId) => startAbandon(passAbandons, passId),
    passPullRequests,
    closes: passCloses,
    signOff: (passId, taskId) => askSignOff(passTakeOuts, passId, taskId),
    cancelSignOff: (passId, taskId) => {
      cancelSignOffWait(passTakeOuts, passId, taskId);
    },
    shipper,
    accounts: accountService,
    worktreeRoot,
    git,
    branchOnOrigin: (repoPath, branch) =>
      git.branchOnOrigin(repoPath, branch, {
        env: delivery.networkEnv(),
        timeoutMs: delivery.limits.networkTimeoutMs,
      }),
    protectedRoots: [opts.dataDir, ...allSandboxRoots, worktreeRoot],
    areaNamer,
    hazards: hazardAssessor,
    pinCheckout: (repoPath) => {
      // A checkout git can't read yet is recorded at the first git call that succeeds there.
      git.gitDirs(repoPath).catch(() => undefined);
    },
  });
  const build = opts.build ?? null;
  let selfUpdate: SelfUpdate | null = null;
  // What an update waits for, as counts. A queued ship, checkout return or cleanup is a delivery job
  // before it is a row. A lane or gate parked by the drain has begun nothing: it is not cut off by
  // the quit (the stop leaves its saved action for recovery), and counting it would keep the drain
  // going for ever. A shaping conversation with a turn under way counts: it is no workstream, and
  // the quit would cut off the answer in front of the builder. The drain and the install's hold park
  // a turn that has not started (it waits in one of them, so `parked()` takes it off the count, and
  // the quit tells the builder it went unanswered); one running finishes. A lane waiting on a card counts until the drain begins and not after: it runs nothing, the quit ends
  // its session and recovery parks it on its card again, so it must not hold the install, and every
  // lane behind it, for as long as the builder leaves the card.
  // `shapes`, `batches` and `jobs` are the kinds of work among `working` that are no lane or gate, so
  // a drain only they hold can say where to look instead of naming a running step the Board lacks.
  const midSessionWaits = (): {
    working: number;
    waitingOnCard: number;
    batches: number;
    jobs: number;
    shapes: { id: ShapeId; title: string }[];
  } => {
    const waitingOnCard = countWaitingOnCard(state.db);
    const working = Math.max(
      0,
      midSessionWork(state.db, deliveryJobs, shape, { waitingOnCard: false }) -
        updateDrain.parked() -
        installHold.parked(),
    );
    return {
      working,
      waitingOnCard,
      batches: countBatchesInFlight(state.db),
      jobs: deliveryJobs.pending(),
      shapes: shape.runningTurns(),
    };
  };
  const midSessionCount = (): number => {
    const { working, waitingOnCard } = midSessionWaits();
    return updateDrain.draining ? working : working + waitingOnCard;
  };
  // Only a bundle in Applications that knows the repository it was built for follows it; a project,
  // its checkout and its origin have no say in where an update comes from.
  const updateRepository = build?.updatable === true ? build.repository : null;
  if (build !== null && updateRepository !== null) {
    const updateLogger = logger.child({ component: 'self-update' });
    const installer =
      opts.selfUpdate?.installer ??
      (ghBin === null
        ? null
        : createScriptInstaller({
            releaseDir: build.releaseDir,
            workDir: join(opts.dataDir, 'self-update'),
            dataDir: opts.dataDir,
            gh: ghBin,
            env: () => delivery.networkEnv(),
            logger: updateLogger,
          }));
    if (installer === null) {
      updateLogger.warn({}, 'gh is not installed, so the app cannot update itself');
    } else {
      const ghExec = createSystemGhExec({ gh: ghBin, git: gitBin });
      const ghCall = () => ({
        env: delivery.networkEnv(),
        timeoutMs: delivery.limits.networkTimeoutMs,
      });
      selfUpdate = createSelfUpdate({
        state,
        inbox,
        clock,
        logger: updateLogger,
        runningCommit: build.commit,
        intervalMs: opts.selfUpdate?.intervalMs ?? DEFAULTS.selfUpdateIntervalMs,
        repository: updateRepository,
        enabled: () => selfUpdateSetting(state.db).enabled,
        // A card only needs a project to sit under in the Inbox.
        cardProject: () => listProjects(state.db)[0]?.id ?? null,
        headOf: opts.selfUpdate?.headOf ?? githubHeadOfMain(ghExec, ghCall),
        isAhead: opts.selfUpdate?.isAhead ?? githubMainIsAhead(ghExec, ghCall),
        stage: (target, running, skip, keep) => installer.stage(target, running, skip, keep),
        stopStage: () => installer.stop(),
        cancelStage: () => installer.cancel(),
        apply: (staged) => installer.apply(staged),
        outcome: installer.outcome,
        rollback: installer.rollback,
        midSession: midSessionCount,
        shapeTurns: () => shape.runningTurns(),
        waitLimitMs: () => selfUpdateWaitMinutes(state.db) * 60_000,
        drain: {
          begin: (since) => {
            updateDrain.begin(since);
          },
          end: () => {
            updateDrain.end();
            // Lanes start again, and a batch whose work finished while new ships were held ships.
            createdScheduler.requestTick();
            shipper.checkOpenBatches();
          },
        },
        // New work waits from here on, and the tick the scheduler is in has finished: it may be
        // reading branches and about to launch a lane.
        pause: async () => {
          installHold.begin(clock.now());
          createdScheduler.stop();
          await createdScheduler.idle();
        },
        resume: () => {
          installHold.end();
          createdScheduler.start();
          createdScheduler.requestTick();
        },
      });
    }
  }
  // What this install can never do, known now; a test's own installer needs no gh.
  const cannotUpdateAtAll = cannotUpdate(
    build,
    ghBin !== null || opts.selfUpdate?.installer != null,
  );
  const selfUpdateServices: SelfUpdateServices = {
    selfUpdateStatus: () => {
      const progress = selfUpdate?.status();
      return {
        blocker: cannotUpdateAtAll ?? progress?.problem ?? null,
        ...selfUpdateSetting(state.db),
        runningCommit: build?.commit ?? null,
        availableCommit: progress?.availableCommit ?? null,
        notInstalling: progress?.notInstalling ?? null,
        waitMinutes: selfUpdateWaitMinutes(state.db),
        waitingSince: progress?.waitingSince?.toISOString() ?? null,
        draining: progress?.draining ?? false,
        drainingSince: progress?.drainingSince?.toISOString() ?? null,
        midSession: midSessionWaits(),
      };
    },
    setSelfUpdateWait: (minutes) => {
      setSelfUpdateWaitMinutes(state, minutes);
      return selfUpdateServices.selfUpdateStatus();
    },
    installNow: () => {
      selfUpdate?.installNow();
      return selfUpdateServices.selfUpdateStatus();
    },
    setSelfUpdate: (enabled) => {
      setSelfUpdateChoice(state, enabled);
      // A head of main whose update failed, or the build make rollback-app replaced, is tried again
      // once the builder touches the switch.
      selfUpdate?.retry();
      // Off means nothing installs: a stage under way is killed, and a check under way sees the
      // switch before it installs.
      if (!enabled) {
        selfUpdate?.turnOff().catch((error: unknown) => {
          logger.warn({ err: error }, 'could not stop the self-update’s stage');
        });
      }
      return selfUpdateServices.selfUpdateStatus();
    },
  };
  const app = createApp({
    commit: build?.commit ?? null,
    selfUpdate: selfUpdateServices,
    startedAt,
    allowedOrigins: [
      ...(opts.allowedOrigins ?? UI_ORIGINS),
      ...(opts.devUiOrigin ? [opts.devUiOrigin] : []),
    ],
    token,
    services,
    taskRemoval: services,
    builderMcp: createBuilderMcpHandler({ services, log: logger }),
    screens: {
      claim: (signal) => screenBroker.claim(signal),
      deliver: (id, image) => screenBroker.deliver(id, image),
      refuse: (id, reason) => screenBroker.refuse(id, reason),
      tokenValid: (token) => screenBroker.tokenValid(token),
      mayRead: renderMayRead,
      image: (shapeId, name) => screens.image(shapeId, name),
    },
    upgradeWebSocket,
    onUnexpectedError: (error) => {
      logger.error({ err: error }, 'unhandled API error');
    },
    mcp: createMcpHandler({
      protectedPaths: guarded,
      state,
      inbox,
      git,
      log: logger,
      waitObserverFor: (id) => live.get(id)?.observer,
      sessionSignal: (id) => live.get(id)?.signal,
      askedToHandOff: (id) => live.get(id)?.askedToHandOff(),
      claimWaits,
      deliverMessage: (taskId, messageId) =>
        createdRunner.deliverMessage(taskId, messageId, { redo: false }),
      migrationsBase,
      dependencyChanges,
      shapeTools: shape.toolsFor,
    }),
  });
  const wss = new WebSocketServer({ noServer: true });
  const server = serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: opts.port,
    // ws declares `options.noServer?: boolean`, which WebSocketServerLike rejects under
    // exactOptionalPropertyTypes; the runtime shape is what @hono/node-server expects.
    websocket: { server: wss as WebSocketServerLike },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  // A server listening on a TCP port reports an AddressInfo.
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${String(port)}`;
  mcpUrl = `${url}/mcp`;
  writeRuntimeFiles(
    opts.dataDir,
    {
      pid: process.pid,
      port,
      protocolVersion: PROTOCOL_VERSION,
      startedAt: startedAt.toISOString(),
    },
    token,
  );
  // Once the daemon listens, off the event loop, which a lane can fill with names; `stop()` ends it.
  const systemTempAbort = new AbortController();
  const systemTempSwept = (
    sandboxRoots === null
      ? Promise.resolve()
      : sweepSystemTempDirs(sandboxRoots.systemTemps, systemTempAbort.signal).then((report) => {
          logSweep(report, "10db's temp dirs");
        })
  ).catch((error: unknown) => {
    logger.warn({ err: error }, "could not sweep 10db's temp dirs from the system temp dirs");
  });

  const nightly = scheduleNightlyBackup(
    clock,
    async () => {
      await backupDatabase(db, backupsDir, 'nightly', clock.now());
      pruneBackups(backupsDir, 'nightly', DEFAULTS.nightlyBackupsKept);
    },
    DEFAULTS.nightlyBackupHour,
    (error) => {
      logger.error({ err: error }, 'nightly backup failed');
    },
  );
  // How an install that was under way ended is reported before the scheduler can start anything.
  selfUpdate?.settle();
  createdScheduler.start();
  createdScheduler.requestTick();
  loadGuard.start();
  prWatch.start();
  if (selfUpdate) {
    selfUpdate.start();
    selfUpdate.tick().catch((error: unknown) => {
      logger.error({ err: error }, 'the first self-update check failed');
    });
  }
  logger.info({ port, dataDir: opts.dataDir }, 'daemon started');

  async function shutdown(): Promise<void> {
    try {
      // First: a check that is holding the scheduler back would otherwise start it again while the
      // rest of this shutdown runs. Its flags are set at the call; what it settles on is a stage
      // under way, killed with the gh it started, which is awaited beside the delivery jobs.
      const selfUpdateStopped = (selfUpdate?.stop() ?? Promise.resolve()).catch(
        (error: unknown) => {
          logger.warn({ err: error }, 'could not stop the self-update’s stage');
        },
      );
      createdScheduler.stop();
      // A sign-in's agent is a child of ours: it is told to end now, in step with the lanes, and awaited
      // before the database closes, so a slow stop does not eat the window the lanes need.
      const loginStopped = accountService.stop().catch((error: unknown) => {
        logger.warn({ err: error }, 'could not stop the sign-in');
      });
      unsubscribeShip();
      unsubscribePassSettles();
      unsubscribeSignOffWaits();
      unsubscribeMergedPasses();
      unsubscribeKeptWork();
      unsubscribePrWatch();
      await prWatch.stop();
      retiredLandingsAbort.abort();
      await retiredLandings;
      systemTempAbort.abort();
      await systemTempSwept;
      backupsAbort.abort();
      await rootsKeptOutOfBackups;
      // A pass's gate and review on its pushed tip run outside the delivery jobs.
      await passPullRequests.stop();
      // A gate that waits must not start because shutdown freed the slot of the one it killed.
      gateSlots.close();
      // Aborts a shipping gate and any git or gh child; the batch stays SHIPPING for recovery.
      await Promise.all([deliveryJobs.stop(), selfUpdateStopped]);
      benchmarks.stop();
      catalogue.stop();
      await listRefresh.stop();
      accountPauses.stop();
      moveBack.stop();
      nightly.cancel();
      unsubscribeLanes();
      unsubscribeYields();
      unsubscribeHazards();
      hazardAssessor.stop();
      watcher?.stop();
      keepAwake.stop();
      // A probe in flight writes to the database; the runner can ask for another while it stops.
      await preparer.idle();
      await shape.close();
      await createdRunner.stopAll('shutdown');
      // After the runner: a lane or gate held for load ends on its own stop, and nothing samples again.
      loadGuard.stop();
      updateDrain.stop();
      installHold.stop();
      // After the runner too: what its sessions could not stop stays for the next start.
      ledgerSweep?.stop();
      await preparer.idle();
      await loginStopped;
      state.write((ctx) => {
        setAppSetting(ctx, CLEAN_SHUTDOWN_KEY, { at: ctx.now });
      });
      // Neither wss.close() nor server.close() ends sockets that are already open, so a connected
      // UI client would keep stop() waiting forever.
      for (const client of wss.clients) client.terminate();
      wss.close();
      // Only the HTTP/1 server can drop keep-alive sockets; serve() returns it here.
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      removeRuntimeFiles(opts.dataDir);
      claimedRoots?.release();
      db.$client.close();
      lock.release();
    } finally {
      await closeLog();
    }
  }
  // SIGINT then SIGTERM both call stop(); a second shutdown would write to the closed database.
  let stopping: Promise<void> | null = null;

  return {
    url,
    port,
    mcpUrl,
    token,
    state,
    runner: createdRunner,
    scheduler: createdScheduler,
    benchmarks,
    refreshModels,
    judge,
    stop() {
      stopping ??= shutdown();
      return stopping;
    },
  };
}
