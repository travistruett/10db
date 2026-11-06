import { execFile } from 'node:child_process';
import type { SignInState } from './sign-in-check';

/** How long `codex login status` may take. It reads a file, but a loaded Mac can still make it slow. */
const LOGIN_STATUS_MS = 20_000;

const NOT_LOGGED_IN = /not logged in/i;

/**
 * Runs `codex login status` with the session's env. Exit 0 is signed in; exit 1 that says "Not logged
 * in" is signed out. Anything else (a timeout, a kill, a failed spawn, another exit) is `unknown`,
 * never a guess. The output is only matched, never kept or returned.
 */
export function codexLoginStatus(
  codexPath: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number = LOGIN_STATUS_MS,
): Promise<SignInState> {
  return new Promise((resolve) => {
    execFile(
      codexPath,
      ['login', 'status'],
      { env: { ...env }, timeout: timeoutMs, maxBuffer: 1_000_000 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve('signed_in');
          return;
        }
        const exitedOne = error.killed !== true && error.code === 1;
        resolve(exitedOne && NOT_LOGGED_IN.test(`${stdout}\n${stderr}`) ? 'signed_out' : 'unknown');
      },
    );
  });
}
