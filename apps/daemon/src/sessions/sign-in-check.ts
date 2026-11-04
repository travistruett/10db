import { execFile } from 'node:child_process';
import { z } from 'zod';

/** What `claude auth status` says about an account's config directory. `unknown` is no usable answer. */
export type SignInState = 'signed_in' | 'signed_out' | 'unknown';

/** Asks whether the account a session runs on is signed in; the env is the session's, so it names the config dir. */
export type SignInCheck = (env: Readonly<Record<string, string>>) => Promise<SignInState>;

/** How long `claude auth status` may take. It reads a file, but a loaded Mac can still make it slow. */
const AUTH_STATUS_MS = 20_000;

const AuthStatus = z.looseObject({ loggedIn: z.boolean() });

/**
 * Runs `claude auth status --json` with the session's env and reads `loggedIn`. It starts no model
 * session, so it answers in a moment even when a full Claude Code start is slow. Anything but a clear
 * answer (a failure, a timeout, output it cannot read) is `unknown`, never a guess.
 */
export function claudeAuthStatus(
  claudePath: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number = AUTH_STATUS_MS,
): Promise<SignInState> {
  return new Promise((resolve) => {
    execFile(
      claudePath,
      ['auth', 'status', '--json'],
      { env: { ...env }, timeout: timeoutMs, maxBuffer: 1_000_000 },
      (error, stdout) => {
        if (error) {
          resolve('unknown');
          return;
        }
        try {
          const parsed = AuthStatus.safeParse(JSON.parse(stdout));
          resolve(!parsed.success ? 'unknown' : parsed.data.loggedIn ? 'signed_in' : 'signed_out');
        } catch {
          resolve('unknown');
        }
      },
    );
  });
}
