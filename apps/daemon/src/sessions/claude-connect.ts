import { spawn } from 'node:child_process';
import { systemClock, type Clock } from '../clock';
import type { Logger } from '../log';
import { stopLoginProcess } from './login-stop';
import {
  LOGIN_MS,
  type AccountLogin,
  type AccountLoginOutcome,
  type AccountProbeSpec,
} from './types';

/** The part of a child process a sign-in uses, so a test can stand in for `claude`. */
export interface LoginProcess {
  /** Signals the process; it ends on SIGTERM unless it ignores it, and always on SIGKILL. */
  kill(signal: NodeJS.Signals): void;
  /** A process that could not start is reported as an exit with a null code. */
  onExit(listener: (code: number | null) => void): void;
}

export type LoginSpawn = (
  file: string,
  args: readonly string[],
  options: { readonly env: Readonly<Record<string, string>>; readonly cwd: string },
) => LoginProcess;

export interface ClaudeLoginOptions {
  /** The builder's installed claude, as the daemon resolved it; the login shell's PATH is never searched. */
  readonly claudePath: string;
  readonly logger: Pick<Logger, 'warn'>;
  readonly spawn?: LoginSpawn;
  readonly clock?: Clock;
}

/** Runs the real `claude`; its environment is exactly `env`, it has no stdin and its output is dropped. */
export const spawnLogin: LoginSpawn = (file, args, { env, cwd }) => {
  const child = spawn(file, [...args], { env: { ...env }, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  // Nothing it prints is kept: it can hold a sign-in address or an email. Unread pipes would block it.
  child.stdout.resume();
  child.stderr.resume();
  const listeners: ((code: number | null) => void)[] = [];
  let ended = false;
  const end = (code: number | null): void => {
    if (ended) return;
    ended = true;
    for (const listener of listeners) listener(code);
  };
  child.on('exit', end);
  child.on('error', () => {
    end(null);
  });
  return {
    kill: (signal) => {
      child.kill(signal);
    },
    onExit: (listener) => {
      listeners.push(listener);
    },
  };
};

/**
 * Runs `claude auth login --claudeai` on the account's launch environment, so the login lands in the
 * account's own config directory. The CLI opens the browser itself and names no page for 10db to open.
 * It has no protocol: exit 0 is a finished sign-in, any other end a failure. The child is stopped on
 * cancel and after `LOGIN_MS`, which also ends one that waits on input it will never get, and the outcome
 * settles once it has exited. What it prints is dropped, so the outcome carries fixed messages and the
 * log only an exit code.
 */
export function startClaudeLogin(
  login: AccountProbeSpec,
  opts: ClaudeLoginOptions,
): Promise<AccountLogin> {
  const clock = opts.clock ?? systemClock;
  const child = (opts.spawn ?? spawnLogin)(opts.claudePath, ['auth', 'login', '--claudeai'], {
    env: login.env,
    cwd: login.cwd,
  });
  let settled = false;
  let exited = false;
  let resolveOutcome: (outcome: AccountLoginOutcome) => void = () => undefined;
  const outcome = new Promise<AccountLoginOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const exitedPromise = new Promise<void>((resolve) => {
    child.onExit(() => {
      exited = true;
      resolve();
    });
  });
  const settle = (result: AccountLoginOutcome): void => {
    if (settled) return;
    settled = true;
    deadline.cancel();
    if (exited) {
      resolveOutcome(result);
      return;
    }
    void stopLoginProcess(
      {
        kill: (signal) => {
          child.kill(signal);
        },
        exited: exitedPromise,
      },
      clock,
    ).then(() => {
      resolveOutcome(result);
    });
  };
  const deadline = clock.setTimeout(() => {
    settle({ ok: false, message: 'The sign-in took too long. Try Connect again.' });
  }, LOGIN_MS);
  child.onExit((code) => {
    if (code !== 0) opts.logger.warn({ code }, 'claude auth login ended without signing in');
    settle(
      code === 0
        ? { ok: true }
        : { ok: false, message: 'Claude Code did not finish the sign-in. Try Connect again.' },
    );
  });
  return Promise.resolve({
    authUrl: null,
    outcome,
    async cancel() {
      settle({ ok: false, message: 'The sign-in was cancelled.' });
      await outcome;
    },
  });
}
