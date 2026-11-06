import { systemClock, type Clock } from '../clock';
import type { Logger } from '../log';
import type { SeenAccount } from './account-check';
import { createChannel } from './channel';
import {
  AccountReadResponse,
  InitializeResponse,
  ModelListResponse,
  RateLimitsReadResponse,
} from './codex-protocol';
import {
  CodexRpcError,
  createCodexRpc,
  spawnAppServer,
  type CodexRpc,
  type CodexSpawn,
} from './codex-rpc';
import type { SignInCheck } from './sign-in-check';
import {
  AccountProbeError,
  CompletionError,
  SessionEndReason,
  type AccountProbeSpec,
  type SessionAdapter,
  type SessionEvent,
  type SessionHandle,
  type ShapeSessionHandle,
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

const CLIENT_INFO = { name: '10db', title: '10db', version: '1' } as const;

const SESSIONS_NOT_YET = 'A session on a ChatGPT account is not available yet.';
const NO_BRAINSTORM = 'Brainstorm chat is not available on a ChatGPT account.';
const NO_QUESTIONS = 'A ChatGPT account does not answer one-shot questions.';

/** A handle that ends at once with `message`, as an adapter that cannot run the session does. */
function endedAtOnce(message: string): SessionHandle {
  const events = createChannel<SessionEvent>();
  events.push({ type: 'ended', reason: SessionEndReason.Error, message });
  events.end();
  return { events, send: () => undefined, stop: () => Promise.resolve() };
}

async function readAccount(rpc: CodexRpc): Promise<SeenAccount> {
  await rpc.call('initialize', { clientInfo: CLIENT_INFO }, InitializeResponse);
  rpc.notify('initialized');
  const { account } = await rpc.call('account/read', { refreshToken: false }, AccountReadResponse);
  const nothing: SeenAccount = {
    email: undefined,
    organization: undefined,
    subscriptionType: undefined,
    tokenSource: undefined,
    apiKeySource: undefined,
    apiProvider: undefined,
  };
  if (account === null) return nothing;
  // A key or Bedrock login is not a ChatGPT plan; the account check refuses it by its provider.
  if (account.type !== 'chatgpt') return { ...nothing, apiProvider: account.type };
  // A ChatGPT identity is the email and the workspace together, and only the usage read names the
  // workspace: without it the account could be confirmed as the wrong one.
  const usage = await rpc.call('account/rateLimits/read', undefined, RateLimitsReadResponse);
  if (usage.accountId === null || usage.accountId === undefined)
    throw new AccountProbeError('Codex did not name the workspace');
  // The list only informs Settings, so a failed read leaves it unset.
  const models = await rpc.call('model/list', {}, ModelListResponse).catch(() => undefined);
  return {
    ...nothing,
    apiProvider: 'chatgpt',
    email: account.email ?? undefined,
    subscriptionType: account.planType,
    organization: usage.accountId,
    ...(models === undefined
      ? {}
      : { models: models.data.filter((m) => m.hidden !== true).map((m) => m.model) }),
  };
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
export function createCodexAdapter(opts: CodexAdapterOptions): SessionAdapter {
  return {
    probeAccount: (probe) => probeAccount(probe, opts),
    complete: () => Promise.reject(new CompletionError(NO_QUESTIONS)),
    start: () => endedAtOnce(SESSIONS_NOT_YET),
    startShape(): ShapeSessionHandle {
      return { ...endedAtOnce(NO_BRAINSTORM), interrupt: () => Promise.resolve() };
    },
  };
}
