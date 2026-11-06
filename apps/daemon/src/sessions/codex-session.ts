import { homedir } from 'node:os';
import { join } from 'node:path';
import { MODEL_ALIAS_PATTERN, type AccountRefusal } from '@10db/contracts';
import type { z } from 'zod';
import { systemClock, type Clock } from '../clock';
import { CODEX_VERIFIED_ON } from '../environment';
import { checkAccount, missingAccountRefusal, modelMatches, noAccountWhy } from './account-check';
import { createChannel } from './channel';
import { CODEX_CLIENT_INFO, readSeenAccount, type CodexCall } from './codex-account-read';
import type { CodexAdapterOptions } from './codex-adapter';
import { GUARD_HOOK_EVENT, type CodexHome } from './codex-home';
import { codexThreadConfig, LANE_PROFILE } from './codex-lane-config';
import {
  ConfigReadResponse,
  HooksListResponse,
  InitializeResponse,
  ThreadResponse,
  TurnStartResponse,
} from './codex-protocol';
import {
  CLIENT_ERROR_CODE,
  CodexRpcError,
  createCodexRpc,
  spawnAppServer,
  type CodexRpc,
} from './codex-rpc';
import { codexLoginStatus } from './codex-sign-in-check';
import type { SignInCheck } from './sign-in-check';
import {
  AccountProbeError,
  SessionEndReason,
  type SessionEvent,
  type SessionHandle,
  type SessionSpec,
} from './types';

export interface CodexSessionDeps extends CodexAdapterOptions {
  /** The home for an account's `CODEX_HOME`. */
  readonly homes: (path: string) => CodexHome;
}

/** How long one call of the start sequence may take before the session ends. */
const START_CALL_MS = 60_000;

/** The most of the child's stderr kept for a message. */
const STDERR_KEPT_CHARS = 4096;

const TRUSTED = 'trusted';

type HookEntry = z.infer<typeof HooksListResponse>['data'][number]['hooks'][number];

/** Where session sockets live when the adapter is given no directory: short enough for a socket path. */
const defaultSocketDir = (): string => join(homedir(), '.10db', 'run');

const NO_PROMPT = 'No prompt was sent.';

const modelRefusal = (model: string): string =>
  `Codex refused the model "${model}". Set this account's Model map in Settings.`;

/** The socket the session's guard hook talks to: short enough for macOS's socket path limit. */
export function guardSocketPath(socketDir: string, sessionId: string): string {
  return join(socketDir, `${sessionId.slice(-12)}.sock`);
}

/** A check or call of the start sequence failed in a way that ends the session with `reason`. */
class StartRefused extends Error {
  override readonly name = 'StartRefused';
  readonly reason: SessionEndReason;
  readonly refusal: AccountRefusal | undefined;
  constructor(reason: SessionEndReason, message: string, refusal?: AccountRefusal) {
    super(message);
    this.reason = reason;
    this.refusal = refusal;
  }
}

/** A call went unanswered for `START_CALL_MS`. */
class CallTimeout extends Error {
  override readonly name = 'CallTimeout';
}

/** The session ended while the start sequence was waiting. */
class SessionOver extends Error {
  override readonly name = 'SessionOver';
}

const sandboxRefused = (message: string): StartRefused =>
  new StartRefused(SessionEndReason.SandboxRefused, `${message} ${NO_PROMPT}`);

/** The version a user agent such as `codex/0.154.0 (...)` names, which is all that is ever logged. */
function versionOf(userAgent: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(userAgent)?.[1] ?? null;
}

/**
 * Starts a Codex session behind the adapter's safety checks and emits `started` only once every one
 * has passed. Any failure ends it with `sandbox_refused`, `account_refused` or `error` and no prompt is
 * sent; the child is closed on every path. Each call runs under a deadline on the injected clock.
 */
export function startCodexSession(spec: SessionSpec, deps: CodexSessionDeps): SessionHandle {
  const events = createChannel<SessionEvent>();
  const clock: Clock = deps.clock ?? systemClock;
  const log = deps.logger;
  const signInCheck: SignInCheck =
    deps.signInCheck ?? ((env) => codexLoginStatus(deps.codexPath, env));
  let rpc: CodexRpc | null = null;
  let done = false;
  let started = false;
  let stderrTail = '';
  /** What the process runs with beyond the spec's env; set once the home is known. */
  let homeEnv: Record<string, string> = {};
  const childEnv = (): Record<string, string> => ({ ...spec.env, ...homeEnv });
  let endSession: (error: Error) => void = () => undefined;
  const over = new Promise<never>((_, reject) => {
    endSession = reject;
  });
  // Only the calls racing it read it; without a reader a session that ends in time would leave it unhandled.
  over.catch(() => undefined);

  const finish = (
    reason: SessionEndReason,
    message: string | null,
    refusal?: AccountRefusal,
  ): void => {
    if (done) return;
    done = true;
    events.push({ type: 'ended', reason, message, ...(refusal ? { refusal } : {}) });
    events.end();
    rpc?.close();
    endSession(new SessionOver());
  };

  /** One call under the start deadline; a session that ends meanwhile abandons it. */
  const ask: CodexCall = async (method, params, schema) => {
    if (rpc === null || done) throw new SessionOver();
    const call = rpc.call(method, params, schema);
    let timer: { cancel(): void } = { cancel: () => undefined };
    const deadline = new Promise<never>((_, reject) => {
      timer = clock.setTimeout(() => {
        reject(
          new CallTimeout(
            `Codex did not answer ${method} within ${String(START_CALL_MS / 1_000)} s`,
          ),
        );
      }, START_CALL_MS);
    });
    try {
      return await Promise.race([call, deadline, over]);
    } finally {
      timer.cancel();
      // Whichever lost the race must not become an unhandled rejection.
      call.catch(() => undefined);
      deadline.catch(() => undefined);
    }
  };

  /** The account could not be read: only the sign-in command says whether it is signed out. */
  const refuseUnreadAccount = async (): Promise<never> => {
    const signIn = await signInCheck(childEnv());
    const { why, printed } = noAccountWhy(START_CALL_MS, [stderrTail], spec.account.kind);
    const refusal = missingAccountRefusal(spec.account, why, printed, signIn);
    if (refusal === null)
      throw new StartRefused(
        SessionEndReason.BillingRefused,
        `Account check failed: ${why}. ${printed}. ${NO_PROMPT}`,
      );
    throw new StartRefused(
      SessionEndReason.AccountRefused,
      `${refusal.message}. ${NO_PROMPT}`,
      refusal,
    );
  };

  const verifyAccount = async (): Promise<void> => {
    let seen;
    try {
      seen = await readSeenAccount(ask, false);
    } catch (error) {
      if (
        error instanceof CodexRpcError ||
        error instanceof AccountProbeError ||
        error instanceof CallTimeout
      )
        return refuseUnreadAccount();
      throw error;
    }
    const refusal = checkAccount(spec.account, seen);
    if (refusal)
      throw new StartRefused(
        SessionEndReason.AccountRefused,
        `${refusal.message}. ${NO_PROMPT}`,
        refusal,
      );
  };

  const checkProjectLayer = async (): Promise<void> => {
    const config = await ask(
      'config/read',
      { includeLayers: true, cwd: spec.cwd },
      ConfigReadResponse,
    );
    const loaded = (config.layers ?? []).some(
      (layer) =>
        layer.name.type === 'project' &&
        (layer.disabledReason === null || layer.disabledReason === undefined),
    );
    if (loaded)
      throw sandboxRefused(
        "Codex loaded the checkout's own project layer (.codex), which could replace the lane sandbox.",
      );
  };

  const readGuardHook = async (): Promise<HookEntry | undefined> => {
    const list = await ask('hooks/list', { cwds: [spec.cwd] }, HooksListResponse);
    return list.data.flatMap((entry) => entry.hooks).find((h) => h.eventName === GUARD_HOOK_EVENT);
  };

  const checkGuardHook = async (home: CodexHome): Promise<void> => {
    let hook = await readGuardHook();
    if (hook?.enabled === true && hook.trustStatus !== TRUSTED) {
      await home.trustGuardHook(hook.key, hook.currentHash);
      // The trust takes effect in the running app-server, so the list is read again with no restart.
      hook = await readGuardHook();
    }
    if (hook === undefined) throw sandboxRefused('Codex does not list the guard hook.');
    if (!hook.enabled) throw sandboxRefused('Codex has the guard hook disabled.');
    if (hook.trustStatus !== TRUSTED)
      throw sandboxRefused('Codex does not trust the guard hook, even after it was trusted.');
  };

  /** A server error that names the model: the Model map has no usable entry for it. */
  const isModelRefusal = (error: unknown): boolean =>
    error instanceof CodexRpcError &&
    error.code !== CLIENT_ERROR_CODE &&
    /model/i.test(error.message);

  const startThread = async (): Promise<z.infer<typeof ThreadResponse>> => {
    const params = {
      cwd: spec.cwd,
      model: spec.model,
      approvalPolicy: 'never',
      config: codexThreadConfig(spec),
    };
    const resumeId = spec.resumeProviderSessionId;
    let thread;
    try {
      thread =
        resumeId === null
          ? await ask('thread/start', params, ThreadResponse)
          : await ask('thread/resume', { threadId: resumeId, ...params }, ThreadResponse);
    } catch (error) {
      if (isModelRefusal(error))
        throw new StartRefused(SessionEndReason.Error, modelRefusal(spec.model));
      if (resumeId !== null && error instanceof CodexRpcError)
        throw new StartRefused(
          SessionEndReason.Error,
          `Codex could not resume thread ${resumeId}. ${NO_PROMPT}`,
        );
      throw error;
    }
    if (thread.activePermissionProfile?.id !== LANE_PROFILE)
      throw sandboxRefused('Codex runs the thread under a permission profile other than the lane.');
    if (!modelMatches(spec.model, thread.model))
      throw new StartRefused(
        SessionEndReason.BillingRefused,
        `Model check failed: 10db asked for ${spec.model} but Codex runs ${thread.model}. ${NO_PROMPT}`,
      );
    return thread;
  };

  const run = async (): Promise<void> => {
    if ((spec.sandbox ?? null) === null)
      throw sandboxRefused('10db refused to start Codex without the lane sandbox.');
    const codexHome = spec.env['CODEX_HOME'];
    if (codexHome === undefined || codexHome === '')
      throw sandboxRefused('The session has no CODEX_HOME, so Codex would run in the shared home.');
    if (MODEL_ALIAS_PATTERN.test(spec.model))
      throw new StartRefused(SessionEndReason.Error, modelRefusal(spec.model));

    const home = deps.homes(codexHome);
    try {
      await home.prepare(spec.cwd);
    } catch (error) {
      log.error(
        { errName: error instanceof Error ? error.name : 'unknown' },
        'the codex home could not be prepared',
      );
      throw sandboxRefused(
        'The Codex home could not be prepared, so the checkout is not pinned untrusted.',
      );
    }
    if (done) return;

    homeEnv = {
      HOME: home.emptyHome,
      TENDB_MCP_TOKEN: spec.mcp.token,
      TENDB_GUARD_SOCKET: guardSocketPath(deps.socketDir ?? defaultSocketDir(), spec.sessionId),
      TENDB_GUARD_MAX_SECONDS: String(Math.ceil(spec.mcp.toolTimeoutMs / 1_000)),
    };
    const child = (deps.spawn ?? spawnAppServer)(deps.codexPath, childEnv());
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_KEPT_CHARS);
    });
    rpc = createCodexRpc(child, log);
    void rpc.exited.then(({ code }) => {
      if (started)
        finish(SessionEndReason.Error, `Codex exited (${String(code)}) before the session ended.`);
    });

    const init = await ask('initialize', { clientInfo: CODEX_CLIENT_INFO }, InitializeResponse);
    rpc.notify('initialized');
    const version = versionOf(init.userAgent);
    if (version !== CODEX_VERIFIED_ON)
      log.warn(
        { version, verifiedOn: CODEX_VERIFIED_ON },
        'codex app-server is not the version the start checks were verified on',
      );

    await verifyAccount();
    await checkProjectLayer();
    await checkGuardHook(home);
    const thread = await startThread();

    started = true;
    events.push({ type: 'started', providerSessionId: thread.thread.id, pid: child.pid ?? null });
    try {
      await ask(
        'turn/start',
        {
          threadId: thread.thread.id,
          input: [{ type: 'text', text: spec.prompt, text_elements: [] }],
          approvalPolicy: 'never',
          model: spec.model,
          effort: spec.effort,
        },
        TurnStartResponse,
      );
    } catch (error) {
      if (isModelRefusal(error))
        throw new StartRefused(SessionEndReason.Error, modelRefusal(spec.model));
      throw error;
    }
  };

  void run().catch((error: unknown) => {
    if (error instanceof SessionOver) return;
    if (error instanceof StartRefused) {
      finish(error.reason, error.message, error.refusal);
      return;
    }
    if (error instanceof CallTimeout) {
      finish(SessionEndReason.Error, `${error.message}. ${NO_PROMPT}`);
      return;
    }
    if (error instanceof CodexRpcError) {
      finish(
        SessionEndReason.Error,
        `Codex could not start the session. ${noAccountWhy(START_CALL_MS, [stderrTail], spec.account.kind).printed}. ${NO_PROMPT}`,
      );
      return;
    }
    log.error(
      { errName: error instanceof Error ? error.name : 'unknown' },
      'a codex session failed to start',
    );
    finish(SessionEndReason.Error, `The Codex session could not start. ${NO_PROMPT}`);
  });

  return {
    events,
    // Later messages are delivered by the turn loop, which this start hands the thread to.
    send: () => undefined,
    stop: () => {
      finish(SessionEndReason.Stopped, null);
      return Promise.resolve();
    },
  };
}
