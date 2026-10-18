import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve, upgradeWebSocket, type WebSocketServerLike } from '@hono/node-server';
import {
  EventType,
  PROTOCOL_VERSION,
  type ProjectDto,
  type SystemCheckDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  createStore,
  DB_MIGRATIONS_DIR,
  deleteAppSetting,
  getAppSetting,
  migrateDatabase,
  openDatabase,
  setAppSetting,
} from '@10db/db';
import { HARNESS_PLUGIN_DIR, readDefaultPersonas } from '@10db/harness';
import { WebSocketServer } from 'ws';
import { createApp } from '../api';
import {
  backupDatabase,
  hasPendingMigrations,
  pruneBackups,
  scheduleNightlyBackup,
} from '../backups';
import { systemClock, type Clock } from '../clock';
import type { LogLevel } from '../env';
import { REQUIRED_TOOLS } from '../environment';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { createInboxService } from '../inbox';
import { createKeepAwake, systemCaffeinate, type CaffeinateSpawner } from '../keep-awake';
import { createLogger, fileDestination, rotateLogFile, type Logger } from '../log';
import { createMcpHandler } from '../mcp';
import { recoverOnStartup, systemProcesses, type ProcessTerminator } from '../recovery';
import {
  createLiveSessions,
  createRunner,
  DEFAULT_RUNNER_LIMITS,
  type Runner,
  type RunnerLimits,
} from '../runner';
import { createProviderPauses, createScheduler, type Scheduler } from '../scheduler';
import type { SessionAdapter } from '../sessions';
import { seedTeam } from '../team';
import { createGateRunner } from '../verify';
import { createWatcher, systemWatch, type WatchFn } from '../watcher';
import { acquireInstanceLock } from './instance-lock';
import { removeRuntimeFiles, writeRuntimeFiles } from './runtime-files';
import { createServices } from './services';

export interface DaemonOptions {
  readonly dataDir: string;
  readonly port: number;
  /** An adapter, or a factory that gets the daemon's logger (the Claude adapter logs into daemon.log). */
  readonly adapter: SessionAdapter | ((logger: Logger) => SessionAdapter);
  readonly logLevel: LogLevel;
  /** better_sqlite3.node for bundled runs; source runs leave it unset. */
  readonly sqliteBinding?: string;
  readonly clock?: Clock;
  /** Lane caps across all projects and per provider. */
  readonly caps?: { readonly global: number; readonly perProvider: number };
  /** Recovery attempts, fix attempts and the gate timeout; merged over the runner defaults. */
  readonly limits?: Partial<RunnerLimits>;
  /** How long a lane lease lasts before the scheduler renews it. */
  readonly leaseMs?: number;
  /** How often the scheduler looks for work when nothing asks it to. */
  readonly tickMs?: number;
  /** How long a provider stays paused when its usage limit gives no reset time. */
  readonly defaultPauseMs?: number;
  readonly sessionEnv?: (project: ProjectDto) => Readonly<Record<string, string>>;
  readonly processes?: ProcessTerminator;
  readonly migrationsDir?: string;
  /** The harness plugin folder the default personas are read from. */
  readonly harnessDir?: string;
  readonly allowedOrigins?: readonly string[];
  /** A fixed UI token (dev and Playwright); otherwise a random one per start. */
  readonly uiToken?: string;
  readonly caffeinate?: CaffeinateSpawner;
  readonly systemCheck?: () => Promise<SystemCheckDto>;
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
  stop(): Promise<void>;
}

const UI_ORIGINS = [
  'http://localhost:1420',
  'tauri://localhost',
  'http://tauri.localhost',
] as const;
/** Written by stop() after every runner has stopped; its absence at start means the last run crashed. */
const CLEAN_SHUTDOWN_KEY = 'daemon.clean_shutdown';

/** The session env when none is wired (tests): enough PATH for a gate to find git and test. */
const DEFAULT_SESSION_PATH = '/usr/bin:/bin';

const DEFAULTS = {
  caps: { global: 4, perProvider: 4 },
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
    tools: REQUIRED_TOOLS.map((t) => ({
      name: t.name,
      path: null,
      version: null,
      required: t.required,
    })),
  });
}

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
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

  const bus = createEventBus((error) => {
    logger.error({ err: error }, 'event listener failed');
  });
  const state = createStateStore(
    createStore(db, () => clock.now()),
    bus,
  );
  // A malformed persona file throws and the daemon doesn't start, the same policy as a failed migration.
  seedTeam(state, readDefaultPersonas(opts.harnessDir ?? HARNESS_PLUGIN_DIR));
  const instanceId = randomUUID();
  const git = createGit();
  const live = createLiveSessions();
  const limits: RunnerLimits = { ...DEFAULT_RUNNER_LIMITS, ...opts.limits };
  const processes = opts.processes ?? systemProcesses;
  let mcpUrl = '';
  // The inbox, pauses and runner call into each other, so each reaches the others through these
  // references; they are set before anything can fire a callback.
  let runner: Runner | null = null;
  let scheduler: Scheduler | null = null;

  const inbox = createInboxService({
    state,
    onParkedAnswer: (target, item) => {
      runner?.deliverParkedAnswer(target, item);
    },
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
  const pauses = createProviderPauses({
    state,
    clock,
    inbox,
    stopProvider: (provider) => runner?.stopProvider(provider, 'paused') ?? Promise.resolve(),
    onResume: () => {
      scheduler?.requestTick();
    },
    defaultPauseMs: opts.defaultPauseMs ?? DEFAULTS.defaultPauseMs,
  });
  const createdRunner = createRunner({
    state,
    adapter,
    inbox,
    git,
    gate: createGateRunner(),
    clock,
    logger,
    dataDir: opts.dataDir,
    live,
    limits,
    mcpUrl: () => mcpUrl,
    sessionEnv: opts.sessionEnv ?? (() => ({ PATH: DEFAULT_SESSION_PATH })),
    onRateLimited: (provider, resetsAt, projectId) => {
      pauses.pause(provider, resetsAt, projectId);
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
    pauses,
    clock,
    instanceId,
    logger,
    caps: opts.caps ?? DEFAULTS.caps,
    leaseMs: opts.leaseMs ?? DEFAULTS.leaseMs,
    tickMs: opts.tickMs ?? DEFAULTS.tickMs,
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
  pauses.restore();

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
  const app = createApp({
    startedAt,
    allowedOrigins: opts.allowedOrigins ?? UI_ORIGINS,
    token,
    services: createServices({
      state,
      bus,
      runner: createdRunner,
      scheduler: createdScheduler,
      inbox,
      keepAwake,
      systemCheck: opts.systemCheck ?? noSystemCheck,
    }),
    upgradeWebSocket,
    onUnexpectedError: (error) => {
      logger.error({ err: error }, 'unhandled API error');
    },
    mcp: createMcpHandler({
      state,
      inbox,
      git,
      log: logger,
      waitObserverFor: (id) => live.get(id)?.observer,
      sessionSignal: (id) => live.get(id)?.signal,
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
      pauses.stop();
      nightly.cancel();
      unsubscribeLanes();
      watcher?.stop();
      keepAwake.stop();
      await createdRunner.stopAll('shutdown');
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
    stop() {
      stopping ??= shutdown();
      return stopping;
    },
  };
}
