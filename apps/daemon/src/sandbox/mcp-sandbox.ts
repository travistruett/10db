import type { Clock } from '../clock';
import { prepareCommandEnv } from './command-env';
import { shellAssignments } from './env-file';
import {
  createRefusalLog,
  REFUSAL_LOG,
  REFUSAL_PRELOAD,
  refusalPreload,
  watchRefusals,
} from './mcp-refusals';
import { singleQuoted } from './posix-quote';
import { buildLaneProfile, SandboxProfileError } from './profile';
import type { ProjectAccess } from './project-access';
import { createSealedFile, removeSealedFile, type SealedFileKind } from './sealed-file';
import {
  allowlisted,
  checkRuntime,
  HOST_PATH,
  SRT_SHARED_TEMP,
  type SandboxRuntime,
} from './srt-launch';
import { srtSettings } from './srt-settings';
import { createLaneTempDir, removeAll, removeLaneTempDir } from './temp-dir';

/**
 * What Claude Code runs for a repo stdio server. Claude Code merges its own environment, the
 * session's credentials among them, into the server's, so `env -i` drops it before srt's host starts.
 */
const LAUNCHER = '/usr/bin/env';
const SETTINGS_FILE: SealedFileKind = {
  prefix: '10db-mcp-',
  suffix: '.json',
  what: 'an MCP server sandbox settings file',
};
const ENV_FILE: SealedFileKind = {
  prefix: '10db-mcp-',
  suffix: '.sh',
  what: 'an MCP server env file',
};
/**
 * The variables srt points its child at its proxy with, the only way out to an approved host. The
 * inner `env -i` keeps them, by name: their URLs hold srt's proxy token, which srt itself puts on
 * `env`'s command line for the instant before it execs, and this hand-on is no longer than that.
 */
const SRT_PROXY_ENV = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'GRPC_PROXY',
  'grpc_proxy',
] as const;

/** A repo stdio server as its approval allows it: command, arguments and approved variables, expanded. */
export interface StdioMcpServer {
  readonly command: string;
  readonly args: readonly string[];
  /** The variables the approval covers, expanded; the sandbox adds the lane allowlist. */
  readonly env: Readonly<Record<string, string>>;
  /** The hosts the approval names: the only ones its sandbox reaches. */
  readonly hosts: readonly string[];
}

/** A command and its arguments, as Claude Code starts a stdio server. */
export interface McpLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/** The constructor's key. Never exported, so no other module can make a `SandboxedMcpServer`. */
const MADE_HERE: unique symbol = Symbol('SandboxedMcpServer');

/**
 * A repo stdio server's launch under srt. The launch is a private field, so a copy or a look-alike
 * carries none and doesn't typecheck as one: a stdio server reaches Claude Code inside the sandbox
 * or not at all.
 */
export class SandboxedMcpServer {
  readonly #launch: McpLaunch;

  constructor(key: typeof MADE_HERE, launch: McpLaunch) {
    if (key !== MADE_HERE) {
      throw new SandboxProfileError('mcp', 'only the lane sandbox makes a sandboxed MCP server');
    }
    this.#launch = { command: launch.command, args: Object.freeze([...launch.args]) };
  }

  /** What Claude Code runs: a fresh copy each time. */
  launch(): McpLaunch {
    return { command: this.#launch.command, args: [...this.#launch.args] };
  }
}

export interface McpSandboxInput {
  readonly access: ProjectAccess;
  readonly home: string;
  /** Where each server's temp dir is made. */
  readonly tmpRoot: string;
  /** Where each server's sealed env and settings files are made, outside every temp dir. */
  readonly filesRoot: string;
  /** Every root closed to a server's sandbox but for its own temp dir and env file. */
  readonly sandboxRoots: readonly string[];
  readonly runtime: SandboxRuntime;
  /** The session's launch env: only its allowlisted names reach a server. */
  readonly env: Readonly<Record<string, string>>;
  readonly checkouts: readonly string[];
  readonly servers: Readonly<Record<string, StdioMcpServer>>;
  /** Told, with the server's name and the host, each time srt's proxy refuses a host. */
  readonly log?: RefusalLog;
  /** Paces the reading of each server's refusal log. */
  readonly clock?: Clock;
}

/** The daemon's logger, as far as the MCP sandbox tells it what a server was refused. */
export interface RefusalLog {
  warn(fields: object, message: string): void;
}

/** The log line for a host the proxy refused a server; the fields are `server` and `host`. */
export const REFUSED_MESSAGE =
  "mcp server was refused a host its approval doesn't list; add the host to its entry in .10db/mcp-hosts.json";

/** A server the sandbox couldn't build, left out of the session. The message names no value. */
export interface McpSandboxFailure {
  readonly name: string;
  readonly message: string;
}

export interface McpSandboxes {
  readonly servers: Readonly<Record<string, SandboxedMcpServer>>;
  readonly failures: readonly McpSandboxFailure[];
  /** Removes every server's temp dir and files. Run it once the lane process is gone. */
  dispose(): void;
}

/**
 * One server's sandbox: its own temp dir, the only path it writes; the lanes' reads; the hosts its
 * approval names and no others, the project's included, and no loopback. Its env is the lane allowlist,
 * its approved variables and srt's proxy variables; the approved ones are sourced inside the sandbox
 * from a sealed file, so no approved value is on a command line. The
 * command is srt's own child, so srt's TERM reaches it when Claude Code stops the server; no verdict
 * reads its exit status.
 */
function sandboxOne(
  name: string,
  server: StdioMcpServer,
  input: McpSandboxInput,
  removals: (() => void)[],
): SandboxedMcpServer {
  const { access, tmpRoot, filesRoot } = input;
  const tmpDir = createLaneTempDir(tmpRoot);
  removals.push(() => {
    removeLaneTempDir(tmpDir, tmpRoot);
  });
  const commandEnv = {
    ...allowlisted(input.env),
    TMPDIR: tmpDir,
    ...prepareCommandEnv(tmpDir, input.home, input.env),
    // Node's own fetch takes srt's proxy only when told to; other clients read the proxy variables.
    NODE_USE_ENV_PROXY: '1',
    ...server.env,
  };
  const envFile = createSealedFile(
    filesRoot,
    ENV_FILE,
    shellAssignments(commandEnv)
      .map((assignment) => `export ${assignment}\n`)
      .join(''),
  );
  removals.push(() => {
    removeSealedFile(envFile, filesRoot, ENV_FILE);
  });
  const profile = buildLaneProfile({
    checkout: access.checkout,
    tmpDir,
    home: input.home,
    protectedReads: access.protectedReads,
    secretFiles: access.checkoutSecrets,
    toolchainSecrets: access.toolchain.secretFiles,
    toolchainReads: access.toolchain.reads,
    toolchainListings: access.toolchain.listings,
    allowedDomains: server.hosts,
    readList: access.readList,
    extraReads: [envFile, ...access.gitReads],
    extraWrites: [],
    denyWrites: [
      ...access.gitState,
      ...access.otherCheckouts,
      ...SRT_SHARED_TEMP,
      ...access.pinnedTools,
    ],
    sandboxRoots: input.sandboxRoots,
    ownFiles: [envFile],
    setupReads: [],
    setupSecrets: [],
    // Never, whatever the project's switch: on localhost listen other sandboxes' proxies, and
    // through them the hosts an approval withholds.
    loopback: false,
    deniedEnvNames: [],
    // A server's HTTP client reads the system's proxy settings through configd as it starts; uv
    // crashes without it. It answers what the network is set to and opens no route out of the proxy.
    machLookups: ['com.apple.SystemConfiguration.configd'],
  });
  const settingsFile = createSealedFile(
    filesRoot,
    SETTINGS_FILE,
    JSON.stringify(srtSettings(profile), null, 2),
  );
  removals.push(() => {
    removeSealedFile(settingsFile, filesRoot, SETTINGS_FILE);
  });
  // srt's proxy says which host it refused only in its debug log; the preload carries that out to a
  // log the daemon reads, so the daemon log names the server and the host. Both are in the files root
  // with the server's other files: the preload is code srt's host runs outside every sandbox.
  const refusalLog = createRefusalLog(filesRoot);
  removals.push(
    watchRefusals(
      refusalLog,
      (host) => {
        input.log?.warn({ server: name, host }, REFUSED_MESSAGE);
      },
      input.clock,
    ),
    () => {
      removeSealedFile(refusalLog, filesRoot, REFUSAL_LOG);
    },
  );
  const preload = createSealedFile(filesRoot, REFUSAL_PRELOAD, refusalPreload(refusalLog));
  removals.push(() => {
    removeSealedFile(preload, filesRoot, REFUSAL_PRELOAD);
  });
  const inner = [
    'exec /usr/bin/env -i',
    ...SRT_PROXY_ENV.map((name) => `${name}="$${name}"`),
    '/bin/sh -c',
    singleQuoted('. "$0" && exec "$@"'),
    singleQuoted(envFile),
    ...[server.command, ...server.args].map(singleQuoted),
  ].join(' ');
  return new SandboxedMcpServer(MADE_HERE, {
    command: LAUNCHER,
    args: [
      '-i',
      `PATH=${HOST_PATH}`,
      `HOME=${input.home}`,
      `CLAUDE_CODE_TMPDIR=${tmpDir}`,
      'SRT_DEBUG=1',
      input.runtime.node,
      '-r',
      preload,
      input.runtime.cli,
      '--settings',
      settingsFile,
      '-c',
      inner,
    ],
  });
}

/**
 * Sandboxes each of a session's repo stdio servers; with none, makes nothing and checks no srt. A
 * server whose profile is refused (an approved value the env file can't hold) is left out and
 * reported, so it never stops the session or the other servers.
 */
export function sandboxMcpServers(input: McpSandboxInput): McpSandboxes {
  const entries = Object.entries(input.servers);
  if (entries.length === 0) return { servers: {}, failures: [], dispose: () => undefined };
  checkRuntime(input.runtime, input.access.writableRoots);
  const removals: (() => void)[] = [];
  try {
    const servers: Record<string, SandboxedMcpServer> = {};
    const failures: McpSandboxFailure[] = [];
    for (const [name, server] of entries) {
      const own: (() => void)[] = [];
      try {
        servers[name] = sandboxOne(name, server, input, own);
        removals.push(...own);
      } catch (error) {
        try {
          removeAll(own);
        } catch {
          // Whatever stuck goes with the session's dispose.
          removals.push(...own);
        }
        if (!(error instanceof SandboxProfileError)) throw error;
        failures.push({ name, message: `Its sandbox could not be built: ${error.message}` });
      }
    }
    return {
      servers,
      failures,
      dispose: () => {
        removeAll(removals);
      },
    };
  } catch (error) {
    try {
      removeAll(removals);
    } catch {
      // The error that stopped the session is the one to report.
    }
    throw error;
  }
}
