import { isSignInUrl } from '@10db/contracts';
import { z } from 'zod';
import { systemClock, type Clock } from '../clock';
import type { Logger } from '../log';
import { CODEX_CLIENT_INFO } from './codex-account-read';
import { InitializeResponse } from './codex-protocol';
import { stopLoginProcess } from './login-stop';
import {
  CodexRpcError,
  createCodexRpc,
  spawnAppServer,
  type CodexRpc,
  type CodexSpawn,
} from './codex-rpc';
import {
  AccountLoginError,
  LOGIN_MS,
  type AccountLogin,
  type AccountLoginOutcome,
  type AccountProbeSpec,
} from './types';

export interface CodexLoginOptions {
  readonly codexPath: string;
  readonly logger: Logger;
  readonly spawn?: CodexSpawn;
  readonly clock?: Clock;
}

/** How long the app-server has to answer the start. */
const START_MS = 30_000;
/** How long a cancel waits for the app-server to answer before the process is stopped anyway. */
const CANCEL_MS = 2_000;

const LoginStartResponse = z.looseObject({
  type: z.literal('chatgpt'),
  loginId: z.string().min(1),
  authUrl: z.string(),
});

const LoginCompleted = z.looseObject({
  loginId: z.string().nullable(),
  success: z.boolean(),
  error: z.string().nullable().optional(),
});

const CancelLoginResponse = z.looseObject({ status: z.string() });

/** What the server says when the sign-in's callback port, a fixed local one, is taken. */
const PORT_IN_USE = /address already in use|EADDRINUSE/i;

const PORT_MESSAGE =
  'Codex could not listen for the sign-in: another program, or another Codex sign-in, is using port 1455. Finish or close it and try again.';

/**
 * Runs `account/login/start` on a short-lived `codex app-server` that uses the account's own Codex
 * home, and keeps the process until the sign-in completes, is cancelled, the process exits or
 * `LOGIN_MS` pass. The process is always closed. Codex writes the login; 10db sees only whether it
 * finished. Neither the page address nor anything the app-server printed is logged or returned.
 */
export async function startCodexLogin(
  login: AccountProbeSpec,
  opts: CodexLoginOptions,
): Promise<AccountLogin> {
  const clock = opts.clock ?? systemClock;
  const rpc: CodexRpc = createCodexRpc(
    (opts.spawn ?? spawnAppServer)(opts.codexPath, login.env),
    opts.logger,
  );

  let settled = false;
  let resolveOutcome: (outcome: AccountLoginOutcome) => void = () => undefined;
  const outcome = new Promise<AccountLoginOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  let deadline: { cancel(): void } = { cancel: () => undefined };
  let exited = false;
  void rpc.exited.then(() => {
    exited = true;
  });
  // The outcome is known at once but settles when the process is gone, so a caller that starts the next
  // sign-in finds the callback port free.
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
          rpc.close(signal);
        },
        exited: rpc.exited,
      },
      clock,
    ).then(() => {
      resolveOutcome(result);
    });
  };

  let cancelling = false;
  let loginId: string | null = null;
  // A notification can arrive before the answer that names its login is handled.
  const early: z.infer<typeof LoginCompleted>[] = [];
  const finish = (completed: z.infer<typeof LoginCompleted>): void => {
    // Codex ends a cancelled login with a failed completion of its own; the cancel is the outcome. A
    // completion that succeeded means the login is already written, so it stands.
    if (completed.loginId !== loginId || (cancelling && !completed.success)) return;
    if (completed.success) {
      settle({ ok: true });
      return;
    }
    settle({
      ok: false,
      message: PORT_IN_USE.test(completed.error ?? '')
        ? PORT_MESSAGE
        : 'The sign-in did not finish. Try Connect again.',
    });
  };
  rpc.onNotification((n) => {
    if (n.method !== 'account/login/completed') return;
    const parsed = LoginCompleted.safeParse(n.params);
    if (!parsed.success) {
      opts.logger.warn({}, 'codex app-server sent a login result of an unknown shape');
      return;
    }
    if (loginId === null) early.push(parsed.data);
    else finish(parsed.data);
  });
  void rpc.exited.then(() => {
    settle({ ok: false, message: 'Codex stopped before the sign-in finished. Try Connect again.' });
  });

  let startTimer: { cancel(): void } = { cancel: () => undefined };
  const startDeadline = new Promise<never>((_, reject) => {
    startTimer = clock.setTimeout(() => {
      reject(new AccountLoginError('Codex did not start the sign-in in time'));
    }, START_MS);
  });
  const start = (async () => {
    await rpc.call('initialize', { clientInfo: CODEX_CLIENT_INFO }, InitializeResponse);
    rpc.notify('initialized');
    return rpc.call('account/login/start', { type: 'chatgpt' }, LoginStartResponse);
  })();
  let started: z.infer<typeof LoginStartResponse>;
  try {
    started = await Promise.race([start, startDeadline]);
  } catch (error) {
    settle({ ok: false, message: 'The sign-in did not start.' });
    await outcome;
    if (error instanceof AccountLoginError) throw error;
    if (error instanceof CodexRpcError) {
      throw new AccountLoginError(
        PORT_IN_USE.test(error.message) ? PORT_MESSAGE : 'Codex could not start the sign-in',
      );
    }
    throw error;
  } finally {
    startTimer.cancel();
    // Whichever of the start and its deadline lost the race must not become an unhandled rejection.
    start.catch(() => undefined);
    startDeadline.catch(() => undefined);
  }

  if (!isSignInUrl(started.authUrl)) {
    settle({ ok: false, message: 'The sign-in did not start.' });
    await outcome;
    throw new AccountLoginError('Codex gave a sign-in address that 10db will not open');
  }

  loginId = started.loginId;
  deadline = clock.setTimeout(() => {
    settle({ ok: false, message: 'The sign-in took too long. Try Connect again.' });
  }, LOGIN_MS);
  for (const completed of early) finish(completed);

  return {
    authUrl: started.authUrl,
    outcome,
    async cancel() {
      if (settled) return;
      cancelling = true;
      let timer: { cancel(): void } = { cancel: () => undefined };
      const waited = new Promise<void>((resolve) => {
        timer = clock.setTimeout(resolve, CANCEL_MS);
      });
      const asked = rpc
        .call('account/login/cancel', { loginId: started.loginId }, CancelLoginResponse)
        .then(
          () => undefined,
          () => undefined,
        );
      await Promise.race([asked, waited]);
      timer.cancel();
      settle({ ok: false, message: 'The sign-in was cancelled.' });
      await outcome;
    },
  };
}
