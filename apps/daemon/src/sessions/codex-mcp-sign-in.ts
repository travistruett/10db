import { execFile } from 'node:child_process';
import type { SupportedAccountKind } from '@10db/contracts';
import { z } from 'zod';
import { systemClock, type Clock } from '../clock';
import type { Logger } from '../log';
import { CODEX_CLIENT_INFO, type CodexCall } from './codex-account-read';
import { PORT_IN_USE } from './codex-connect';
import {
  codexChildHome,
  codexHomeProviderOf,
  type CodexHome,
  type CodexHomeProvider,
} from './codex-home';
import { readCodexMcpAuth, type McpAuthState } from './codex-mcp-auth';
import { InitializeResponse } from './codex-protocol';
import {
  CodexRpcError,
  createCodexRpc,
  spawnAppServer,
  type CodexRpc,
  type CodexSpawn,
} from './codex-rpc';
import { codexYourServers } from './codex-your-servers';
import { stopLoginProcess } from './login-stop';
import {
  LOGIN_MS,
  McpSignInError,
  type AccountLoginOutcome,
  type McpAuthSpec,
  type McpSignIn,
  type McpSignInSpec,
  type YourSessionServer,
} from './types';

export interface McpSignInDeps {
  readonly codexPath: string;
  readonly logger: Logger;
  readonly spawn?: CodexSpawn;
  readonly clock?: Clock;
  /** The account homes; `ensureConfig` runs on one before a process uses it. */
  readonly homes: (path: string, provider: CodexHomeProvider) => CodexHome;
  /** Opens a page in the builder's browser; defaults to `/usr/bin/open`. Tests record. */
  readonly openPage?: (url: string) => Promise<void>;
}

/** How long a sign-in's start (initialize, thread, login call) has to finish. */
const START_MS = 30_000;
/**
 * A status read is bounded as a whole, start and read together, inside the 15 s Settings waits for it, so no
 * process outlives that wait: the start gets `STATUS_START_MS`, the read `MCP_AUTH_STATUS_MS` after it.
 */
const STATUS_START_MS = 5_000;
export const MCP_AUTH_STATUS_MS = 6_000;

const PORT_MESSAGE =
  'Codex could not listen for the sign-in on its callback port: another program is using it. Close it and try Sign in again.';
const NOT_FINISHED = "The sign-in didn't finish. Try Sign in again.";

const ThreadStarted = z.looseObject({ thread: z.looseObject({ id: z.string().min(1) }) });
const LoginResponse = z.looseObject({
  authorizationUrl: z.string(),
  loginId: z.string().nullish(),
});
const LoginCompleted = z.looseObject({
  name: z.string(),
  threadId: z.string().nullish(),
  loginId: z.string().nullish(),
  success: z.boolean(),
  error: z.string().nullish(),
});

const openWithSystem = (url: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile('/usr/bin/open', [url], (error) => {
      if (error === null) resolve();
      else reject(error instanceof Error ? error : new Error('open failed'));
    });
  });

/** The parsed address of a page that is plain https with no userinfo, the only kind 10db hands the browser; else null. */
function plainHttpsHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

interface OpenHome {
  readonly rpc: CodexRpc;
  readonly call: CodexCall;
  readonly threadId: string;
  readonly home: string;
  /** Stops the process and resolves once it has exited. */
  close(): Promise<void>;
}

/**
 * The one way status reads and sign-ins start Codex: the account's config written first, the same `HOME`
 * sessions use, `initialize`, then an ephemeral thread that carries exactly `servers`, so Codex reads and
 * signs in the same servers a session would. Rejects with an `McpSignInError`, the process closed.
 */
export async function openCodexHome(
  deps: McpSignInDeps,
  kind: SupportedAccountKind,
  env: Readonly<Record<string, string>>,
  servers: Readonly<Record<string, YourSessionServer>>,
  startMs: number = START_MS,
): Promise<OpenHome> {
  const clock = deps.clock ?? systemClock;
  const { codexHome, home } = codexChildHome(env);
  try {
    await deps.homes(codexHome, codexHomeProviderOf(kind)).ensureConfig();
  } catch (error) {
    deps.logger.error(
      { errName: error instanceof Error ? error.name : 'unknown' },
      'the codex home could not be prepared for an mcp sign-in',
    );
    throw new McpSignInError('The Codex folder of the account could not be prepared.');
  }
  const rpc = createCodexRpc(
    (deps.spawn ?? spawnAppServer)(deps.codexPath, { ...env, HOME: home }),
    deps.logger,
  );
  const close = async (): Promise<void> => {
    await stopLoginProcess(
      {
        kill: (signal) => {
          rpc.close(signal);
        },
        exited: rpc.exited,
      },
      clock,
    );
  };
  let timer: { cancel(): void } = { cancel: () => undefined };
  const deadline = new Promise<never>((_, reject) => {
    timer = clock.setTimeout(() => {
      reject(new McpSignInError('Codex did not start in time.'));
    }, startMs);
  });
  const start = (async () => {
    await rpc.call('initialize', { clientInfo: CODEX_CLIENT_INFO }, InitializeResponse);
    rpc.notify('initialized');
    return rpc.call(
      'thread/start',
      {
        cwd: home,
        ephemeral: true,
        approvalPolicy: 'never',
        config: { mcp_servers: codexYourServers({ yourMcpServers: servers }) },
      },
      ThreadStarted,
    );
  })();
  try {
    const thread = await Promise.race([start, deadline]);
    return {
      rpc,
      call: (method, params, schema) => rpc.call(method, params, schema),
      threadId: thread.thread.id,
      home,
      close,
    };
  } catch (error) {
    await close();
    if (error instanceof McpSignInError) throw error;
    if (error instanceof CodexRpcError) throw new McpSignInError('Codex could not start.');
    throw error;
  } finally {
    timer.cancel();
    // Whichever of the start and its deadline lost the race must not become an unhandled rejection.
    start.catch(() => undefined);
    deadline.catch(() => undefined);
  }
}

/** Whether each of `spec.servers` is signed in on the account; the process is closed whatever happens. */
export async function codexMcpAuthStatus(
  spec: McpAuthSpec,
  deps: McpSignInDeps,
): Promise<Readonly<Record<string, McpAuthState>>> {
  const clock = deps.clock ?? systemClock;
  const opened = await openCodexHome(deps, spec.kind, spec.env, spec.servers, STATUS_START_MS);
  let timer: { cancel(): void } = { cancel: () => undefined };
  const deadline = new Promise<never>((_, reject) => {
    timer = clock.setTimeout(() => {
      reject(new McpSignInError('Codex did not report the sign-ins in time.'));
    }, MCP_AUTH_STATUS_MS);
  });
  const read = readCodexMcpAuth(opened.call, opened.threadId, Object.keys(spec.servers), clock);
  try {
    return await Promise.race([read, deadline]);
  } catch (error) {
    if (error instanceof McpSignInError) throw error;
    if (error instanceof CodexRpcError)
      throw new McpSignInError('Codex could not report the sign-ins.');
    throw error;
  } finally {
    timer.cancel();
    read.catch(() => undefined);
    deadline.catch(() => undefined);
    await opened.close();
  }
}

/**
 * Runs `mcpServer/oauth/login` for one server on an ephemeral thread of the account's own Codex home, opens
 * the page Codex names, and keeps the process until the sign-in completes, is cancelled, the process exits or
 * `LOGIN_MS` pass. The process is always closed, and the outcome settles once it is gone, so a next sign-in
 * finds the callback port free. Codex writes the token; 10db sees only whether it finished. Neither the page
 * address nor anything Codex printed is logged or put in an error.
 */
export async function startCodexMcpSignIn(
  spec: McpSignInSpec,
  deps: McpSignInDeps,
): Promise<McpSignIn> {
  const clock = deps.clock ?? systemClock;
  const openPage = deps.openPage ?? openWithSystem;
  const opened = await openCodexHome(deps, spec.kind, spec.env, { [spec.name]: spec.server });
  const { rpc, threadId } = opened;

  let settled = false;
  let resolveOutcome: (outcome: AccountLoginOutcome) => void = () => undefined;
  const outcome = new Promise<AccountLoginOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  let deadline: { cancel(): void } = { cancel: () => undefined };
  const settle = (result: AccountLoginOutcome): void => {
    if (settled) return;
    settled = true;
    deadline.cancel();
    void opened.close().then(() => {
      resolveOutcome(result);
    });
  };

  const login: { id: string | null | undefined; answered: boolean } = {
    id: undefined,
    answered: false,
  };
  // A completion can arrive before the answer that names its login is handled.
  const early: z.infer<typeof LoginCompleted>[] = [];
  const finish = (completed: z.infer<typeof LoginCompleted>): void => {
    if (completed.name !== spec.name || completed.threadId !== threadId) return;
    // A login id is compared only when both sides carry one.
    if (
      login.id !== undefined &&
      login.id !== null &&
      completed.loginId !== undefined &&
      completed.loginId !== null &&
      completed.loginId !== login.id
    )
      return;
    if (completed.success) {
      settle({ ok: true });
      return;
    }
    settle({
      ok: false,
      message: PORT_IN_USE.test(completed.error ?? '') ? PORT_MESSAGE : NOT_FINISHED,
    });
  };
  rpc.onNotification((n) => {
    if (n.method !== 'mcpServer/oauthLogin/completed') return;
    const parsed = LoginCompleted.safeParse(n.params);
    if (!parsed.success) {
      deps.logger.warn({}, 'codex sent an mcp sign-in result of an unknown shape');
      return;
    }
    if (login.answered) finish(parsed.data);
    else early.push(parsed.data);
  });
  void rpc.exited.then(() => {
    settle({ ok: false, message: 'Codex stopped before the sign-in finished. Try Sign in again.' });
  });

  let timer: { cancel(): void } = { cancel: () => undefined };
  const startDeadline = new Promise<never>((_, reject) => {
    timer = clock.setTimeout(() => {
      reject(new McpSignInError('Codex did not start the sign-in in time.'));
    }, START_MS);
  });
  const request = rpc.call(
    'mcpServer/oauth/login',
    { name: spec.name, threadId, timeoutSecs: LOGIN_MS / 1_000 },
    LoginResponse,
  );
  let answered: z.infer<typeof LoginResponse>;
  try {
    answered = await Promise.race([request, startDeadline]);
  } catch (error) {
    settle({ ok: false, message: 'The sign-in did not start.' });
    await outcome;
    if (error instanceof McpSignInError) throw error;
    if (error instanceof CodexRpcError)
      throw new McpSignInError(
        PORT_IN_USE.test(error.message) ? PORT_MESSAGE : 'Codex could not start the sign-in.',
      );
    throw error;
  } finally {
    timer.cancel();
    request.catch(() => undefined);
    startDeadline.catch(() => undefined);
  }

  const url = plainHttpsHref(answered.authorizationUrl);
  if (url === null) {
    settle({ ok: false, message: 'The sign-in did not start.' });
    await outcome;
    throw new McpSignInError('Codex gave a sign-in address that 10db will not open.');
  }
  login.id = answered.loginId;
  login.answered = true;
  deadline = clock.setTimeout(() => {
    settle({ ok: false, message: NOT_FINISHED });
  }, LOGIN_MS);
  try {
    await openPage(url);
  } catch {
    settle({ ok: false, message: 'The sign-in page could not be opened.' });
    await outcome;
    throw new McpSignInError('The sign-in page could not be opened in your browser.');
  }
  for (const completed of early) finish(completed);

  return {
    outcome,
    reopen: () => openPage(url),
    async cancel() {
      if (settled) return;
      settle({ ok: false, message: 'The sign-in was cancelled.' });
      await outcome;
    },
  };
}
