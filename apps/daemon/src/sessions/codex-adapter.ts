import { systemClock, type Clock } from '../clock';
import type { Logger } from '../log';
import type { SeenAccount } from './account-check';
import { codexCapabilities } from './capabilities';
import { CODEX_CLIENT_INFO, readSeenAccount } from './codex-account-read';
import { startCodexLogin } from './codex-connect';
import { codexTakeoverCommand, codexTakeoverNotes } from './codex-takeover';
import { codexMcpAuthStatus, startCodexMcpSignIn } from './codex-mcp-sign-in';
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
  type AccountProbeSpec,
  type AgentAdapter,
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
  /** Opens an MCP sign-in page in the builder's browser; defaults to `/usr/bin/open`. Tests record. */
  readonly openPage?: (url: string) => Promise<void>;
}

/** How long a probe waits for the app-server to say who the account is. */
const PROBE_MS = 30_000;

const NO_QUESTIONS = 'A ChatGPT account does not answer one-shot questions.';

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
    takeoverCommand: (spec) => codexTakeoverCommand({ ...spec, binary: opts.codexPath }),
    takeoverNotes: () => codexTakeoverNotes(),
    probeAccount: (probe) => probeAccount(probe, opts),
    startLogin: (login) => startCodexLogin(login, opts),
    startMcpSignIn: (spec) => startCodexMcpSignIn(spec, { ...opts, homes }),
    mcpAuthStatus: (spec) => codexMcpAuthStatus(spec, { ...opts, homes }),
    complete: () => Promise.reject(new CompletionError(NO_QUESTIONS)),
    // A lane and an explore conversation open the same session: the sandbox, the guard hook and the
    // judge come with the spec (sessions spec §5.5, the attended profile).
    open: (spec) => startCodexSession(spec, { ...opts, homes }),
    readClientUuids: (spec) => readThreadClientUuids(spec, { ...opts, homes }),
  };
}
