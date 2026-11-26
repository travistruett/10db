import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIPv6 } from 'node:net';
import { homedir } from 'node:os';
import { DeniedBy, InvalidError, Provider, type ProjectDto, type ProjectId } from '@10db/contracts';
import { getProject, listPermissionRules, listProjects } from '@10db/db';
import { allCheckouts, projectAtCheckout } from '../delivery';
import { trustSwitchesFor, warnInvalidTrust } from '../permissions';
import { sessionConfigDir, type AwsCredentialsExporter } from '../environment';
import type { StateStore } from '../events';
import type { Git } from '../git';
import type { ProtectedPath } from '../guard';
import {
  createPermissionBroker,
  createProjectMcpReader,
  flagMcpFailure,
  type InboxService,
} from '../inbox';
import type { Logger } from '../log';
import {
  EMPTY_SETUP,
  fileAccessJudge,
  laneWritableRoots,
  SYSTEM_TEMP_ROOTS,
  type LaneSandbox,
  type LaneSession,
} from '../sandbox';
import { leftOutNote, planSessionSetup, yourMcpForSession } from '../session-setup';
import {
  skippedServersNote,
  splitProjectMcp,
  type ProjectMcp,
  type YourSessionServer,
} from '../sessions';
import type { TakeoverServers } from '../takeover';
import { privateHostProblem, type ShapePrepareInput, type ShapePrepared } from '../shape';
import { isLinearServer, type ReporterPrepared } from '../linear';

/** What a Plan conversation's session is told when one of the project's servers is left out. */
const INSTEAD = 'Work without them, and tell the builder when the plan needs one.';

const NO_MCP: ProjectMcp = {
  servers: {},
  configHashes: {},
  warnings: [],
  pending: [],
  denied: [],
  failures: [],
};

/** Addresses on this Mac or its network: loopback, private, link-local, shared and unique-local ones. */
const PRIVATE_ADDRESSES = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
  ] as const)
    list.addSubnet(net, prefix, 'ipv4');
  for (const [net, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
  ] as const)
    list.addSubnet(net, prefix, 'ipv6');
  return list;
})();

/** Whether an address is on this Mac or its network, an IPv4 address mapped into IPv6 included. */
function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) return PRIVATE_ADDRESSES.check(mapped, 'ipv4');
  return PRIVATE_ADDRESSES.check(address, isIPv6(address) ? 'ipv6' : 'ipv4');
}

/** Every address the system resolves a host name to; none when it can't. */
async function systemLookup(host: string): Promise<readonly string[]> {
  try {
    return (await dnsLookup(host, { all: true })).map((a) => a.address);
  } catch {
    return [];
  }
}

/** The earliest expiry among the AWS credentials handed to the project's servers, or null. */
function earliestExpiry(mcp: ProjectMcp): string | null {
  const times = Object.values(mcp.servers).flatMap((server) =>
    server.type === 'stdio' && server.env['AWS_CREDENTIAL_EXPIRATION'] !== undefined
      ? [server.env['AWS_CREDENTIAL_EXPIRATION']]
      : [],
  );
  return times.reduce<string | null>(
    (first, t) => (first === null || Date.parse(t) < Date.parse(first) ? t : first),
    null,
  );
}

/**
 * Prepares each Plan conversation's session (Shape spec §5.2): a read-only lane sandbox, the
 * project's approved MCP servers resolved as a lane's are (from the project env, with no workstream)
 * and the lanes' permission broker for the conversation. A config or a sandbox that can't be built
 * leaves the session with less, said in its first message, never with no Plan at all.
 */
export interface SessionReadDeps {
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly git: Pick<Git, 'commitAt' | 'folderAt' | 'fileAt'>;
  readonly logger: Logger;
  readonly laneSandbox: LaneSandbox;
  readonly protectedPaths: readonly ProtectedPath[];
  /** The login env with every billing switch and account secret stripped, as a lane's servers get. */
  readonly projectEnv: () => Readonly<Record<string, string>>;
  /** Resolves a remote server's host to its addresses; the system's resolver by default. */
  readonly lookup?: (host: string) => Promise<readonly string[]>;
  readonly exportAwsCredentials: AwsCredentialsExporter;
  /** The builder's home, whose instructions, skills and plugins come along (Settings › Trust). */
  readonly builderHome: string;
  /** The roots lanes write outside the registered checkouts: no setup comes along from them. */
  readonly laneWritableRoots: readonly string[];
  /** The folder every worktree is made under, which a lane writes. */
  readonly worktreeBase: string;
  /** Where a ChatGPT session's temp dir is made, apart from Claude sessions', as a ChatGPT lane's is. */
  readonly codexLaneTempRoot: string;
}

/** What a session's reads share: the project's servers as the config reads them, and the setup and the builder's servers planned. */
function sessionReads(deps: Omit<SessionReadDeps, 'laneSandbox'>) {
  const { state, inbox, logger } = deps;
  const reader = createProjectMcpReader({
    state,
    inbox,
    logger,
    exportAwsCredentials: deps.exportAwsCredentials,
  });

  /** The project's servers, or none with a line saying why when its config can't be read. */
  async function readServers(
    project: ProjectDto,
  ): Promise<{ readonly mcp: ProjectMcp; readonly problem: string | null }> {
    try {
      const mcp = await reader.read({
        project,
        checkout: project.repoPath,
        workstreamId: null,
        // Never the session's env: it holds the account's own key, which no repo server is given.
        env: deps.projectEnv(),
      });
      return { mcp, problem: null };
    } catch (error) {
      logger.warn(
        { err: error, projectId: project.id },
        "the project's MCP config could not be read",
      );
      return {
        mcp: NO_MCP,
        problem: `Note from 10db: the repo's .mcp.json could not be read, so no project MCP server is in this session (${error instanceof Error ? error.message : String(error)}). ${INSTEAD}`,
      };
    }
  }

  /** The project's servers as the config reads them, and the setup and the builder's servers planned from them. */
  async function plan(project: ProjectDto) {
    const { mcp: projectMcp, problem } = await readServers(project);
    const servers = splitProjectMcp(projectMcp.servers);
    // A remote server is a connection Claude Code makes outside every sandbox: one on this Mac or its
    // network could reach 10db's own window, so a conversation gets only those on the public web, by
    // name and by every address the name resolves to now. A name that resolves elsewhere later is not
    // caught: Claude Code makes the connection, so the address can't be pinned.
    const lookup = deps.lookup ?? systemLookup;
    const publicRemote = await Promise.all(
      Object.entries(servers.remote).map(async ([name, server]) => {
        if (privateHostProblem(server.url) !== null) return null;
        const addresses = await lookup(new URL(server.url).hostname);
        return addresses.length > 0 && !addresses.some(isPrivateAddress)
          ? ([name, server] as const)
          : null;
      }),
    );
    const remote = Object.fromEntries(publicRemote.filter((entry) => entry !== null));
    const offMac = Object.keys(servers.remote).filter((name) => !(name in remote));
    // The roots the launch judges a builder's file and server against, so the readers of the builder's config do too.
    const writableRoots = laneWritableRoots({
      checkouts: allCheckouts(state.db),
      worktreeBase: deps.worktreeBase,
      sandboxTempRoots: deps.laneWritableRoots,
      systemTempRoots: SYSTEM_TEMP_ROOTS,
    }).map((root) => root.path);
    // Read when each session is prepared: a switch flipped meanwhile applies from the next one.
    const setupPlan = planSessionSetup({
      home: deps.builderHome,
      checkout: project.repoPath,
      switches: trustSwitchesFor(state.db, project.id, warnInvalidTrust(logger)),
      laneWritable: writableRoots,
    });
    const instructions = setupPlan.instructions.text;
    // The builder's own servers, planned as the session is prepared; Claude and Codex chats and Plan get the same.
    const yours = yourMcpForSession({
      db: state.db,
      home: deps.builderHome,
      projectId: project.id,
      projectServerNames: [
        ...Object.keys(projectMcp.servers),
        ...projectMcp.pending.map((review) => review.name),
        ...projectMcp.denied,
        ...projectMcp.failures.map((failure) => failure.name),
      ],
      loginEnv: deps.projectEnv(),
      laneWritable: writableRoots,
      localBinding: listProjects(state.db).some((other) => other.sandboxLoopback),
      plugins: setupPlan.input.plugins.map((p) => ({ id: p.id, installPath: p.path })),
      onInvalid: (stored) => {
        logger.warn({ stored }, 'a stored MCP approvals or switch value is not a shape 10db reads');
      },
    });
    const yourServers = (
      launched: LaneSession['yourMcpServers'],
    ): Record<string, YourSessionServer> => ({
      ...Object.fromEntries(
        Object.entries(launched ?? {}).flatMap(([name, connect]) => {
          const planned = yours.stdio[name];
          return planned === undefined
            ? []
            : [[name, { connect, claudeName: null, claudeOAuth: null, codex: planned.codex }]];
        }),
      ),
      ...Object.fromEntries(
        Object.entries(yours.remote).map(([name, remote]) => [
          name,
          {
            connect: { type: remote.type, url: remote.url, headers: remote.headers },
            claudeName: remote.claudeName,
            claudeOAuth: remote.oauth,
            codex: remote.codex,
          },
        ]),
      ),
    });
    return {
      projectMcp,
      problem,
      servers,
      remote,
      offMac,
      setupPlan,
      instructions,
      yours,
      yourServers,
    };
  }

  return { plan };
}

/**
 * Prepares what a chat's session had, for the builder's terminal (sessions spec §7.5): the setup and the builder's
 * servers as a session plans them, and the project's approved stdio servers each under srt, never as written. Every
 * approved remote server comes along: the public-host filter protects a sandboxed agent's connection from 10db's own
 * window, and the terminal makes its connections outside any sandbox anyway.
 */
export function createTakeoverPreparer(
  deps: SessionReadDeps,
): (input: {
  readonly project: ProjectDto;
  readonly folder: string;
  readonly env: Readonly<Record<string, string>>;
  readonly configDir: string;
}) => Promise<TakeoverServers> {
  const { state } = deps;
  const { plan } = sessionReads(deps);
  return async ({ project, folder, env, configDir }) => {
    const { problem, servers, setupPlan, instructions, yours, yourServers } = await plan(project);
    const sandbox = await deps.laneSandbox.forTakeover({
      project,
      env,
      configDir,
      checkouts: allCheckouts(state.db),
      setup: setupPlan.input,
      yourMcpServers: yours.stdio,
      projectStdio: servers.stdio,
      filesRoot: folder,
    });
    try {
      const notes = [
        problem,
        leftOutNote([...setupPlan.leftOut, ...sandbox.leftOut, ...yours.leftOut]),
      ].filter((line) => line !== null);
      return {
        instructions,
        pluginDirs: sandbox.setup.pluginDirs,
        projectMcpServers: { ...servers.remote, ...sandbox.projectMcpServers },
        yourMcpServers: yourServers(sandbox.yourMcpServers),
        notes,
        tempDirs: sandbox.tempDirs,
        remove: () => {
          sandbox.remove();
        },
      };
    } catch (error) {
      sandbox.remove();
      throw error;
    }
  };
}

export function createShapePreparer(
  deps: SessionReadDeps,
): (input: ShapePrepareInput) => Promise<ShapePrepared> {
  const { state, inbox, logger } = deps;
  const { plan } = sessionReads(deps);
  return async (input) => {
    const project = getProject(state.db, input.projectId);
    const {
      projectMcp,
      problem,
      servers,
      remote,
      offMac,
      setupPlan,
      instructions,
      yours,
      yourServers,
    } = await plan(project);
    let session: LaneSession;
    try {
      session = await deps.laneSandbox.forSession({
        setup: setupPlan.input,
        project:
          input.checkout === undefined ? project : projectAtCheckout(project, input.checkout),
        env: input.env,
        // A conversation has no workstream: only the project's own rules hold.
        rules: listPermissionRules(state.db, project.id, null),
        resumeProviderSessionId: input.resumeProviderSessionId,
        configDir: sessionConfigDir(input.harness, input.env, homedir()),
        checkouts: allCheckouts(state.db),
        mcpServers: servers.stdio,
        yourMcpServers: yours.stdio,
        readOnly: input.writes !== true,
        ...(input.unsandboxedAsk === undefined ? {} : { allowUnsandboxedCommands: true }),
        ...(input.planFiles === undefined ? {} : { planFiles: input.planFiles }),
        // The agent that runs the session, and a ChatGPT session's temp root, as its lane's would be.
        provider: input.harness,
        ...(input.harness === Provider.Codex ? { tempRoot: deps.codexLaneTempRoot } : {}),
      });
    } catch (error) {
      logger.warn({ err: error, projectId: project.id }, 'a Plan sandbox could not be built');
      return {
        sandbox: null,
        projectMcpServers: {},
        yourMcpServers: {},
        claudeConnectors: false,
        note: [
          `Note from 10db: this session has no sandbox (${error instanceof Error ? error.message : String(error)}), so it runs no command and has no project MCP server. ${INSTEAD}`,
          leftOutNote([...setupPlan.leftOut, ...yours.leftOut]),
        ]
          .filter((line) => line !== null)
          .join('\n\n'),
        credentialsExpireAt: null,
        // With no Bash a skill's scripts can't run, so no folder is opened: only the instructions go.
        instructions,
        setup: EMPTY_SETUP,
        canUseTool: () =>
          Promise.resolve({
            behavior: 'deny',
            message: 'This session has no sandbox to run it in.',
            by: DeniedBy.TenDb,
          }),
        trackProcesses: () => undefined,
        markOwn: () => undefined,
        endJobs: () => Promise.resolve(),
        release: () => Promise.resolve(),
      };
    }
    const sandboxed = session;
    // Every way out from here leaves the sandbox removed: its sealed files can hold AWS credentials.
    try {
      for (const failure of sandboxed.mcpFailures)
        flagMcpFailure(inbox, project.id, null, failure, project.repoPath);
      const broker = createPermissionBroker(
        { state, inbox, git: deps.git, logger },
        {
          projectId: project.id,
          workstreamId: null,
          conversationId: input.conversationId,
          ...(input.shapeId === undefined ? {} : { shapeId: input.shapeId }),
          sessionId: input.sessionId,
          observer: input.observer,
          signal: input.signal,
          mcpApproved: projectMcp.configHashes,
          ...(input.chat === true ? { chat: true as const } : {}),
          sandbox: {
            fileAccess: sandboxed.fileAccess,
            hazards: [],
            commandsAsk: true,
            ...(input.unsandboxedAsk === undefined
              ? {}
              : {
                  unsandboxed: {
                    agent: input.harness,
                    mayRun: input.unsandboxedAsk.mayRun,
                    changes: input.unsandboxedAsk.changes,
                    bump: input.unsandboxedAsk.bump,
                    background: input.unsandboxedAsk.background,
                    remembers: input.unsandboxedAsk.remembers,
                    checkoutState: input.unsandboxedAsk.checkoutState,
                  },
                }),
          },
          ...(input.limits === undefined ? {} : { limits: input.limits }),
        },
      );
      const skipped = skippedServersNote(
        {
          ...projectMcp,
          failures: [
            ...projectMcp.failures,
            ...sandboxed.mcpFailures,
            ...offMac.map((name) => ({
              name,
              message: 'it is on this Mac or its network, or its name does not resolve',
            })),
          ],
        },
        [],
        INSTEAD,
      );
      let tracked = false;
      return {
        sandbox: sandboxed.spec,
        commands: {
          protectedPaths: deps.protectedPaths,
          fileAccess: fileAccessJudge(sandboxed.fileAccess),
        },
        projectMcpServers: { ...remote, ...sandboxed.mcpServers },
        yourMcpServers: yourServers(sandboxed.yourMcpServers),
        claudeConnectors: yours.connectorsOn,
        note:
          [
            problem,
            skipped,
            leftOutNote([
              ...setupPlan.leftOut,
              ...sandboxed.setup.leftOut,
              ...yours.leftOut,
              ...(sandboxed.yourMcpLeftOut ?? []),
            ]),
          ]
            .filter((line) => line !== null)
            .join('\n\n') || null,
        credentialsExpireAt: earliestExpiry(projectMcp),
        instructions,
        setup: sandboxed.setup,
        canUseTool: broker,
        trackProcesses: (pid) => {
          tracked = true;
          void sandboxed.trackProcesses({ pid, startedAt: null });
        },
        markOwn: () => {
          sandboxed.markOwn();
        },
        endJobs: () => (tracked ? sandboxed.endJobs() : Promise.resolve()),
        release: async () => {
          try {
            // What its commands left running ends with the session, as a lane's does.
            if (tracked) await sandboxed.endProcesses();
          } catch (error) {
            logger.warn({ err: error, projectId: project.id }, 'a Plan session left processes');
          } finally {
            sandboxed.dispose();
          }
        },
      };
    } catch (error) {
      sandboxed.dispose();
      throw error;
    }
  };
}

/** What a Full access chat's session is prepared with, beyond a sandboxed chat's. */
export interface FullAccessPrepareInput extends ShapePrepareInput {
  /**
   * Bring the builder's plugins, instructions and servers as a sandboxed chat has them: a Codex session, and
   * a Claude one whose config folder isn't the builder's own, where Claude Code would find none of them.
   */
  readonly relay: boolean;
}

/**
 * Prepares a Full access chat's session: no sandbox and no kernel profile around its commands, and a permission
 * broker with no file access, so every call Claude Code's own mode escalates is a card. Where the builder's setup
 * is relayed the sandbox is still built, only to launch their servers and copy their plugins, and it goes with the
 * session. A Claude session never takes the repo's servers over `setMcpServers`: Claude Code reads `.mcp.json` itself.
 */
export function createFullAccessPreparer(
  deps: Omit<SessionReadDeps, 'laneSandbox'> & { readonly laneSandbox: LaneSandbox | null },
): (input: FullAccessPrepareInput) => Promise<ShapePrepared> {
  const { state, inbox, logger } = deps;
  const { laneSandbox } = deps;
  const relayed = laneSandbox === null ? null : createShapePreparer({ ...deps, laneSandbox });
  const nothing = (): Promise<void> => Promise.resolve();
  return async (input) => {
    const claude = input.harness === Provider.Claude;
    let base: ShapePrepared | null = null;
    let relayNote: string | null = null;
    if (input.relay && relayed !== null) {
      try {
        base = await relayed({ ...input, writes: true });
      } catch (error) {
        // The session starts without the builder's setup rather than not at all.
        logger.warn(
          { err: error, projectId: input.projectId },
          'a Full access relay could not be built',
        );
        relayNote = `Note from 10db: your plugins, instructions and MCP servers could not be brought into this session (${error instanceof Error ? error.message : String(error)}), so it runs without them.`;
      }
    }
    const broker = createPermissionBroker(
      { state, inbox, git: deps.git, logger },
      {
        projectId: input.projectId,
        workstreamId: null,
        conversationId: input.conversationId,
        ...(input.shapeId === undefined ? {} : { shapeId: input.shapeId }),
        sessionId: input.sessionId,
        observer: input.observer,
        signal: input.signal,
        mcpApproved: {},
        ...(input.limits === undefined ? {} : { limits: input.limits }),
      },
    );
    return {
      sandbox: null,
      projectMcpServers: claude ? {} : (base?.projectMcpServers ?? {}),
      yourMcpServers: base?.yourMcpServers ?? {},
      claudeConnectors: base?.claudeConnectors ?? false,
      note: base?.note ?? relayNote,
      credentialsExpireAt: base?.credentialsExpireAt ?? null,
      instructions: base?.instructions ?? null,
      setup: base?.setup ?? EMPTY_SETUP,
      canUseTool: claude || base === null ? broker : (req) => base.canUseTool(req),
      trackProcesses: () => undefined,
      markOwn: () => undefined,
      endJobs: nothing,
      release: base === null ? nothing : () => base.release(),
    };
  };
}

/**
 * Prepares a Linear reporter's session: the account's `mcp.linear.app` servers as a session plans them, and,
 * where there is a sandbox, a read-only one with no repo server, so a Codex session's shell reads at most. No
 * plugin, skill or instruction comes along, and nothing of the repository's own servers starts. Without a
 * sandbox a Claude session has no built-in tool to need one, and a Codex session is refused.
 */
export function createReporterPreparer(
  deps: Omit<SessionReadDeps, 'laneSandbox'> & { readonly laneSandbox: LaneSandbox | null },
): (input: {
  readonly projectId: ProjectId;
  readonly harness: Provider;
  readonly env: Readonly<Record<string, string>>;
}) => Promise<ReporterPrepared> {
  const { state } = deps;
  const { plan } = sessionReads(deps);
  return async (input) => {
    const project = getProject(state.db, input.projectId);
    const { yours, yourServers } = await plan(project);
    const linear = new Set(
      Object.entries(yours.remote)
        .filter(([, remote]) => isLinearServer(remote.url))
        .map(([name]) => name),
    );
    const yourMcpServers = Object.fromEntries(
      Object.entries(yourServers(undefined)).filter(([name]) => linear.has(name)),
    );
    let session: LaneSession | null = null;
    if (deps.laneSandbox !== null)
      session = await deps.laneSandbox.forSession({
        project,
        env: input.env,
        rules: [],
        resumeProviderSessionId: null,
        configDir: sessionConfigDir(input.harness, input.env, homedir()),
        checkouts: allCheckouts(state.db),
        mcpServers: {},
        readOnly: true,
        provider: input.harness,
        ...(input.harness === Provider.Codex ? { tempRoot: deps.codexLaneTempRoot } : {}),
      });
    else if (input.harness === Provider.Codex)
      throw new InvalidError('A ChatGPT session needs the sandbox, which this Mac has none of.');
    const sandboxed = session;
    let tracked = false;
    return {
      sandbox: sandboxed?.spec ?? null,
      yourMcpServers,
      credentialsExpireAt: null,
      track: (pid) => {
        tracked = true;
        void sandboxed?.trackProcesses({ pid, startedAt: null });
      },
      release: async () => {
        try {
          if (tracked) await sandboxed?.endProcesses();
        } catch (error) {
          deps.logger.warn(
            { err: error, projectId: project.id },
            'a reporter session left processes',
          );
        } finally {
          sandboxed?.dispose();
        }
      },
    };
  };
}
