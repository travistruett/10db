import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve, upgradeWebSocket, type WebSocketServerLike } from '@hono/node-server';
import { PROTOCOL_VERSION, type ProjectDto } from '@10db/contracts';
import {
  createStore,
  DB_MIGRATIONS_DIR,
  deleteAppSetting,
  getAppSetting,
  migrateDatabase,
  openDatabase,
  setAppSetting,
} from '@10db/db';
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
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { createInboxService } from '../inbox';
import { createLogger, fileDestination, rotateLogFile } from '../log';
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
import { createGateRunner } from '../verify';
import { acquireInstanceLock } from './instance-lock';
import { removeRuntimeFiles, writeRuntimeFiles } from './runtime-files';
import { createServices } from './services';

export interface DaemonOptions {
  readonly dataDir: string;
  readonly port: number;
  readonly adapter: SessionAdapter;
  readonly logLevel: LogLevel;
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
  readonly allowedOrigins?: readonly string[];
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

const DEFAULTS = {
  caps: { global: 4, perProvider: 4 },
  leaseMs: 60_000,
  tickMs: 2_000,
  defaultPauseMs: 30 * 60_000,
  nightlyBackupHour: 3,
  nightlyBackupsKept: 7,
} as const;

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const clock = opts.clock ?? systemClock;
  const startedAt = clock.now();
  mkdirSync(join(opts.dataDir, 'logs'), { recursive: true });
  const lock = acquireInstanceLock(opts.dataDir);
  const logPath = join(opts.dataDir, 'logs', 'daemon.log');
  rotateLogFile(logPath);
  const logger = createLogger({ level: opts.logLevel, destination: fileDestination(logPath) });

  const db = openDatabase(join(opts.dataDir, '10db.sqlite'));
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
    adapter: opts.adapter,
    inbox,
    git,
    gate: createGateRunner(),
    clock,
    logger,
    dataDir: opts.dataDir,
    live,
    limits,
    mcpUrl: () => mcpUrl,
    sessionEnv: opts.sessionEnv ?? (() => ({})),
    onRateLimited: (provider, resetsAt, projectId) => {
      pauses.pause(provider, resetsAt, projectId);
    },
    onLaneFreed: () => {
      scheduler?.requestTick();
    },
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

  const token = randomBytes(32).toString('base64url');
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

  return {
    url,
    port,
    mcpUrl,
    token,
    state,
    runner: createdRunner,
    scheduler: createdScheduler,
    async stop() {
      createdScheduler.stop();
      pauses.stop();
      nightly.cancel();
      await createdRunner.stopAll('shutdown');
      state.write((ctx) => {
        setAppSetting(ctx, CLEAN_SHUTDOWN_KEY, { at: ctx.now });
      });
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      removeRuntimeFiles(opts.dataDir);
      db.$client.close();
      lock.release();
    },
  };
}
