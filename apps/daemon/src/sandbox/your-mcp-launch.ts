import { accessSync, constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { foldPathCase } from '../guard';
import { shellAssignments } from './env-file';
import { underLaneWritable, type LaneWritableRoot } from './lane-writable';
import { SandboxProfileError } from './profile';
import { HOST_PATH } from './srt-launch';

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
] as const;

/** Whether a variable can make a program load code from a path in its value. */
export function loadsCode(name: string): boolean {
  return LOADS_CODE.has(name) || LOADS_CODE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

const SUFFIX =
  ", which an agent can write. Run it from a project's .mcp.json instead, where 10db sandboxes it.";

/** A path written as a path: absolute, from the home, or relative with `./` or `../`. */
const looksLikePath = (text: string): boolean =>
  isAbsolute(text) || text.startsWith('~/') || text.startsWith('./') || text.startsWith('../');

/** Characters around a path held inside other text, such as `--opt=a,/path/b`. */
const BEFORE = String.raw`(?:^|[=,:;"'\s(])`;
const AFTER = String.raw`(?:$|[/,:;"'\s)])`;
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function holdsRoot(text: string, roots: readonly LaneWritableRoot[]): LaneWritableRoot | null {
  const folded = foldPathCase(text);
  return (
    roots.find((root) =>
      new RegExp(`${BEFORE}${escaped(foldPathCase(root.path))}${AFTER}`).test(folded),
    ) ?? null
  );
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
    for (const part of value.split(/[:\s=]+/)) {
      if (part === '') continue;
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
    const after = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : null;
    const candidates = [arg, ...(after === null ? [] : [after])].filter(looksLikePath);
    for (const candidate of candidates) {
      const kind = under(candidate);
      if (kind !== null) return refuse(field, kind);
    }
    const held = holdsRoot(arg, laneWritable);
    if (held !== null) return refuse(field, held.kind);
  }

  if (server.cwd !== null) {
    const kind = underLaneWritable(cwd, laneWritable, home);
    if (kind !== null) return refuse('working folder', kind);
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
