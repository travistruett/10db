import { accessSync, constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { shellAssignments } from './env-file';
import { underLaneWritable, type LaneWritableRoot } from './lane-writable';
import type { McpLaunch } from './mcp-sandbox';
import { SandboxProfileError } from './profile';
import { createSealedFile, removeSealedFile, type SealedFileKind } from './sealed-file';
import { HOST_PATH } from './srt-launch';
import { removeAll } from './temp-dir';

/**
 * One of the builder's stdio servers as a session runs it, expanded: the structural shape the sandbox
 * takes, so it imports nothing from `session-setup`.
 */
export interface UnsandboxedStdioServer {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | null;
  /** The whole environment the server gets, the login environment's included. */
  readonly env: Readonly<Record<string, string>>;
  /** The variables the entry itself set. */
  readonly declaredEnv: readonly string[];
}

/** Variables that make a program load code, or trust a certificate, from a path they name. */
const LOADS_CODE = new Set([
  'PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'PYTHONINSPECT',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'CLASSPATH',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'GIT_SSH_COMMAND',
  'GIT_EXEC_PATH',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SUDO_ASKPASS',
  'KUBECONFIG',
  'AWS_CONFIG_FILE',
  'DOCKER_CONFIG',
  'XDG_CONFIG_HOME',
  'PYTHONUSERBASE',
  'PYTHONPYCACHEPREFIX',
]);
const LOADS_CODE_PREFIXES = [
  'DYLD_',
  'LD_',
  'GIT_CONFIG_',
  'npm_config_',
  'NPM_CONFIG_',
  'PIP_',
  'UV_',
  'GEM_',
  'BUNDLE_',
  'MISE_',
] as const;

/** Whether a variable can make a program load code from a path in its value. */
export function loadsCode(name: string): boolean {
  return LOADS_CODE.has(name) || LOADS_CODE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

const SUFFIX =
  ", which an agent can write. Run it from a project's .mcp.json instead, where 10db sandboxes it.";

/** Characters a path can be set off by inside an option, a list or a variable's value. */
const SEPARATORS = /[=,:;"'`()[\]{}<>|&!\s]+/;

/**
 * Every path `text` could name: each piece split on separators and quotes, as written (so a bare relative
 * one is judged against the folder the server starts in), from its first `/` or `~/` on, and after any
 * leading flag, so a path glued to a flag (`-I/root`, `-rsome/x.js`) is read too.
 */
function pathPieces(text: string): string[] {
  const pieces: string[] = [];
  for (const piece of text.split(SEPARATORS)) {
    if (piece === '') continue;
    pieces.push(piece);
    for (const start of [piece.indexOf('/'), piece.indexOf('~/')]) {
      if (start > 0) pieces.push(piece.slice(start));
    }
    // A path glued to a flag: `-I../root`, `-rsome/x.js`, `--include../root`.
    const flag = /^-{1,2}[A-Za-z0-9_-]*/.exec(piece);
    if (flag !== null) {
      for (let at = 1; at <= flag[0].length; at += 1) pieces.push(piece.slice(at));
    }
  }
  return pieces;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function canHold(name: string, value: string): boolean {
  try {
    shellAssignments({ [name]: value });
    return true;
  } catch (error) {
    if (error instanceof SandboxProfileError) return false;
    throw error;
  }
}

/**
 * Prepares one of the builder's stdio servers to run outside the sandbox, from the builder's home. It
 * refuses a server whose command, a path argument, an argument holding a lane-writable root, its working
 * folder or a declared code-loading variable lies where a lane can write, existing or not, naming the field
 * and never its value. It cleans what the login environment brought: PATH keeps only absolute entries no
 * lane can write, and a code-loading variable that points where a lane can write, or a variable a sealed
 * file can't hold, is dropped and named.
 */
export function prepareYourMcpRun(
  server: UnsandboxedStdioServer,
  ctx: { readonly home: string; readonly laneWritable: readonly LaneWritableRoot[] },
): { refusal: string | null; env: Record<string, string>; dropped: string[] } {
  const { home, laneWritable } = ctx;
  const fromHome = (path: string): string =>
    path.startsWith('~/') ? join(home, path.slice(2)) : path;
  const declared = new Set(server.declaredEnv);
  const cwd = server.cwd === null ? home : resolve(home, fromHome(server.cwd));
  const under = (path: string): string | null =>
    underLaneWritable(fromHome(path), laneWritable, cwd);
  const pointsInto = (value: string): string | null => {
    for (const part of pathPieces(value)) {
      const kind = under(part);
      if (kind !== null) return kind;
    }
    return null;
  };

  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(server.env)) {
    if (declared.has(name) || name === 'PATH' || name === 'HOME') {
      env[name] = value;
      continue;
    }
    if ((loadsCode(name) && pointsInto(value) !== null) || !canHold(name, value)) {
      dropped.push(name);
      continue;
    }
    env[name] = value;
  }
  if (!declared.has('PATH')) {
    const kept = (server.env['PATH'] ?? '')
      .split(':')
      .filter(
        (entry) => isAbsolute(entry) && underLaneWritable(entry, laneWritable, home) === null,
      );
    env['PATH'] = kept.length === 0 ? HOST_PATH : kept.join(':');
  }
  env['HOME'] = home;

  const refuse = (
    field: string,
    kind: string,
  ): { refusal: string; env: typeof env; dropped: string[] } => ({
    refusal: `Its ${field} points at ${kind}${SUFFIX}`,
    env,
    dropped,
  });

  if (server.cwd !== null) {
    const kind = underLaneWritable(cwd, laneWritable, home);
    if (kind !== null) return refuse('working folder', kind);
  }

  const command = fromHome(server.command);
  let resolved: string | null;
  if (isAbsolute(command) || command.includes('/')) resolved = resolve(cwd, command);
  else
    resolved =
      (env['PATH'] ?? '')
        .split(':')
        .filter((entry) => entry !== '')
        .map((entry) => resolve(cwd, entry, command))
        .find(isExecutable) ?? null;
  // A command not found is not refused: the server fails to connect, and the note says so.
  const commandKind = resolved === null ? null : underLaneWritable(resolved, laneWritable, cwd);
  if (commandKind !== null) return refuse('command', commandKind);

  for (const [index, arg] of server.args.entries()) {
    const field = `argument ${String(index + 1)}`;
    const kind = pointsInto(arg);
    if (kind !== null) return refuse(field, kind);
  }

  for (const name of server.declaredEnv) {
    const value = server.env[name];
    if (value === undefined) continue;
    if (loadsCode(name)) {
      const kind = pointsInto(value);
      if (kind !== null) return refuse(name, kind);
    }
    if (!canHold(name, value))
      return { refusal: `Its env variable ${name} can't be passed to it.`, env, dropped };
  }
  return { refusal: null, env, dropped };
}

const ENV_FILE: SealedFileKind = {
  prefix: '10db-ymcp-',
  suffix: '.sh',
  what: 'your MCP server env file',
};

/** Claude Code and Codex merge their own environment into a server's, so `env -i` drops it first. */
const LAUNCHER = '/usr/bin/env';
/** Changes to the server's folder, sources its sealed env file, and runs it: `$0` is the file, `$1` the folder. */
const START = 'cd -- "$1" && . "$0" && shift && exec "$@"';

/** The constructor's key. Never exported, so no other module can make a `YourMcpServer`. */
const MADE_HERE: unique symbol = Symbol('YourMcpServer');

/**
 * One of the builder's stdio servers as it starts outside the sandbox, from the builder's home with its
 * sealed env. The launch is a private field, so a look-alike carries none.
 */
export class YourMcpServer {
  readonly #launch: McpLaunch;

  constructor(key: typeof MADE_HERE, launch: McpLaunch) {
    if (key !== MADE_HERE) {
      throw new SandboxProfileError('mcp', "only the sandbox makes a builder's MCP server launch");
    }
    this.#launch = { command: launch.command, args: Object.freeze([...launch.args]) };
  }

  /** What Claude Code or Codex runs: a fresh copy each time. */
  launch(): McpLaunch {
    return { command: this.#launch.command, args: [...this.#launch.args] };
  }
}

/**
 * Each of the builder's stdio servers that may run, as a launch through `env -i` from the home. Its env is
 * in a sealed file in the files root, so no value is on its command line and its folder is never a
 * checkout. A refused server gets no file and a left-out item; a dropped login variable adds one too.
 * `dispose()` removes the files. Never srt: these run as Claude Code runs them.
 */
export function launchYourMcpServers(input: {
  readonly home: string;
  readonly filesRoot: string;
  readonly laneWritable: readonly LaneWritableRoot[];
  readonly servers: Readonly<Record<string, UnsandboxedStdioServer>>;
}): {
  servers: Record<string, YourMcpServer>;
  leftOut: { what: string; why: string }[];
  dispose(): void;
} {
  const servers: Record<string, YourMcpServer> = {};
  const leftOut: { what: string; why: string }[] = [];
  const removals: (() => void)[] = [];
  const dispose = (): void => {
    removeAll(removals.splice(0));
  };
  try {
    for (const [name, server] of Object.entries(input.servers)) {
      const what = `your MCP server ${name}`;
      const prepared = prepareYourMcpRun(server, input);
      if (prepared.refusal !== null) {
        leftOut.push({ what, why: prepared.refusal });
        continue;
      }
      if (prepared.dropped.length > 0)
        leftOut.push({
          what,
          why: `it runs without ${prepared.dropped.join(', ')} from your login environment, which point where an agent can write or can't be passed`,
        });
      const envFile = createSealedFile(
        input.filesRoot,
        ENV_FILE,
        shellAssignments(prepared.env)
          .map((assignment) => `export ${assignment}\n`)
          .join(''),
      );
      removals.push(() => {
        removeSealedFile(envFile, input.filesRoot, ENV_FILE);
      });
      const fromHome = (path: string): string =>
        path.startsWith('~/') ? join(input.home, path.slice(2)) : path;
      const cwd = server.cwd === null ? input.home : resolve(input.home, fromHome(server.cwd));
      servers[name] = new YourMcpServer(MADE_HERE, {
        command: LAUNCHER,
        args: [
          '-i',
          `PATH=${HOST_PATH}`,
          `HOME=${input.home}`,
          '/bin/sh',
          '-c',
          START,
          envFile,
          cwd,
          fromHome(server.command),
          ...server.args,
        ],
      });
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return { servers, leftOut, dispose };
}
