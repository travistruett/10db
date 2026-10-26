import { ToolName, type SystemCheckDto } from '@10db/contracts';
import { SchemaMismatchError } from '@10db/db';
import { AlreadyRunningError, startDaemon } from './daemon';
import { loadEnv } from './env';
import {
  AA_KEY_ACCOUNT,
  buildNetworkEnv,
  captureLoginEnv,
  systemCheck,
  systemKeychain,
  type LoginEnv,
} from './environment';
import type { Logger } from './log';
import {
  resolveDataDir,
  resolveHarnessDir,
  resolveMigrationsDir,
  resolveSqliteBinding,
} from './paths';
import {
  createClaudeAdapter,
  createUnavailableAdapter,
  FakeAdapter,
  loadFakeScriptBook,
  type SessionAdapter,
} from './sessions';

// An unhandled error exits loudly; the supervisor restarts the daemon and recovery runs at startup.
process.on('unhandledRejection', (error) => {
  console.error('10db daemon: unhandled rejection', error);
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  console.error('10db daemon: uncaught exception', error);
  process.exit(1);
});

const CLAUDE_MISSING =
  'Claude Code was not found on your login PATH. Install it, then restart 10db.';

const env = loadEnv(process.env);
const dataDir = resolveDataDir(env);

// A GUI-launched sidecar inherits a bare PATH; the login shell has the builder's real one. It lives
// only in memory because it can hold secrets. Fake sessions (tests, the E2E, UI work) run no real
// tools, so they keep the inherited environment and never run the builder's shell profile.
const login: LoginEnv = env.TENDB_FAKE_SCRIPTS
  ? {
      vars: Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
      ),
      source: 'inherited',
      warning: null,
    }
  : await captureLoginEnv({ inherited: process.env });
if (login.warning) console.warn(`10db daemon: ${login.warning}`);

let checked: Promise<SystemCheckDto> | null = null;
const check = (): Promise<SystemCheckDto> => (checked ??= systemCheck(login));

async function chooseAdapter(): Promise<SessionAdapter | ((logger: Logger) => SessionAdapter)> {
  if (env.TENDB_FAKE_SCRIPTS) return new FakeAdapter(loadFakeScriptBook(env.TENDB_FAKE_SCRIPTS));
  const claudePath =
    env.TENDB_CLAUDE_PATH ??
    (await check()).tools.find((t) => t.name === ToolName.Claude)?.path ??
    null;
  if (!claudePath) return createUnavailableAdapter(CLAUDE_MISSING);
  // Through the daemon's own logger: one shared daemon.log, which the live acceptance checks read.
  return (logger) =>
    createClaudeAdapter({
      claudePath,
      pluginDir: resolveHarnessDir(),
      permissionMode: env.TENDB_LANE_PERMISSION_MODE,
      logger: logger.child({ component: 'claude' }),
    });
}

try {
  const sqliteBinding = resolveSqliteBinding(env);
  const daemon = await startDaemon({
    dataDir,
    port: env.TENDB_PORT,
    adapter: await chooseAdapter(),
    logLevel: env.TENDB_LOG_LEVEL,
    migrationsDir: resolveMigrationsDir(),
    harnessDir: resolveHarnessDir(),
    aaKey: () => systemKeychain.read(AA_KEY_ACCOUNT),
    loginEnv: login.vars,
    keychain: systemKeychain,
    systemCheck: check,
    networkEnv: () => buildNetworkEnv(login.vars),
    ...(env.TENDB_DEV_UI_TOKEN ? { uiToken: env.TENDB_DEV_UI_TOKEN } : {}),
    ...(env.TENDB_DEV_UI_ORIGIN ? { devUiOrigin: env.TENDB_DEV_UI_ORIGIN } : {}),
    ...(sqliteBinding ? { sqliteBinding } : {}),
  });
  console.log(`10db daemon listening on ${daemon.url} (data: ${dataDir})`);
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void daemon.stop().then(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  // The shell holds our stdin open; EOF means it is gone, so stop as if told to.
  if (env.TENDB_PARENT_STDIN === '1') {
    process.stdin.once('end', shutdown);
    process.stdin.resume();
  }
} catch (error) {
  if (error instanceof AlreadyRunningError) {
    console.error(error.message);
    process.exit(2);
  }
  // The shell's supervisor stops on 3 instead of restarting into the same refusal.
  if (error instanceof SchemaMismatchError) {
    console.error(error.message);
    process.exit(3);
  }
  throw error;
}
