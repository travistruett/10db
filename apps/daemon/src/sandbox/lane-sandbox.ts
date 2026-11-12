import { existsSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Provider, type PermissionRuleDto, type ProjectDto } from '@10db/contracts';
import type { Clock } from '../clock';
import { foldPathCase } from '../guard';
import { besideTheWays } from './beside-the-way';
import { prepareCommandEnv, withoutTempDirPaths } from './command-env';
import { dockerAccess, dockerEnvNames } from './docker-access';
import { deniedEnvNames } from './env-allowlist';
import { createLaneEnvFile, removeLaneEnvFile } from './env-file';
import { claudeProtectedPaths, SYSTEM_DOC_ROOTS, type FileAccessContext } from './file-access';
import {
  sandboxMcpServers,
  type McpSandboxes,
  type McpSandboxFailure,
  type SandboxedMcpServer,
  type StdioMcpServer,
} from './mcp-sandbox';
import { buildLaneProfile, readListOverSandboxRoots, type LaneSandboxSettings } from './profile';
import {
  laneRootsOf,
  projectAccess,
  type ProjectAccess,
  type ProjectAccessDeps,
} from './project-access';
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
import { createSetupDir, EMPTY_SETUP, keepSetup, type SessionSetup } from './setup-dir';
import type { SetupInput } from './setup-input';
import { setupReadRefusal } from './setup-reads';
import { allowlisted, type SandboxRuntime } from './srt-launch';
import { autoModeRules, type AutoModeSettings } from './auto-mode-rules';
import {
  createLaneTempDir,
  laneTempRoot,
  MAX_SANDBOX_TMP_BYTES,
  removeAll,
  removeLaneTempDir,
} from './temp-dir';

/**
 * Tools a lane never needs: 10db makes its worktrees, and nothing a lane starts may outlive it. The
 * PreToolUse hook asks about them too, in case a later Claude Code names a new one.
 */
const LANE_DISALLOWED_TOOLS: readonly string[] = [
  'EnterWorktree',
  'ExitWorktree',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'PushNotification',
];

/** What a sandboxed session hands Claude Code on top of its ordinary options. */
export interface LaneSandboxSpec {
  readonly settings: LaneSandboxSettings;
  /** The checkout's real path, which the profile builds on and does not list as writable. */
  readonly checkout: string;
  /** Merged over the session's env. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * A command's whole environment, for an agent that starts commands from nothing: the allowlisted
   * names of the session env, the temp dir and every variable the sandbox sets. `LaneSession.commandEnv`
   * alone holds no `PATH`, `HOME` or `TMPDIR`, because a Claude Code lane inherits those.
   */
  readonly shellEnv: Readonly<Record<string, string>>;
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
  /** What the session's setup brought along, as the sandbox kept it; empty without a setup. */
  readonly setup: SessionSetup;
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
  /** A project that leaves `sandboxDocker` out gets no Docker, as one with it off does. */
  readonly project: Pick<ProjectDto, 'id' | 'repoPath' | 'sandboxLoopback' | 'gateCommand'> &
    Partial<Pick<ProjectDto, 'sandboxDocker'>>;
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
  /** The root this session's temp dir is made in; the temp root by default. */
  readonly tempRoot?: string;
  /**
   * The agent the session runs, Claude's by default. Only a Codex session's temp dir may be longer
   * than `MAX_SANDBOX_TMP_BYTES`: no Claude Code or srt runs in it.
   */
  readonly provider?: Provider;
  /**
   * A session that changes nothing in the checkout, a Plan conversation's: its commands write only
   * its own temp dir, the checkout as a whole being denied over the write Claude Code opens itself.
   * It never gets the Docker socket, whatever the project's switch says.
   */
  readonly readOnly?: boolean;
  /**
   * The pictures pasted into the lane's task's thread, which its file tools may read though the data
   * directory holds them (Workbench spec §13). Its commands read none. Plan has no task, so none.
   */
  readonly taskFiles?: string;
  /**
   * The builder's skills and plugins and the project's cleaned definitions to bring along. Each real
   * path is judged before it opens read-only to the session; none is given to the gate or a repo server.
   */
  readonly setup?: SetupInput;
}

/** What a session's setup would load and leave out, judged as a session judges it; nothing is written. */
export interface SetupJudgement {
  readonly loaded: SessionSetup['loaded'];
  readonly leftOut: SessionSetup['leftOut'];
}

export interface LaneSandbox {
  forSession(input: LaneSessionInput): Promise<LaneSession>;
  /** The Settings preview of a project's setup: `keepSetup` against the project's access. */
  judgeSetup(
    project: LaneSessionInput['project'],
    input: SetupInput,
    checkouts?: readonly string[],
  ): Promise<SetupJudgement>;
}

/** The daemon's logger, as far as the sandbox tells it what it could not do. */
export interface SandboxLog {
  warn(fields: object, message: string): void;
}

export interface LaneSandboxDeps extends Omit<ProjectAccessDeps, 'tmpRoot'> {
  /** Where temp dirs are made, `laneTempRoot()` by default; tests pass a short temp root. */
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
  /** Paces the reading of each repo MCP server's log of refused hosts; the system's by default. */
  readonly clock?: Clock;
  /**
   * Where the daemon makes lane copies. The file tools refuse (no card) a path under it that is not
   * in the session's own copy.
   */
  readonly worktreeRoot: string;
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

/** Where one session's files go: its temp dir's root, and the root of its env file and ledger. */
interface SessionRoots {
  readonly temp: string;
  readonly files: string;
}

/** Removes a session's env file and temp dir; see `removeAll`. */
function removeLaneFiles(envFile: string | null, tmpDir: string, roots: SessionRoots): void {
  removeAll([
    ...(envFile === null
      ? []
      : [
          () => {
            removeLaneEnvFile(envFile, roots.files);
          },
        ]),
    () => {
      removeLaneTempDir(tmpDir, roots.temp);
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

/** The longest a session's temp dir path may be, by the agent that runs in it. */
function tempDirLimit(provider: Provider): number | null {
  switch (provider) {
    case Provider.Claude:
      return MAX_SANDBOX_TMP_BYTES;
    case Provider.Codex:
      return null;
  }
}

/** Claude Code's spelling of an absolute path in a permission rule: `//` stands for the root. */
const ruleScope = (path: string): string => `/${path}`;

/** The file tools' rules that keep a secret closed: a file by its path, a folder with its tree. */
function secretReadRules(path: string): string[] {
  let folder = false;
  try {
    folder = statSync(path).isDirectory();
  } catch {
    // Gone or unreadable now: its own path is still denied.
  }
  const rule = `Read(${ruleScope(path)})`;
  return folder ? [rule, `Read(${ruleScope(path)}/**)`] : [rule];
}

/** Whether a project copy's checkout file, by its path under the checkout, is one of the checkout's secrets. */
function checkoutSecret(access: ProjectAccess): (source: string) => boolean {
  const secrets = access.checkoutSecrets.map(foldPathCase);
  return (source) => {
    const path = foldPathCase(join(access.checkout, source));
    return secrets.some((secret) => isEqualOrUnder(path, secret));
  };
}

/** The refusal a session's setup reads are judged by, from the project's access. */
function setupRefusal(
  home: string,
  access: ProjectAccess,
  worktreeRoot: string,
): (real: string) => string | null {
  const ctx = {
    home: realPathOr(home),
    protectedReads: access.protectedReads,
    secretFiles: [...access.checkoutSecrets, ...access.toolchain.secretFiles],
    sandboxRoots: access.sandboxRoots,
    laneWritable: [...access.writableRoots, worktreeRoot, realPathOr(worktreeRoot)],
  };
  return (real) => setupReadRefusal(real, ctx);
}

/** Builds each lane session's sandbox: one profile, one temp dir and one file-tool context. */
export function createLaneSandbox(deps: LaneSandboxDeps): LaneSandbox {
  const tmpRoot = deps.tmpRoot ?? laneTempRoot();
  const { filesRoot } = deps;
  // Every session samples together: one `ps` serves them all.
  const processDeps: LaneProcessSetup = deps.processes ?? {
    table: systemProcessTable,
    sampleTable: cachedProcessTable(systemProcessTable, 500),
    openPaths: systemOpenPaths,
  };
  const ledgers = deps.ledgers ?? createLedgerSweep(filesRoot, processDeps);
  return {
    async forSession(input) {
      const roots: SessionRoots = { temp: input.tempRoot ?? tmpRoot, files: filesRoot };
      // The session's own root is one lanes write, whether or not the daemon listed it.
      const laneRoots = [...new Set([...laneRootsOf({ ...deps, tmpRoot }), roots.temp])];
      const access = await projectAccess(
        { ...deps, tmpRoot, laneWritableRoots: laneRoots },
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
      const tmpDir = createLaneTempDir(roots.temp, tempDirLimit(input.provider ?? Provider.Claude));
      // The session's own temp dir root is closed to every other sandbox too.
      const sandboxRoots = [...new Set([...access.sandboxRoots, roots.temp])];
      // Once per session, though the lane's profile and each repo server's leave each one out.
      for (const entry of readListOverSandboxRoots(readList, sandboxRoots))
        deps.log?.warn(
          { projectId: input.project.id, entry },
          "a read list entry holds a root where 10db keeps sandboxes' files, so the lane's profile leaves it out and the lane can't read it",
        );
      let envFile: string | null = null;
      let ledger: string | null = null;
      let mcp: McpSandboxes | null = null;
      let setupDir: ReturnType<typeof createSetupDir> | null = null;
      try {
        // Lane-writable ground, a protected read, a secret or a sandbox root never opens.
        if (input.setup !== undefined)
          setupDir = createSetupDir(
            filesRoot,
            input.setup,
            setupRefusal(deps.home, { ...access, sandboxRoots }, deps.worktreeRoot),
            deps.home,
            checkoutSecret(access),
          );
        const setup = setupDir?.setup ?? EMPTY_SETUP;
        const setupSecrets = setup.secretFiles;
        // What the profile opens of the setup: never a read that is, or lies in, a secret file.
        const setupReads = setup.reads.filter(
          (read) => !setupSecrets.some((secret) => isEqualOrUnder(read, secret)),
        );
        const ownSetupDir = setup.reads[0];
        // Outside every lane-writable dir: it names the processes to stop after a daemon restart.
        // Named for this daemon, so a later one leaves it alone while this one runs, and held, so
        // this one's sweep does too until the session is gone.
        ledger = createProcessLedger(filesRoot, processDeps.ownPid ?? process.pid);
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
        // With the project's Docker switch on, the lane's commands may reach the engine (Claude's
        // sandbox and Codex's both read the profile's sockets); off, they get no socket. A read-only
        // session never does: a container could write the checkout or mount any host folder.
        const docker =
          input.project.sandboxDocker && input.readOnly !== true
            ? dockerAccess(deps.home, input.env)
            : null;
        const dockerNames: ReadonlySet<string> | undefined =
          docker === null ? undefined : new Set(dockerEnvNames(input.env));
        const commandEnv = prepareCommandEnv(tmpDir, deps.home, input.env);
        // Claude Code strips some of these from a sandboxed command's env; the shell sets every one
        // of them again from this file before each command.
        envFile = createLaneEnvFile(commandEnv, filesRoot);
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
          secretFiles: [...access.checkoutSecrets, ...setupSecrets],
          toolchainSecrets: toolchain.secretFiles,
          toolchainReads: toolchain.reads,
          toolchainListings: toolchain.listings,
          allowedDomains: access.hosts,
          readList,
          // A linked worktree's common dir is read for the git a lane runs, never written.
          // The env file is read to set up each command's shell, in case that happens in the sandbox;
          // the files root lies in no protected read, so the grant stays.
          extraReads: [envFile, ...access.gitReads, ...(docker?.reads ?? [])],
          // Claude Code opens the checkout for writing itself.
          extraWrites: [],
          // Claude Code would otherwise open the checkout's git state with the checkout, and a
          // project nested in it.
          denyWrites: [
            ...(input.readOnly === true ? [checkout] : []),
            ...access.gitState,
            ...access.otherCheckouts,
            ...access.pinnedTools,
          ],
          sandboxRoots,
          ownFiles: [envFile, ...(ownSetupDir === undefined ? [] : [ownSetupDir])],
          setupReads,
          loopback: input.project.sandboxLoopback,
          dockerSockets: docker?.sockets ?? [],
          deniedEnvNames: deniedEnvNames({ ...input.env, ...env }, dockerNames),
        });
        // The config dir and its ancestors stay readable to the file tools, which open the
        // session's own saved tool results there; the guard, the broker and the kernel hold them.
        // A task with pictures, and the setup's reads, keep the way down to them open, and Claude
        // Code denies everything beside it that is there now; what is made later, another task's
        // folder among it, is left to the guard and the file tools' judge, which refuse it.
        const pictures =
          input.taskFiles !== undefined && existsSync(input.taskFiles) ? input.taskFiles : null;
        const openInside = [...(pictures === null ? [] : [pictures]), ...setupReads];
        const deniedToFileTools = protectedList
          .filter((path) => !isEqualOrUnder(input.configDir, path))
          .flatMap((path) => {
            const open = openInside.filter((target) => isEqualOrUnder(target, path));
            return open.length === 0 ? [path] : besideTheWays(path, open);
          });
        mcp = sandboxMcpServers({
          access,
          home: deps.home,
          tmpRoot,
          filesRoot,
          sandboxRoots,
          runtime: deps.runtime,
          env: input.env,
          checkouts: input.checkouts,
          servers: input.mcpServers,
          ...(deps.log === undefined ? {} : { log: deps.log }),
          ...(deps.clock === undefined ? {} : { clock: deps.clock }),
        });
        const claudeProtected = claudeProtectedPaths(checkout);
        const spec: LaneSandboxSpec = {
          settings,
          checkout,
          env,
          shellEnv: { ...allowlisted(input.env, dockerNames), TMPDIR: tmpDir, ...commandEnv },
          disallowedTools: [
            ...LANE_DISALLOWED_TOOLS,
            ...deniedToFileTools.flatMap((path) => [
              `Read(${ruleScope(path)})`,
              `Read(${ruleScope(path)}/**)`,
            ]),
            ...[...secretFiles, ...setupSecrets].flatMap(secretReadRules),
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
          secretFiles: [...secretFiles, ...setupSecrets],
          readList,
          systemDocRoots: SYSTEM_DOC_ROOTS,
          ...(input.taskFiles === undefined ? {} : { filesDir: input.taskFiles }),
          configDir: input.configDir,
          // Every root lanes write and the files root: another lane's temp dir, in either lanes'
          // root, and a file that holds a sandbox are never a lane's to read or write.
          sandboxTemp: {
            roots: [...laneRoots, filesRoot],
            own: tmpDir,
          },
          worktreeRoot: deps.worktreeRoot,
          setupReads,
          get providerSessionId() {
            return providerSessionId;
          },
        };
        const ownEnvFile = envFile;
        const ownLedger = ledger;
        const ownMcp = mcp;
        const ownSetup = setupDir;
        let disposed = false;
        return {
          spec,
          fileAccess,
          tmpDir,
          commandEnv,
          mcpServers: ownMcp.servers,
          mcpFailures: ownMcp.failures,
          setup,
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
                removeLaneFiles(ownEnvFile, tmpDir, roots);
              },
              () => {
                ownSetup?.remove();
              },
              () => {
                // Processes it could not stop stay named: the sweep tries them again while the
                // daemon runs, and the next start does if it never can.
                const kept = watch.pending();
                ledgers.release(ownLedger);
                if (kept) ledgers.later();
                else removeProcessLedger(ownLedger, filesRoot);
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
              removeLaneFiles(envFile, tmpDir, roots);
            },
            () => {
              setupDir?.remove();
            },
            ...(ledger === null
              ? []
              : [
                  () => {
                    if (ledger === null) return;
                    ledgers.release(ledger);
                    removeProcessLedger(ledger, filesRoot);
                  },
                ]),
          ]);
        } catch {
          // The error that stopped the session is the one to report.
        }
        throw error;
      }
    },
    async judgeSetup(project, setupInput, checkouts = [project.repoPath]) {
      const laneRoots = laneRootsOf({ ...deps, tmpRoot });
      const access = await projectAccess(
        { ...deps, tmpRoot, laneWritableRoots: laneRoots },
        { project, env: {}, rules: [], configDirs: [], checkouts },
      );
      const kept = keepSetup(
        setupInput,
        setupRefusal(deps.home, access, deps.worktreeRoot),
        deps.home,
        checkoutSecret(access),
      );
      return {
        loaded: {
          skills: kept.keptSkills.map((skill) => skill.name),
          plugins: kept.keptPlugins.map((plugin) => plugin.id),
        },
        leftOut: kept.leftOut,
      };
    },
  };
}
