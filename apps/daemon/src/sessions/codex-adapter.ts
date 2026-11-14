import { systemClock, type Clock } from '../clock';
import type { Logger } from '../log';
import type { SeenAccount } from './account-check';
import { codexCapabilities } from './capabilities';
import { onProfile } from './agent-profile';
import { createChannel } from './channel';
import { CODEX_CLIENT_INFO, readSeenAccount } from './codex-account-read';
import { startCodexLogin } from './codex-connect';
import { codexHomes } from './codex-home';
import { InitializeResponse } from './codex-protocol';
import {
  CodexRpcError,
  createCodexRpc,
  spawnAppServer,
  type CodexRpc,
  type CodexSpawn,
} from './codex-rpc';
import { startCodexSession } from './codex-session';
import { readThreadClientUuids } from './codex-thread-read';
import type { SignInCheck } from './sign-in-check';
import {
  AccountProbeError,
  CompletionError,
  SessionEndReason,
  type AccountProbeSpec,
  type AgentAdapter,
  type SessionEvent,
  type SessionHandle,
} from './types';

export interface CodexAdapterOptions {
  readonly codexPath: string;
  readonly logger: Logger;
  readonly spawn?: CodexSpawn;
  readonly clock?: Clock;
  readonly stopGraceMs?: number;
  /** Where session sockets live; defaults to `~/.10db/run`, short enough for a socket path. */
  readonly socketDir?: string;
  /** Asks whether the account a session runs on is signed in, when a start gets no account. */
  readonly signInCheck?: SignInCheck;
}

/** How long a probe waits for the app-server to say who the account is. */
const PROBE_MS = 30_000;

const NO_BRAINSTORM = 'Brainstorm chat is not available on a ChatGPT account.';
const NO_QUESTIONS = 'A ChatGPT account does not answer one-shot questions.';

/** A handle that ends at once with `message`, as an adapter that cannot run the conversation does. */
function endedAtOnce(message: string): SessionHandle {
  const events = createChannel<SessionEvent>();
  events.push({ type: 'ended', reason: SessionEndReason.Error, message });
  events.end();
  return {
    events,
    send: () => undefined,
    interrupt: () => Promise.resolve(null),
    stop: () => Promise.resolve(),
  };
}

async function readAccount(rpc: CodexRpc): Promise<SeenAccount> {
  await rpc.call('initialize', { clientInfo: CODEX_CLIENT_INFO }, InitializeResponse);
  rpc.notify('initialized');
  return readSeenAccount((method, params, schema) => rpc.call(method, params, schema), true);
}

/**
 * Starts `codex app-server` only to read who the account is, and always closes it. The error text
 * names a timeout or a failure, never what the app-server printed, which could hold an email.
 */
async function probeAccount(
  probe: AccountProbeSpec,
  opts: CodexAdapterOptions,
): Promise<SeenAccount> {
  const clock = opts.clock ?? systemClock;
  const rpc = createCodexRpc(
    (opts.spawn ?? spawnAppServer)(opts.codexPath, probe.env),
    opts.logger,
  );
  let timer: { cancel(): void } = { cancel: () => undefined };
  const deadline = new Promise<never>((_, reject) => {
    timer = clock.setTimeout(() => {
      reject(
        new AccountProbeError(`Codex reported no account within ${String(PROBE_MS / 1_000)} s`),
      );
    }, PROBE_MS);
  });
  const read = readAccount(rpc);
  try {
    return await Promise.race([read, deadline]);
  } catch (error) {
    if (error instanceof AccountProbeError) throw error;
    if (error instanceof CodexRpcError)
      throw new AccountProbeError('Codex could not report the account');
    throw error;
  } finally {
    timer.cancel();
    rpc.close();
    // Whichever of the read and the deadline lost the race must not become an unhandled rejection.
    read.catch(() => undefined);
    deadline.catch(() => undefined);
  }
}

/** Runs sessions on the builder's installed Codex over `codex app-server` (the ChatGPT-plan design). */
export function createCodexAdapter(opts: CodexAdapterOptions): AgentAdapter {
  const homes = codexHomes();
  return {
    capabilities: (account) => codexCapabilities(account.kind),
    probeAccount: (probe) => probeAccount(probe, opts),
    startLogin: (login) => startCodexLogin(login, opts),
    complete: () => Promise.reject(new CompletionError(NO_QUESTIONS)),
    open: (spec) =>
      onProfile(spec, {
        lane: (lane) => startCodexSession(lane, { ...opts, homes }),
        explore: () => endedAtOnce(NO_BRAINSTORM),
      }),
    readClientUuids: (spec) => readThreadClientUuids(spec, { ...opts, homes }),
  };
}
