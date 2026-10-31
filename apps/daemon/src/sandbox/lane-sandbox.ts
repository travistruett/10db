import { realpathSync } from 'node:fs';
import type { PermissionRuleDto, ProjectDto } from '@10db/contracts';
import { prepareCommandEnv, withoutTempDirPaths } from './command-env';
import { deniedEnvNames } from './env-allowlist';
import { createLaneEnvFile, removeLaneEnvFile } from './env-file';
import { claudeProtectedPaths, type FileAccessContext } from './file-access';
import {
  sandboxMcpServers,
  type McpSandboxes,
  type McpSandboxFailure,
  type SandboxedMcpServer,
  type StdioMcpServer,
} from './mcp-sandbox';
import { buildLaneProfile, type LaneSandboxSettings } from './profile';
import { projectAccess, type ProjectAccessDeps } from './project-access';
import {
  createLaneProcessWatch,
  createLedgerSweep,
  createProcessLedger,
  LaneProcessFailure,
  removeProcessLedger,
  type LaneProcessWatch,
  type LaneProcessSetup,
  type LedgerSweep,
} from './lane-processes';
import { cachedProcessTable, systemOpenPaths, systemProcessTable } from './process-table';
import { isEqualOrUnder } from './protected-reads';
import type { SandboxRuntime } from './srt-launch';
import { autoModeRules, type AutoModeSettings } from './auto-mode-rules';
import { createLaneTempDir, LANE_TEMP_ROOT, removeAll, removeLaneTempDir } from './temp-dir';

/** What a sandboxed session hands Claude Code on top of its ordinary options. */
export interface LaneSandboxSpec {
  readonly settings: LaneSandboxSettings;
  /** Merged over the session's env. */
  readonly env: Readonly<Record<string, string>>;
  readonly disallowedTools: readonly string[];
  /** Permission rules that make Claude Code ask before the call, whatever the allow rules say. */
  readonly askRules: readonly string[];
  /** The rules Claude Code's auto-mode classifier weighs every call against. */
  readonly autoMode: AutoModeSettings;
}

/** One session's sandbox: its profile, its file-tool context and its temp dir. */
export interface LaneSession {
  readonly spec: LaneSandboxSpec;
  /** A live view: `providerSessionId` follows `setProviderSession`. */
  readonly fileAccess: FileAccessContext;
  readonly tmpDir: string;
  /** Every variable the sandboxed shell has: the session env's, and those it leaves out. */
  readonly commandEnv: Readonly<Record<string, string>>;
  /** The repo's approved stdio servers, each launched under srt in a sandbox of its own. */
  readonly mcpServers: Readonly<Record<string, SandboxedMcpServer>>;
  /** Approved stdio servers left out because their sandbox couldn't be built. */
  readonly mcpFailures: readonly McpSandboxFailure[];
  setProviderSession(id: string): void;
  /**
   * Starts watching the processes under the session's own process, the lane's commands among them.
   * With no start time (`ps` could not read it) the watch reads the process itself, on each sample
   * until it does. Resolves true once it knows the session's process, false while it does not.
   * Never rejects: a machine whose processes can't be read is told of in `endProcesses`.
   */
  trackProcesses(root: {
    readonly pid: number;
    readonly startedAt: string | null;
  }): Promise<boolean>;
  /**
   * Stops every process the session's commands started that still runs, however the session ended.
   * Run it once the lane process is gone and before `dispose`. Rejects when it could not read the
   * machine's processes.
   */
  endProcesses(): Promise<void>;
  /** Removes the temp dirs and files, the servers' too. Run it once the lane process is gone. */
  dispose(): void;
}

export interface LaneSessionInput {
  readonly project: Pick<ProjectDto, 'id' | 'repoPath' | 'sandboxLoopback' | 'gateCommand'>;
  /** The session's launch env, before the sandbox's own is merged over it. */
  readonly env: Readonly<Record<string, string>>;
  /** The project's and the workstream's stored permission rules. */
  readonly rules: readonly Pick<PermissionRuleDto, 'toolName' | 'pattern'>[];
  readonly resumeProviderSessionId: string | null;
  /** The config dir of the account the session runs on, where Claude Code saves its tool results. */
  readonly configDir: string;
  /**
   * Every project's checkout. A lane can write its own, so a PATH entry inside any of them is dropped
   * before the toolchain is read: no lane can change another's profile or refuse its session.
   */
  readonly checkouts: readonly string[];
  /** The repo's approved stdio MCP servers, expanded: each runs under srt, never as written. */
  readonly mcpServers: Readonly<Record<string, StdioMcpServer>>;
}

export interface LaneSandbox {
  forSession(input: LaneSessionInput): Promise<LaneSession>;
}

/** The daemon's logger, as far as the sandbox tells it what it could not do. */
export interface SandboxLog {
  warn(fields: object, message: string): void;
}

export interface LaneSandboxDeps extends Omit<ProjectAccessDeps, 'tmpRoot'> {
  /** Where temp dirs are made; tests pass a short temp root. */
  readonly tmpRoot?: string;
  /** srt, which runs the repo's stdio MCP servers. */
  readonly runtime: SandboxRuntime;
  /** How a session's processes are read and stopped; tests pass fakes. The system's by default. */
  readonly processes?: LaneProcessSetup;
  /**
   * Sweeps again what an ended session's ledger still names when its end could not stop it. The
   * daemon passes the one its start uses for what a dead daemon left; one of its own by default.
   */
  readonly ledgers?: LedgerSweep;
  /** Told, once per kind and session, what the watch of a session's processes could not do. */
  readonly log?: SandboxLog;
}

/** What the log is told when a session's process watch fails, by what it could not do. */
const WATCH_FAILURES: Readonly<Record<LaneProcessFailure, string>> = {
  [LaneProcessFailure.Ledger]:
    'a lane session’s process ledger could not be written, so a daemon that dies now leaves running what the ledger lacks',
  [LaneProcessFailure.Table]:
    'the process table could not be read for a lane session, so what its commands start is not seen until a reading succeeds',
  [LaneProcessFailure.OpenPaths]:
    'the open files of launchd’s children could not be read for a lane session, so a job its command handed off at once may not be found',
};

/** Removes a session's env file and temp dir; see `removeAll`. */
function removeLaneFiles(envFile: string | null, tmpDir: string, tmpRoot: string): void {
  removeAll([
    ...(envFile === null
      ? []
      : [
          () => {
            removeLaneEnvFile(envFile, tmpRoot);
          },
        ]),
    () => {
      removeLaneTempDir(tmpDir, tmpRoot);
    },
  ]);
}

/** `path` with its links resolved, as `lsof` reports a working directory; `path` when it can't be. */
function realPathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Claude Code's spelling of an absolute path in a permission rule: `//` stands for the root. */
const ruleScope = (path: string): string => `/${path}`;

/** Builds each lane session's sandbox: one profile, one temp dir and one file-tool context. */
export function createLaneSandbox(deps: LaneSandboxDeps): LaneSandbox {
  const tmpRoot = deps.tmpRoot ?? LANE_TEMP_ROOT;
  // Every session samples together: one `ps` serves them all.
  const processDeps: LaneProcessSetup = deps.processes ?? {
    table: systemProcessTable,
    sampleTable: cachedProcessTable(systemProcessTable, 500),
    openPaths: systemOpenPaths,
  };
  const ledgers = deps.ledgers ?? createLedgerSweep(tmpRoot, processDeps);
  return {
    async forSession(input) {
      const access = await projectAccess(
        { ...deps, tmpRoot },
        {
          project: input.project,
          env: input.env,
          rules: input.rules,
          configDirs: [input.configDir],
          checkouts: input.checkouts,
        },
      );
      const { checkout, toolchain, readList } = access;
      const protectedList = access.protectedReads;
      const secretFiles = [...access.checkoutSecrets, ...toolchain.secretFiles];
      const tmpDir = createLaneTempDir(tmpRoot);
      let envFile: string | null = null;
      let ledger: string | null = null;
      let mcp: McpSandboxes | null = null;
      try {
        // Outside every lane-writable dir: it names the processes to stop after a daemon restart.
        // Named for this daemon, so a later one leaves it alone while this one runs, and held, so
        // this one's sweep does too until the session is gone.
        ledger = createProcessLedger(tmpRoot, processDeps.ownPid ?? process.pid);
        ledgers.hold(ledger);
        const told = new Set<LaneProcessFailure>();
        // A job a command hands to launchd at once is named by a path it holds in the lane's own
        // temp dir (its working dir, or the output file Claude Code gives each command there).
        // Never by working in the checkout: other lanes and the builder run their jobs there too.
        const watch: LaneProcessWatch = createLaneProcessWatch({
          ...processDeps,
          ledger,
          places: [...new Set([tmpDir, realPathOr(tmpDir)])],
          // Each kind once per session: the watch samples every second.
          onError: (failure, error) => {
            if (told.has(failure)) return;
            told.add(failure);
            deps.log?.warn(
              {
                projectId: input.project.id,
                tmpDir,
                failure,
                err: error instanceof Error ? error.message : String(error),
              },
              WATCH_FAILURES[failure],
            );
          },
        });
        const commandEnv = prepareCommandEnv(tmpDir, deps.home, input.env);
        // Claude Code strips some of these from a sandboxed command's env; the shell sets every one
        // of them again from this file before each command.
        envFile = createLaneEnvFile(commandEnv, tmpRoot);
        // The file carries every variable; the session env, which Claude Code and its own git run
        // with outside the sandbox, leaves out those that name a path the lane can write.
        const env: Record<string, string> = {
          ...withoutTempDirPaths(commandEnv, tmpDir),
          CLAUDE_CODE_TMPDIR: tmpDir,
          CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
          CLAUDE_ENV_FILE: envFile,
        };
        const settings = buildLaneProfile({
          checkout,
          tmpDir,
          home: deps.home,
          protectedReads: protectedList,
          secretFiles: access.checkoutSecrets,
          toolchainSecrets: toolchain.secretFiles,
          toolchainReads: toolchain.reads,
          toolchainListings: toolchain.listings,
          allowedDomains: access.hosts,
          readList,
          // A linked worktree's common dir is read for the git a lane runs, never written.
          // The env file is read to set up each command's shell, in case that happens in the sandbox.
          extraReads: [envFile, ...access.gitReads],
          // Claude Code opens the checkout for writing itself.
          extraWrites: [],
          // Claude Code would otherwise open the checkout's git state with the checkout, and a
          // project nested in it.
          denyWrites: [...access.gitState, ...access.otherCheckouts],
          loopback: input.project.sandboxLoopback,
          deniedEnvNames: deniedEnvNames({ ...input.env, ...env }),
        });
        // The config dir and its ancestors stay readable to the file tools, which open the
        // session's own saved tool results there; the guard, the broker and the kernel hold them.
        const deniedToFileTools = protectedList.filter(
          (path) => !isEqualOrUnder(input.configDir, path),
        );
        mcp = sandboxMcpServers({
          access,
          home: deps.home,
          tmpRoot,
          runtime: deps.runtime,
          env: input.env,
          checkouts: input.checkouts,
          servers: input.mcpServers,
        });
        const claudeProtected = claudeProtectedPaths(checkout);
        const spec: LaneSandboxSpec = {
          settings,
          env,
          disallowedTools: [
            ...deniedToFileTools.flatMap((path) => [
              `Read(${ruleScope(path)})`,
              `Read(${ruleScope(path)}/**)`,
            ]),
            ...secretFiles.map((path) => `Read(${ruleScope(path)})`),
          ],
          askRules: [
            ...claudeProtected.files.flatMap((path) => [
              `Edit(${ruleScope(path)})`,
              `Write(${ruleScope(path)})`,
            ]),
            ...claudeProtected.directories.flatMap((path) => [
              `Edit(${ruleScope(path)}/**)`,
              `Write(${ruleScope(path)}/**)`,
            ]),
          ],
          autoMode: autoModeRules(input.project.gateCommand),
        };
        let providerSessionId = input.resumeProviderSessionId;
        const fileAccess: FileAccessContext = {
          checkout: input.project.repoPath,
          home: deps.home,
          protectedReads: protectedList,
          secretFiles,
          readList,
          configDir: input.configDir,
          sandboxTemp: { root: tmpRoot, own: tmpDir },
          get providerSessionId() {
            return providerSessionId;
          },
        };
        const ownEnvFile = envFile;
        const ownLedger = ledger;
        const ownMcp = mcp;
        let disposed = false;
        return {
          spec,
          fileAccess,
          tmpDir,
          commandEnv,
          mcpServers: ownMcp.servers,
          mcpFailures: ownMcp.failures,
          setProviderSession(id) {
            providerSessionId = id;
          },
          trackProcesses: (root) => watch.track(root),
          endProcesses: () => watch.end(),
          dispose() {
            if (disposed) return;
            disposed = true;
            removeAll([
              () => {
                ownMcp.dispose();
              },
              () => {
                removeLaneFiles(ownEnvFile, tmpDir, tmpRoot);
              },
              () => {
                // Processes it could not stop stay named: the sweep tries them again while the
                // daemon runs, and the next start does if it never can.
                const kept = watch.pending();
                ledgers.release(ownLedger);
                if (kept) ledgers.later();
                else removeProcessLedger(ownLedger, tmpRoot);
              },
            ]);
          },
        };
      } catch (error) {
        try {
          const made = mcp;
          removeAll([
            ...(made === null
              ? []
              : [
                  () => {
                    made.dispose();
                  },
                ]),
            () => {
              removeLaneFiles(envFile, tmpDir, tmpRoot);
            },
            ...(ledger === null
              ? []
              : [
                  () => {
                    if (ledger === null) return;
                    ledgers.release(ledger);
                    removeProcessLedger(ledger, tmpRoot);
                  },
                ]),
          ]);
        } catch {
          // The error that stopped the session is the one to report.
        }
        throw error;
      }
    },
  };
}
