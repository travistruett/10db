import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIPv6 } from 'node:net';
import { homedir } from 'node:os';
import type { ProjectDto } from '@10db/contracts';
import { getProject, listPermissionRules } from '@10db/db';
import { allCheckouts } from '../delivery';
import { trustSwitchesFor } from '../permissions';
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
import { EMPTY_SETUP, fileAccessJudge, type LaneSandbox, type LaneSession } from '../sandbox';
import { leftOutNote, planSessionSetup } from '../session-setup';
import { skippedServersNote, splitProjectMcp, type ProjectMcp } from '../sessions';
import { privateHostProblem, type ShapePrepareInput, type ShapePrepared } from '../shape';

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
export function createShapePreparer(deps: {
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
}): (input: ShapePrepareInput) => Promise<ShapePrepared> {
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

  return async (input) => {
    const project = getProject(state.db, input.projectId);
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
    // Read when each session is prepared: a switch flipped meanwhile applies from the next one.
    const setupPlan = planSessionSetup({
      home: deps.builderHome,
      checkout: project.repoPath,
      switches: trustSwitchesFor(state.db, project.id),
      laneWritable: [...allCheckouts(state.db), ...deps.laneWritableRoots],
    });
    const instructions = setupPlan.instructions.text;
    let session: LaneSession;
    try {
      session = await deps.laneSandbox.forSession({
        setup: setupPlan.input,
        project,
        env: input.env,
        // A conversation has no workstream: only the project's own rules hold.
        rules: listPermissionRules(state.db, project.id, null),
        resumeProviderSessionId: input.resumeProviderSessionId,
        configDir: sessionConfigDir(input.accountKind, input.env, homedir()),
        checkouts: allCheckouts(state.db),
        mcpServers: servers.stdio,
        readOnly: true,
      });
    } catch (error) {
      logger.warn({ err: error, projectId: project.id }, 'a Plan sandbox could not be built');
      return {
        sandbox: null,
        projectMcpServers: {},
        note: [
          `Note from 10db: this session has no sandbox (${error instanceof Error ? error.message : String(error)}), so it runs no command and has no project MCP server. ${INSTEAD}`,
          leftOutNote(setupPlan.leftOut),
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
          }),
        trackProcesses: () => undefined,
        release: () => Promise.resolve(),
      };
    }
    const sandboxed = session;
    // Every way out from here leaves the sandbox removed: its sealed files can hold AWS credentials.
    try {
      for (const failure of sandboxed.mcpFailures) flagMcpFailure(inbox, project.id, null, failure);
      const broker = createPermissionBroker(
        { state, inbox, git: deps.git, logger },
        {
          projectId: project.id,
          workstreamId: null,
          shapeId: input.shapeId,
          sessionId: input.sessionId,
          observer: input.observer,
          signal: input.signal,
          mcpApproved: projectMcp.configHashes,
          sandbox: { fileAccess: sandboxed.fileAccess, hazards: [], commandsAsk: true },
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
        note:
          [problem, skipped, leftOutNote([...setupPlan.leftOut, ...sandboxed.setup.leftOut])]
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
