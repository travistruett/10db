import { z } from 'zod';
import { prepareCommandEnv } from './command-env';
import { shellAssignments } from './env-file';
import { singleQuoted } from './posix-quote';
import { buildLaneProfile } from './profile';
import { projectWritableRoots, type ProjectAccess } from './project-access';
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

/** A repo stdio server as its approval allows it: command, arguments and approved variables, expanded. */
export interface StdioMcpServer {
  readonly command: string;
  readonly args: readonly string[];
  /** The variables the approval covers, expanded; the sandbox adds the lane allowlist. */
  readonly env: Readonly<Record<string, string>>;
}

const SandboxedMcpServerSchema = z
  .strictObject({
    type: z.literal('stdio'),
    command: z.literal(LAUNCHER),
    args: z.array(z.string()).readonly(),
  })
  .brand<'SandboxedMcpServer'>();

/**
 * A repo stdio server's launch under srt, in the shape Claude Code takes. Only this module makes
 * one, so a stdio server reaches Claude Code inside the sandbox or not at all.
 */
export type SandboxedMcpServer = z.infer<typeof SandboxedMcpServerSchema>;

export interface McpSandboxInput {
  readonly access: ProjectAccess;
  readonly home: string;
  readonly tmpRoot: string;
  readonly runtime: SandboxRuntime;
  readonly loopback: boolean;
  /** The session's launch env: only its allowlisted names reach a server. */
  readonly env: Readonly<Record<string, string>>;
  readonly checkouts: readonly string[];
  readonly servers: Readonly<Record<string, StdioMcpServer>>;
}

export interface McpSandboxes {
  readonly servers: Readonly<Record<string, SandboxedMcpServer>>;
  /** Removes every server's temp dir and files. Run it once the lane process is gone. */
  dispose(): void;
}

/**
 * One server's sandbox: its own temp dir, the only path it writes; the lanes' reads; no host at all,
 * since an approval names none, and loopback only by the project's switch. Its env is the lane
 * allowlist and its approved variables, sourced inside the sandbox from a sealed file, so no value
 * is on a command line. The command is srt's own child, so srt's TERM reaches it when Claude Code
 * stops the server; no verdict reads its exit status.
 */
function sandboxOne(
  server: StdioMcpServer,
  input: McpSandboxInput,
  removals: (() => void)[],
): SandboxedMcpServer {
  const { access, tmpRoot } = input;
  const tmpDir = createLaneTempDir(tmpRoot);
  removals.push(() => {
    removeLaneTempDir(tmpDir, tmpRoot);
  });
  const commandEnv = {
    ...allowlisted(input.env),
    TMPDIR: tmpDir,
    ...prepareCommandEnv(tmpDir, input.home, input.env),
    ...server.env,
  };
  const envFile = createSealedFile(
    tmpRoot,
    ENV_FILE,
    shellAssignments(commandEnv)
      .map((assignment) => `export ${assignment}\n`)
      .join(''),
  );
  removals.push(() => {
    removeSealedFile(envFile, tmpRoot, ENV_FILE);
  });
  const profile = buildLaneProfile({
    checkout: access.checkout,
    tmpDir,
    home: input.home,
    protectedReads: access.protectedReads,
    secretFiles: access.checkoutSecrets,
    toolchainSecrets: access.toolchain.secretFiles,
    toolchainReads: access.toolchain.reads,
    allowedDomains: [],
    readList: access.readList,
    extraReads: [envFile, ...access.gitReads],
    extraWrites: [],
    denyWrites: [...access.gitState, ...access.otherCheckouts, ...SRT_SHARED_TEMP],
    loopback: input.loopback,
    deniedEnvNames: [],
  });
  const settingsFile = createSealedFile(
    tmpRoot,
    SETTINGS_FILE,
    JSON.stringify(srtSettings(profile), null, 2),
  );
  removals.push(() => {
    removeSealedFile(settingsFile, tmpRoot, SETTINGS_FILE);
  });
  const inner = [
    'exec /usr/bin/env -i /bin/sh -c',
    singleQuoted('. "$0" && exec "$@"'),
    singleQuoted(envFile),
    ...[server.command, ...server.args].map(singleQuoted),
  ].join(' ');
  return SandboxedMcpServerSchema.parse({
    type: 'stdio',
    command: LAUNCHER,
    args: [
      '-i',
      `PATH=${HOST_PATH}`,
      `HOME=${input.home}`,
      `CLAUDE_CODE_TMPDIR=${tmpDir}`,
      input.runtime.node,
      input.runtime.cli,
      '--settings',
      settingsFile,
      '-c',
      inner,
    ],
  });
}

/** Sandboxes each of a session's repo stdio servers; with none, makes nothing and checks no srt. */
export function sandboxMcpServers(input: McpSandboxInput): McpSandboxes {
  const entries = Object.entries(input.servers);
  if (entries.length === 0) return { servers: {}, dispose: () => undefined };
  checkRuntime(input.runtime, projectWritableRoots(input.checkouts, input.tmpRoot));
  const removals: (() => void)[] = [];
  try {
    const servers: Record<string, SandboxedMcpServer> = {};
    for (const [name, server] of entries) servers[name] = sandboxOne(server, input, removals);
    return {
      servers,
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
