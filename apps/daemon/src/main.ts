import { join } from 'node:path';
import type { SystemCheckDto } from '@10db/contracts';
import { SchemaMismatchError } from '@10db/db';
import { CATALOGUE_SNAPSHOT_FILE } from './catalogue';
import {
  AlreadyRunningError,
  aaKeyReaderFromEnv,
  catalogueSnapshotFromEnv,
  daemonOptionsFromEnv,
  startDaemon,
  WorktreeRootError,
} from './daemon';
import { EnvError, loadEnv, type DaemonEnv } from './env';
import {
  AA_KEY_ACCOUNT,
  buildNetworkEnv,
  captureLoginEnv,
  findClaude,
  findCodex,
  systemCheck,
  systemKeychain,
  type LoginEnv,
  type GhLoginProbe,
  type ResolvedTools,
} from './environment';
import type { Logger } from './log';
import {
  resolveDataDir,
  resolveHarnessDir,
  resolveMigrationsDir,
  resolveSqliteBinding,
} from './paths';
import { readBuildInfo } from './self-update';
import {
  codexLoginStatus,
  createClaudeAdapter,
  createCodexAdapter,
  createRoutedAdapter,
  createUnavailableAdapter,
  FakeAdapter,
  loadFakeScriptBook,
  scriptedShapeBehaviour,
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
  'Claude Code was not found in /opt/homebrew/bin, /usr/local/bin, /usr/bin or ~/.local/bin, where 10db looks for it (never your PATH, where a lane could put one). Install it, or set TENDB_CLAUDE_PATH, then restart 10db.';

const CODEX_MISSING =
  'Codex was not found in /opt/homebrew/bin, /usr/local/bin or /usr/bin, where 10db looks for it (never your PATH, where a lane could put one). Install it, then restart 10db; only a project on a ChatGPT account needs it.';

// The shell's supervisor stops on 4 instead of restarting into configuration a restart can't fix.
const EXIT_REFUSED_CONFIG = 4;

function refuse(error: EnvError | WorktreeRootError): never {
  console.error(error.message);
  process.exit(EXIT_REFUSED_CONFIG);
}

function environment(): DaemonEnv {
  try {
    return loadEnv(process.env);
  } catch (error) {
    if (error instanceof EnvError) refuse(error);
    throw error;
  }
}

const env = environment();
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

// The daemon's services keep the last answer and ask again only on a recheck.
const check = (resolved: ResolvedTools, ghLogin: GhLoginProbe): Promise<SystemCheckDto> =>
  systemCheck(login, resolved, { ghLogin });

function chooseAdapter(): SessionAdapter | ((logger: Logger) => SessionAdapter) {
  if (env.TENDB_FAKE_SCRIPTS) {
    const fake = new FakeAdapter(loadFakeScriptBook(env.TENDB_FAKE_SCRIPTS));
    // A Shape conversation on the fake answers deterministically, so the e2e can drive it.
    fake.shapeBehaviour = scriptedShapeBehaviour();
    return fake;
  }
  const claudePath = env.TENDB_CLAUDE_PATH ?? findClaude();
  const codexPath = findCodex();
  // Through the daemon's own logger: one shared daemon.log, which the live acceptance checks read.
  return (logger) =>
    createRoutedAdapter({
      claude: claudePath
        ? createClaudeAdapter({
            claudePath,
            pluginDir: resolveHarnessDir(),
            logger: logger.child({ component: 'claude' }),
          })
        : createUnavailableAdapter(CLAUDE_MISSING),
      codex: codexPath
        ? createCodexAdapter({
            codexPath,
            logger: logger.child({ component: 'codex' }),
            signInCheck: (sessionEnv) => codexLoginStatus(codexPath, sessionEnv),
          })
        : createUnavailableAdapter(CODEX_MISSING),
    });
}

try {
  const sqliteBinding = resolveSqliteBinding(env);
  // Only a bundle has build-info.json (scripts/build.ts); a run from source shows no commit.
  const build = readBuildInfo(import.meta.dirname);
  const daemon = await startDaemon({
    ...(build ? { build } : {}),
    ...daemonOptionsFromEnv(env),
    dataDir,
    adapter: chooseAdapter(),
    migrationsDir: resolveMigrationsDir(),
    harnessDir: resolveHarnessDir(),
    catalogueSnapshot: catalogueSnapshotFromEnv(
      env,
      join(import.meta.dirname, CATALOGUE_SNAPSHOT_FILE),
    ),
    aaKey: aaKeyReaderFromEnv(env, () => systemKeychain.read(AA_KEY_ACCOUNT)),
    loginEnv: login.vars,
    keychain: systemKeychain,
    systemCheck: check,
    networkEnv: () => buildNetworkEnv(login.vars),
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
  if (error instanceof WorktreeRootError) refuse(error);
  throw error;
}
