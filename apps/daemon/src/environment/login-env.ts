import { spawn } from 'node:child_process';
import { systemClock, type Clock, type Timer } from '../clock';
import { withoutGitRepoEnv } from '../git';

/** Printed by the capture command just before `env -0`; everything before it is profile noise. */
export const LOGIN_ENV_MARKER = '__10DB_ENV_BEGIN__';
const LOGIN_SHELL_TIMEOUT_MS = 10_000;
/** After the shell exits, how long to wait for its stdout to close (a profile may leave a child holding it). */
const DRAIN_MS = 500;
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The builder's login environment. It holds secrets, so it lives in daemon memory only. */
export interface LoginEnv {
  readonly vars: Readonly<Record<string, string>>;
  readonly source: 'login_shell' | 'inherited';
  readonly warning: string | null;
}

export function parseEnvBlock(output: string): Record<string, string> {
  const start = output.indexOf(`${LOGIN_ENV_MARKER}\0`);
  if (start === -1) return {};
  const vars: Record<string, string> = {};
  for (const entry of output.slice(start + LOGIN_ENV_MARKER.length + 1).split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const name = entry.slice(0, eq);
    if (VARIABLE_NAME.test(name)) vars[name] = entry.slice(eq + 1);
  }
  return vars;
}

function definedOnly(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group already exited.
  }
}

/**
 * Runs `$SHELL -l -i -c` once and reads its environment. Login plus interactive matches what a
 * terminal sees (zsh reads .zshrc only for interactive shells). Profiles may print banners or
 * hang, so output before the marker is ignored and the whole process group is killed at the timeout.
 * Any failure falls back to the inherited environment with a warning that names no values.
 */
export function captureLoginEnv(opts: {
  readonly inherited: Readonly<Record<string, string | undefined>>;
  readonly shell?: string;
  readonly timeoutMs?: number;
  readonly clock?: Clock;
}): Promise<LoginEnv> {
  // A daemon started from a git hook inherits GIT_DIR and friends: a profile's git prompt or plugin
  // would run against that repository, and the captured environment would carry them on.
  const inherited = withoutGitRepoEnv(definedOnly(opts.inherited));
  const shell = opts.shell ?? inherited['SHELL'] ?? '/bin/zsh';
  const timeoutMs = opts.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS;
  const clock = opts.clock ?? systemClock;
  const fallback = (problem: string): LoginEnv => ({
    vars: inherited,
    source: 'inherited',
    warning: `${problem}; using the environment 10db was started with`,
  });

  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    let drain: Timer | null = null;
    const child = spawn(shell, ['-l', '-i', '-c', `printf '%s\\0' ${LOGIN_ENV_MARKER}; env -0`], {
      env: inherited,
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    const finish = (result: LoginEnv): void => {
      if (settled) return;
      settled = true;
      timer.cancel();
      drain?.cancel();
      resolve(result);
    };
    const parse = (code: number | null): void => {
      const vars = parseEnvBlock(output);
      if (Object.keys(vars).length > 0) finish({ vars, source: 'login_shell', warning: null });
      else
        finish(
          fallback(
            `The login shell (${shell}) exited with code ${String(code)} without printing its environment`,
          ),
        );
    };
    const timer = clock.setTimeout(() => {
      killGroup(child.pid);
      finish(
        fallback(`The login shell (${shell}) did not finish within ${String(timeoutMs / 1000)} s`),
      );
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (output.length < MAX_OUTPUT_CHARS) output += chunk;
    });
    child.once('error', (error) => {
      // Spawn errors carry an errno code such as ENOENT; the message can echo arguments, so it isn't used.
      finish(
        fallback(
          `The login shell (${shell}) could not start (${(error as NodeJS.ErrnoException).code ?? error.name})`,
        ),
      );
    });
    child.once('exit', (code) => {
      // After a timeout the group is already killed and the result is in.
      if (settled) return;
      drain = clock.setTimeout(() => {
        killGroup(child.pid);
        parse(code);
      }, DRAIN_MS);
    });
    child.once('close', (code) => {
      parse(code);
    });
  });
}
