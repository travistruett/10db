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
  AgentState,
  AgentTool,
  captureLoginEnv,
  pinnedToolsRoot,
  probeVersion,
  startPinnedTools,
  systemCheck,
  systemKeychain,
  type LoginEnv,
  type GhLoginProbe,
  type ResolvedTools,
  type RunningAgentTools,
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
  claudeCapabilities,
  codexCapabilities,
  codexLoginStatus,
  createClaudeAdapter,
  createCodexAdapter,
  createPinnedAdapter,
  createRoutedAdapter,
  FakeAdapter,
  loadFakeScriptBook,
  scriptedShapeBehaviour,
  type AdapterSource,
  type AgentAdapter,
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

// Real sessions run the pinned copies of Claude Code and Codex, fetched into the data dir and checked
// against the recorded checksums; the builder's own installs are never run. Fake sessions run neither.
const agents: RunningAgentTools | null = env.TENDB_FAKE_SCRIPTS
  ? null
  : startPinnedTools({
      dataDir,
      probe: probeVersion,
      ...(env.TENDB_CLAUDE_PATH ? { overrides: { claude: env.TENDB_CLAUDE_PATH } } : {}),
    });

/** What an agent's adapter runs on, or why it can't start a session yet. */
function sourceOf(tool: AgentTool): AdapterSource {
  const status = agents?.statuses().find((s) => s.tool === tool);
  if (status?.state === AgentState.Ready && status.path !== null)
    return { ready: true, path: status.path };
  if (status?.state === AgentState.Refused)
    return {
      ready: false,
      message: `${status.problem ?? `${status.label} ${status.pinned} was refused`}. No session runs on it; Recheck in the setup check or the system alert removes the copy under ${pinnedToolsRoot(dataDir)} and fetches it again.`,
    };
  return {
    ready: false,
    message: `${status?.label ?? tool} ${status?.pinned ?? ''} is still being downloaded and checked; sessions start once it is ready.`,
  };
}

function chooseAdapter(): AgentAdapter | ((logger: Logger) => AgentAdapter) {
  if (env.TENDB_FAKE_SCRIPTS) {
    const fake = new FakeAdapter(loadFakeScriptBook(env.TENDB_FAKE_SCRIPTS));
    // A Shape conversation on the fake answers deterministically, so the e2e can drive it.
    fake.shapeBehaviour = scriptedShapeBehaviour();
    return fake;
  }
  // Through the daemon's own logger: one shared daemon.log, which the live acceptance checks read.
  return (logger) =>
    createRoutedAdapter({
      claude: createPinnedAdapter(
        () => sourceOf(AgentTool.Claude),
        (claudePath) =>
          createClaudeAdapter({
            claudePath,
            pluginDir: resolveHarnessDir(),
            logger: logger.child({ component: 'claude' }),
          }),
        (account) => claudeCapabilities(account.kind),
      ),
      codex: createPinnedAdapter(
        () => sourceOf(AgentTool.Codex),
        (codexPath) =>
          createCodexAdapter({
            codexPath,
            logger: logger.child({ component: 'codex' }),
            signInCheck: (sessionEnv) => codexLoginStatus(codexPath, sessionEnv),
          }),
        (account) => codexCapabilities(account.kind),
      ),
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
    ...(agents ? { agents } : {}),
    networkEnv: () => buildNetworkEnv(login.vars),
    ...(sqliteBinding ? { sqliteBinding } : {}),
  });
  console.log(`10db daemon listening on ${daemon.url} (data: ${dataDir})`);
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    agents?.stop();
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
