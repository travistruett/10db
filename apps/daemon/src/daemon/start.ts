import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { serve, upgradeWebSocket, type WebSocketServerLike } from '@hono/node-server';
import {
  EventType,
  PROTOCOL_VERSION,
  type InboxAnswer,
  type InboxItemDto,
  type SystemCheckDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  createStore,
  DB_MIGRATIONS_DIR,
  deleteAppSetting,
  getAppSetting,
  listPermissionRules,
  listProjects,
  migrateDatabase,
  openDatabase,
  patchAccount,
  seedDefaultAccount,
  setAppSetting,
} from '@10db/db';
import { HARNESS_PLUGIN_DIR, readDefaultPersonas } from '@10db/harness';
import { WebSocketServer } from 'ws';
import {
  createAccountCardAnswers,
  createAccountLimits,
  createAccountMoves,
  createAccountPauses,
  createAccountPreparer,
  createAccountRuntime,
  createAccountService,
  createMoveBack,
  createStartGate,
  createUsageReports,
  type AccountLimits,
} from '../accounts';
import { createApp } from '../api';
import { createBenchmarkSync, type BenchmarkSync } from '../benchmarks';
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
  createBatchCardAnswers,
  createBatchStarter,
  createDeliveryJobs,
  createShipper,
  createWorktreeDependencies,
  DEFAULT_DELIVERY_LIMITS,
  flagWorktreeMissing,
  flagWrongBranch,
  recoverBatches,
  resolvePnpm,
  subscribeShipTrigger,
  type DeliveryContext,
  type DeliveryLimits,
} from '../delivery';
import type { LogLevel } from '../env';
import {
  ACCOUNT_NAMES_VERIFIED_ON,
  createLauncher,
  REQUIRED_TOOLS,
  unavailableKeychain,
  type Keychain,
  type GhLoginProbe,
  type ResolvedTools,
} from '../environment';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit, memoryPinStore, resolveGit } from '../git';
import { createGh, createSystemGhExec, resolveGh, type Gh } from '../github';
import { createInboxService } from '../inbox';
import { createKeepAwake, systemCaffeinate, type CaffeinateSpawner } from '../keep-awake';
import { createLogger, fileDestination, rotateLogFile, type Logger } from '../log';
import { protectedPaths } from '../guard';
import { ClaimWaits, createMcpHandler, withdrawStaleClaimWaits } from '../mcp';
import { recoverOnStartup, systemProcesses, type ProcessTerminator } from '../recovery';
import {
  applyCheckAnswer,
  RunnerNotStartedError,
  createLiveSessions,
  createRunner,
  DEFAULT_RUNNER_LIMITS,
  type Runner,
  type RunnerLimits,
} from '../runner';
import { resolveSandboxRuntime } from '../paths';
import {
  claimSandboxTempRoot,
  createGateSandbox,
  createLaneSandbox,
  LANE_TEMP_ROOT,
  type SandboxRuntime,
} from '../sandbox';
import { createScheduler, type Scheduler } from '../scheduler';
import type { SessionAdapter } from '../sessions';
import { retryWorkstream, seedTeam } from '../team';
import { createGateRunner, createGateSlots, limitGates } from '../verify';
import { CLIENT_APP } from '../version';
import { createWatcher, systemWatch, type WatchFn } from '../watcher';
import { createProjectPinStore } from './checkout-pins';
import { createGitCardAnswers, createGitRefusalHandler } from './git-refusal';
import { acquireInstanceLock } from './instance-lock';
import { removeRuntimeFiles, writeRuntimeFiles } from './runtime-files';
import { createServices } from './services';
import { assertWorktreeRootAllowed, DEFAULT_WORKTREE_BASE, worktreeRootFor } from './worktree-root';

export interface DaemonOptions {
  readonly dataDir: string;
  readonly port: number;
  /** An adapter, or a factory that gets the daemon's logger (the Claude adapter logs into daemon.log). */
  readonly adapter: SessionAdapter | ((logger: Logger) => SessionAdapter);
  readonly logLevel: LogLevel;
  /**
   * The sandbox every lane and every gate runs under; `tmpRoot` (tests) moves its temp dirs off
   * `/private/tmp`, and `runtime` (tests) replaces srt, which runs the gate. Required, so no caller
   * can forget it: null runs lanes and gates unsandboxed, which only fake sessions and tests ask
   * for, and the Claude adapter refuses such a session.
   */
  readonly sandbox: { readonly tmpRoot?: string; readonly runtime?: SandboxRuntime } | null;
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
  /** `false` turns the file watcher off (tests that don't need it). */
  readonly watch?: WatchFn | false;
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
  stop(): Promise<void>;
}

/** The Tauri webview's origins. A browser origin, such as a Vite dev UI, is opted in by `devUiOrigin`. */
const UI_ORIGINS = ['tauri://localhost', 'http://tauri.localhost'] as const;
/** Written by stop() after every runner has stopped; its absence at start means the last run crashed. */
const CLEAN_SHUTDOWN_KEY = 'daemon.clean_shutdown';

/** The session env when none is wired (tests): enough PATH for a gate to find git and test. */
const DEFAULT_SESSION_PATH = '/usr/bin:/bin';

const DEFAULTS = {
  caps: { global: 4 },
  leaseMs: 60_000,
  tickMs: 2_000,
  defaultPauseMs: 30 * 60_000,
  nightlyBackupHour: 3,
  nightlyBackupsKept: 7,
} as const;

/** Used when no system check is wired (tests): every tool reads as not found. */
function noSystemCheck(): Promise<SystemCheckDto> {
  return Promise.resolve({
    loginEnv: { source: 'inherited', warning: 'The login environment was not captured' },
    claudeCode: { verifiedOn: ACCOUNT_NAMES_VERIFIED_ON, warning: null },
    tools: REQUIRED_TOOLS.map((t) => ({
      name: t.name,
      path: null,
      version: null,
      required: t.required,
      signedIn: null,
    })),
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

  // Where this daemon's worktrees live, as a real path. A root that could hold lane-written files or
  // the daemon's own is refused before anything else starts.
  const sandboxTempRoot = opts.sandbox ? (opts.sandbox.tmpRoot ?? LANE_TEMP_ROOT) : null;
  let worktreeRoot: string;
  try {
    worktreeRoot = worktreeRootFor(opts.worktreeRoot ?? DEFAULT_WORKTREE_BASE, opts.dataDir);
    assertWorktreeRootAllowed(worktreeRoot, {
      checkouts: listProjects(db).map((project) => project.repoPath),
      dataDir: opts.dataDir,
      tempRoot: sandboxTempRoot,
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
  const instanceId = randomUUID();
  const live = createLiveSessions();
  const limits: RunnerLimits = { ...DEFAULT_RUNNER_LIMITS, ...opts.limits };
  const processes = opts.processes ?? systemProcesses;
  let mcpUrl = '';
  // The inbox, pauses and runner call into each other, so each reaches the others through these
  // references; they are set before anything can fire a callback.
  let runner: Runner | null = null;
  let scheduler: Scheduler | null = null;
  // A task that starts waiting for a claim may be waiting on one that needs a lane to finish.
  const claimWaits = new ClaimWaits({
    onWait: () => {
      scheduler?.requestTick();
    },
  });
  let answerBatchCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerAccountCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;
  let answerGitCard: ((item: InboxItemDto, answer: InboxAnswer) => void) | null = null;

  const inbox = createInboxService({
    state,
    onParkedAnswer: (target, item) => {
      runner?.deliverParkedAnswer(target, item);
    },
    onCheckAnswer: (ctx, item, answer) => {
      if (!runner) throw new RunnerNotStartedError();
      return applyCheckAnswer(runner, ctx, item, answer);
    },
    onFlagAnswer: (item, answer) => {
      answerBatchCard?.(item, answer);
      answerAccountCard?.(item, answer);
      answerGitCard?.(item, answer);
    },
  });
  const git = createGit({
    onRefused: createGitRefusalHandler({ db: state.db, inbox, logger }),
    pins: createProjectPinStore(state, memoryPinStore()),
    bin: gitBin,
    checkouts: () => listProjects(state.db).map((project) => project.repoPath),
    // Where sandboxed lanes and gates make their temp dirs. With no sandbox nothing is made there,
    // so nothing lane-written lies in it.
    laneRoots: [...(sandboxTempRoot === null ? [] : [sandboxTempRoot]), worktreeRoot],
    worktreeRoot,
  });
  // srt, which runs every gate and every repo stdio MCP server.
  const runtime = opts.sandbox ? (opts.sandbox.runtime ?? resolveSandboxRuntime()) : null;
  // Before any session or gate starts: what a crashed run left in the temp root is stale.
  const tempRoot = sandboxTempRoot === null ? null : claimSandboxTempRoot(sandboxTempRoot);
  if (tempRoot && (tempRoot.removed > 0 || tempRoot.failed > 0 || tempRoot.sharedWith !== null)) {
    logger.info(
      { removed: tempRoot.removed, failed: tempRoot.failed, sharedWith: tempRoot.sharedWith },
      'swept the sandbox temp root',
    );
  }
  // Shared by every gate: a task's, at its green run, and a batch's, at ship. One limiter caps them
  // all, so the machine never runs more than `limits.gateSlots` at once.
  const gateRunner = createGateRunner({
    sandbox:
      opts.sandbox && runtime
        ? createGateSandbox({
            home: homedir(),
            dataDir: opts.dataDir,
            loginConfigDir: launcher.loginConfigDir(),
            gitDirs: (repo) => git.gitDirs(repo),
            ...(opts.sandbox.tmpRoot === undefined ? {} : { tmpRoot: opts.sandbox.tmpRoot }),
            runtime,
          })
        : null,
    logger: logger.child({ component: 'gate' }),
  });
  const gateSlots = createGateSlots(limits.gateSlots);
  const gate = limitGates(gateRunner, {
    slots: gateSlots,
    clock,
    logger: logger.child({ component: 'gate' }),
  });
  const answerGit = createGitCardAnswers(git);
  answerGitCard = (item, answer) => {
    // A re-trust reads the checkout first; a refusal it meets raises its own card.
    answerGit(item, answer).catch((error: unknown) => {
      logger.error({ err: error }, 'could not re-trust a checkout');
    });
  };
  const deliveryJobs = createDeliveryJobs(logger.child({ component: 'delivery' }));
  const delivery: DeliveryContext = {
    state,
    git,
    gh: opts.gh ?? createGh(createSystemGhExec({ gh: ghBin, git: gitBin })),
    inbox,
    jobs: deliveryJobs,
    logger: logger.child({ component: 'delivery' }),
    limits: {
      ...DEFAULT_DELIVERY_LIMITS,
      gateTimeoutMs: limits.gateTimeoutMs,
      ...opts.deliveryLimits,
    },
    networkEnv: opts.networkEnv ?? (() => ({ PATH: DEFAULT_SESSION_PATH })),
    onWorkQueued: () => {
      scheduler?.requestTick();
    },
    worktreeRoot,
    // Not behind the gate slots: waiting out a long gate would hold the cut. Each cut downloads the
    // worktree's whole tree (the run's store is empty), so several cuts at once are several downloads.
    dependencies: createWorktreeDependencies({
      gate: gateRunner,
      clock,
      dataDir: opts.dataDir,
      sessionEnv: () => launcher.projectEnv(),
      rules: (project) => listPermissionRules(state.db, project.id, null),
      checkouts: () => allCheckouts(state.db),
      timeoutMs: limits.gateTimeoutMs,
      resolvePnpm,
    }),
  };
  const starter = createBatchStarter(delivery);
  // One for the runner and the shipper alike, so a batch's verify and shipping gates run in turn.
  const baseUpdates = createBaseUpdates(delivery);
  const shipper = createShipper({
    ...delivery,
    gate,
    baseUpdates,
    clock,
    dataDir: opts.dataDir,
    sessionEnv: () => launcher.projectEnv(),
    identifyProcess: (pid) => processes.identify(pid),
    isRunning: (id) => runner?.isRunning(id) ?? false,
  });
  answerBatchCard = createBatchCardAnswers({
    retry: (id) => {
      const retried = retryWorkstream(state, id);
      if (retried.batchId !== null) starter.reopen(retried.batchId);
      scheduler?.requestTick();
    },
    shipper,
  });
  const watcher =
    opts.watch === false
      ? null
      : createWatcher({ state, inbox, git, logger, clock, watch: opts.watch ?? systemWatch });
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
  });
  const startGate = createStartGate();
  const preparer = createAccountPreparer({
    state,
    clock,
    inbox,
    adapter,
    launcher,
    startGate,
    dataDir: opts.dataDir,
    logger: logger.child({ component: 'accounts' }),
    onReady: () => {
      scheduler?.requestTick();
    },
  });
  const accountService = createAccountService({
    state,
    clock,
    dataDir: opts.dataDir,
    keychain: opts.keychain ?? unavailableKeychain,
    launcher,
    adapter,
    startGate,
    runtime: accounts,
    onSaved: () => {
      scheduler?.requestTick();
    },
  });
  // The data directory, and the default account's sign-in wherever the login shell keeps it.
  const guarded = protectedPaths({
    dataDir: opts.dataDir,
    home: homedir(),
    loginConfigDir: launcher.loginConfigDir(),
  });
  const laneSandbox =
    opts.sandbox && runtime
      ? createLaneSandbox({
          home: homedir(),
          dataDir: opts.dataDir,
          loginConfigDir: launcher.loginConfigDir(),
          gitDirs: (repo) => git.gitDirs(repo),
          ...(opts.sandbox.tmpRoot === undefined ? {} : { tmpRoot: opts.sandbox.tmpRoot }),
          runtime,
        })
      : null;
  const createdRunner = createRunner({
    protectedPaths: guarded,
    laneSandbox,
    state,
    adapter,
    inbox,
    git,
    gate,
    baseUpdates,
    clock,
    logger,
    dataDir: opts.dataDir,
    live,
    limits,
    mcpUrl: () => mcpUrl,
    launcher,
    startGate,
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
    },
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
    processes,
    maxRecoveryAttempts: limits.maxRecoveryAttempts,
    logger,
    cleanShutdown,
  });
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
    logger: logger.child({ component: 'delivery' }),
    worktrees: { ctx: delivery, root: worktreeRoot },
  });
  const unsubscribeShip = subscribeShipTrigger(bus, state.db, shipper);

  // Lanes start and stop through workstream events; keep-awake and the watcher follow them.
  const unsubscribeLanes = bus.subscribe((event) => {
    if (event.type === EventType.WorkstreamCreated || event.type === EventType.WorkstreamChanged) {
      keepAwake.refresh();
      watcher?.sync();
    }
  });
  keepAwake.refresh();
  watcher?.sync();

  const token = opts.uiToken ?? randomBytes(32).toString('base64url');
  const services = createServices({
    state,
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
    benchmarks,
    starter,
    shipper,
    accounts: accountService,
    worktreeRoot,
    git,
    protectedRoots: [
      opts.dataDir,
      ...(sandboxTempRoot === null ? [] : [sandboxTempRoot]),
      worktreeRoot,
    ],
    pinCheckout: (repoPath) => {
      // A checkout git can't read yet is recorded at the first git call that succeeds there.
      git.gitDirs(repoPath).catch(() => undefined);
    },
  });
  const app = createApp({
    startedAt,
    allowedOrigins: [
      ...(opts.allowedOrigins ?? UI_ORIGINS),
      ...(opts.devUiOrigin ? [opts.devUiOrigin] : []),
    ],
    token,
    services,
    taskRemoval: services,
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
      claimWaits,
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
  createdScheduler.start();
  createdScheduler.requestTick();
  logger.info({ port, dataDir: opts.dataDir }, 'daemon started');

  async function shutdown(): Promise<void> {
    try {
      createdScheduler.stop();
      unsubscribeShip();
      // A gate that waits must not start because shutdown freed the slot of the one it killed.
      gateSlots.close();
      // Aborts a shipping gate and any git or gh child; the batch stays SHIPPING for recovery.
      await deliveryJobs.stop();
      benchmarks.stop();
      accountPauses.stop();
      moveBack.stop();
      nightly.cancel();
      unsubscribeLanes();
      watcher?.stop();
      keepAwake.stop();
      // A probe in flight writes to the database; the runner can ask for another while it stops.
      await preparer.idle();
      await createdRunner.stopAll('shutdown');
      await preparer.idle();
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
      tempRoot?.release();
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
    stop() {
      stopping ??= shutdown();
      return stopping;
    },
  };
}
