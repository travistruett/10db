import { spawn } from 'node:child_process';
import { daemonGitArgs } from './daemon-config';
import { redactUrls } from './remote-url';

/** Each local git call; a call past it is killed and fails. */
export const GIT_TIMEOUT_MS = 60_000;
/** Output a local call may print before it is killed. */
const MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * The only `GIT_*` variables the daemon's git inherits. They choose which of the builder's own config
 * files git reads. Everything else that starts with `GIT_` is dropped: `GIT_DIR` and its kin would
 * aim git at another repository, `GIT_CONFIG` would hide the checkout's config from the allowlist
 * check, and `GIT_CONFIG_PARAMETERS` or `GIT_CONFIG_COUNT` would add config nobody judged.
 */
const KEPT_LOCAL: readonly string[] = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
];
/** A network call also keeps the transport settings of the builder's login environment. */
const KEPT_NETWORK: readonly string[] = [
  ...KEPT_LOCAL,
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_SSH_VARIANT',
  'GIT_ASKPASS',
];

/** Prompts are off whatever the environment says: nobody can answer one. */
export const NO_PROMPTS = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  LC_ALL: 'C',
} as const;

/**
 * Variables that make Xcode's `/usr/bin/git` shim pick another git on each spawn: dropped, so the git
 * that passed the probe is the git that runs.
 */
export const XCODE_SELECTORS: readonly string[] = ['DEVELOPER_DIR', 'SDKROOT', 'TOOLCHAINS'];

/** Config given on the command line through the environment: `GIT_CONFIG_COUNT` and its pairs, and `-c`'s. */
const COMMAND_CONFIG = /^GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/;

function keep(
  env: Readonly<Record<string, string | undefined>>,
  kept: readonly string[],
  keptPattern?: RegExp,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || XCODE_SELECTORS.includes(name)) continue;
    if (name.startsWith('GIT_') && !kept.includes(name) && !keptPattern?.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/** The environment of a local git call: the daemon's own, without its `GIT_*` variables. */
export function localGitEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    ...keep(process.env, KEPT_LOCAL),
    // No optional locks: a read would otherwise refresh the index under index.lock, and a commit
    // running at that moment fails with "index.lock: File exists".
    GIT_OPTIONAL_LOCKS: '0',
    ...NO_PROMPTS,
    ...extra,
  };
}

/**
 * The environment of a local call that reads the config a fetch or push in `login` would see: the
 * login environment's config selectors and its command-line config, then `extra`. The network call
 * itself drops that command-line config and is handed what it needs of it explicitly.
 */
function loginConfigEnv(
  login: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    ...keep(login, KEPT_NETWORK, COMMAND_CONFIG),
    GIT_OPTIONAL_LOCKS: '0',
    ...NO_PROMPTS,
    ...extra,
  };
}

/**
 * The environment of a fetch or push: the login environment without its other `GIT_*` variables,
 * then `extra`, such as the pinned `GIT_DIR`, set after the scrub.
 */
export function networkGitEnv(
  login: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { ...keep(login, KEPT_NETWORK), ...NO_PROMPTS, ...extra };
}

export class GitError extends Error {
  override readonly name = 'GitError';
  readonly args: readonly string[];
  readonly stderr: string;
  readonly exitCode: number | null;
  constructor(args: readonly string[], stderr: string, exitCode: number | null) {
    super(redactUrls(`git ${args.join(' ')} failed: ${stderr.trim().slice(0, 500)}`));
    this.args = args;
    this.stderr = redactUrls(stderr);
    this.exitCode = exitCode;
  }
}

export interface RunOptions {
  /** Extra variables, such as a private `GIT_INDEX_FILE`. */
  readonly env?: Readonly<Record<string, string>>;
  /** Written to git's stdin, which is otherwise closed. */
  readonly input?: string | Buffer;
  /** Config placed before `DAEMON_GIT_CONFIG`'s, as `-c` arguments. */
  readonly config?: readonly string[];
  /** Defaults to `GIT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** The git to run: the absolute path `resolveGit` found, never a name looked up on PATH. */
  readonly bin: string;
  /**
   * Run in this login environment instead of the daemon's own, keeping its command-line config, so
   * a config read sees what a fetch or push in it would.
   */
  readonly login?: Readonly<Record<string, string>>;
}

/**
 * Runs one local git call in `repo` with `DAEMON_GIT_CONFIG`, a cleaned environment and a timeout.
 * Resolves with stdout as bytes; rejects with a `GitError` on a non-zero exit, a timeout or too much
 * output. With `capBytes`, stdout beyond that many bytes is not wanted: the child is killed once it
 * has printed them, and what it printed so far resolves, whatever the child's exit.
 */
function runGitBytes(
  repo: string,
  args: readonly string[],
  opts: RunOptions,
  capBytes?: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      opts.bin,
      ['-C', repo, ...(opts.config ?? []), ...daemonGitArgs(), ...args],
      {
        env: opts.login ? loginConfigEnv(opts.login, opts.env) : localGitEnv(opts.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const out: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let failure: string | null = null;
    let capped = false;
    const kill = (why: string): void => {
      failure ??= why;
      child.kill('SIGKILL');
    };
    // A real timer on purpose: it bounds a real child process, so the injected clock does not apply.
    const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      kill(`still running after ${String(timeoutMs / 1000)} s`);
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (capBytes !== undefined) {
        if (capped) return;
        out.push(chunk.subarray(0, capBytes - size));
        size += chunk.length;
        if (size >= capBytes) {
          capped = true;
          child.kill('SIGKILL');
        }
        return;
      }
      size += chunk.length;
      if (size > MAX_OUTPUT) kill('printed too much');
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input ?? '');
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new GitError(args, error.message, null));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      if (failure !== null) reject(new GitError(args, failure, code));
      else if (capped || code === 0) resolve(stdout);
      else reject(new GitError(args, `${stderr}\n${stdout.toString('utf8')}`, code));
    });
  });
}

/** `runGitBytes` with stdout read as UTF-8. */
export async function runGit(
  repo: string,
  args: readonly string[],
  opts: RunOptions,
): Promise<string> {
  return (await runGitBytes(repo, args, opts)).toString('utf8');
}

/**
 * The first `capBytes` bytes of stdout, or all of it when it is shorter. A call that prints more is
 * killed once it has printed them, so a huge output is never held; the caller sees only that the
 * result is `capBytes` long.
 */
export function runGitCapped(
  repo: string,
  args: readonly string[],
  opts: RunOptions,
  capBytes: number,
): Promise<Buffer> {
  return runGitBytes(repo, args, opts, capBytes);
}
