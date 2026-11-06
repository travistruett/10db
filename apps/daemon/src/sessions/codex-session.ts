import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AccountProblem, MODEL_ALIAS_PATTERN, type AccountRefusal } from '@10db/contracts';
import { z } from 'zod';
import { systemClock, type Clock } from '../clock';
import { CODEX_VERIFIED_ON } from '../environment';
import { checkAccount, missingAccountRefusal, modelMatches, noAccountWhy } from './account-check';
import { createChannel } from './channel';
import { CODEX_CLIENT_INFO, readSeenAccount, type CodexCall } from './codex-account-read';
import type { CodexAdapterOptions } from './codex-adapter';
import { GUARD_HOOK_EVENT, type CodexHome } from './codex-home';
import { codexThreadConfig, LANE_PROFILE } from './codex-lane-config';
import {
  createTurnState,
  hasKnownShape,
  mapCodexNotification,
  rateLimitEvents,
} from './codex-mapping';
import {
  ConfigReadResponse,
  HooksListResponse,
  InitializeResponse,
  RateLimitsReadResponse,
  ThreadResponse,
  TurnCompleted,
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

/** How long `stop` waits for Codex to acknowledge `turn/interrupt` before it ends the process. */
const STOP_GRACE_MS = 5_000;

/** The most of the child's stderr an `ended` message carries when the process exits unasked. */
const EXIT_STDERR_CHARS = 500;

/** A reply 10db reads nothing from. */
const Acknowledged = z.looseObject({});

/** How a failed turn ends the session, when it does: the kinds `turn/completed` names. */
const TurnEnd = {
  UsageLimit: 'usage_limit',
  SignedOut: 'signed_out',
  ModelRefused: 'model_refused',
} as const;
type TurnEnd = (typeof TurnEnd)[keyof typeof TurnEnd];

/** `codexErrorInfo` is a bare name (`"unauthorized"`) or an object keyed by it (`{ "httpConnectionFailed": {} }`). */
function errorKind(info: unknown): string | null {
  if (typeof info === 'string') return info;
  if (typeof info === 'object' && info !== null) return Object.keys(info)[0] ?? null;
  return null;
}

/** The text of a message a session that has started sends; nothing was prompted before then. */
const unlessStarted = (started: boolean): string => (started ? '' : ` ${NO_PROMPT}`);

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
 * has passed. A check that fails or cannot complete before `started` ends it `sandbox_refused`, an
 * account that is not the expected one `account_refused`, and only a refused model or a failed resume
 * `error`; no prompt is sent and the child is closed on every path. Each call runs under a deadline on the injected clock.
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
  /** `stop` was called: the process is expected to end, and what it says no longer matters. */
  let stopRequested = false;
  /** The session is ending (a stop, or a failed turn that ends it), so notifications are no longer read. */
  let closing = false;
  let threadId: string | null = null;
  /** Turns that have completed, so a `turn/start` reply is not taken for a turn that already ended. */
  let turnsCompleted = 0;
  const state = createTurnState();
  const graceMs = deps.stopGraceMs ?? STOP_GRACE_MS;
  let sends: Promise<void> = Promise.resolve();
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
    // Codex omits the layers when it did not honour `includeLayers`, so their absence proves nothing.
    if (config.layers === null || config.layers === undefined)
      throw sandboxRefused(
        'Codex did not list its config layers, so the project layer could not be checked.',
      );
    const loaded = config.layers.some(
      (layer) =>
        layer.name.type === 'project' &&
        (layer.disabledReason === null || layer.disabledReason === undefined),
    );
    if (loaded)
      throw sandboxRefused(
        "Codex loaded the checkout's own project layer (.codex), which could replace the lane sandbox.",
      );
  };

  /** The hook the home's own `config.toml` declares; a hook from any other source is never the guard. */
  const readGuardHook = async (own: string): Promise<HookEntry | undefined> => {
    const list = await ask('hooks/list', { cwds: [spec.cwd] }, HooksListResponse);
    return list.data
      .flatMap((entry) => entry.hooks)
      .find((h) => h.eventName === GUARD_HOOK_EVENT && h.sourcePath === own);
  };

  const checkGuardHook = async (home: CodexHome): Promise<void> => {
    // Codex reports the resolved path, so the home's file is resolved the same way.
    const own = await realpath(join(home.path, 'config.toml'));
    let hook = await readGuardHook(own);
    if (hook?.enabled === true && hook.trustStatus !== TRUSTED) {
      await home.trustGuardHook(hook.key, hook.currentHash);
      // The trust takes effect in the running app-server, so the list is read again with no restart.
      hook = await readGuardHook(own);
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

  /** The end of the child's stderr, for the message of a session that ended because the child did. */
  const stderrNote = (): string => {
    const tail = stderrTail.replace(/\s+/g, ' ').trim().slice(-EXIT_STDERR_CHARS);
    return tail === '' ? '' : ` Codex printed: "${tail}"`;
  };

  /** Begins a turn with `text`. The reply names the turn if its `turn/started` has not been read yet. */
  const startTurn = async (thread: string, text: string): Promise<void> => {
    const before = turnsCompleted;
    const reply = await ask(
      'turn/start',
      {
        threadId: thread,
        input: [{ type: 'text', text, text_elements: [] }],
        approvalPolicy: 'never',
        model: spec.model,
        effort: spec.effort,
      },
      TurnStartResponse,
    );
    if (state.turnId === null && turnsCompleted === before && reply.turn.status === 'inProgress')
      state.turnId = reply.turn.id;
  };

  /** The limit a hard stop reports: the last window seen, else what Codex reports now. */
  const currentLimit = async (): Promise<typeof state.lastLimit> => {
    if (state.lastLimit !== null) return state.lastLimit;
    try {
      const read = await ask('account/rateLimits/read', undefined, RateLimitsReadResponse);
      return rateLimitEvents(read.rateLimits).at(-1) ?? null;
    } catch {
      return null;
    }
  };

  /** What a failed turn ends the session on, when it names one. */
  const endOfTurn = (params: unknown): TurnEnd | null => {
    const parsed = TurnCompleted.safeParse(params);
    if (!parsed.success || parsed.data.turn.status !== 'failed') return null;
    const kind = errorKind(parsed.data.turn.error?.codexErrorInfo);
    if (kind === 'usageLimitExceeded') return TurnEnd.UsageLimit;
    if (kind === 'unauthorized') return TurnEnd.SignedOut;
    // Codex accepts an unknown model at thread/start, so a mistyped Model map ID fails only here.
    if (kind === 'badRequest' && parsed.data.turn.error?.message.includes(spec.model) === true)
      return TurnEnd.ModelRefused;
    return null;
  };

  const endOnTurn = async (end: TurnEnd): Promise<void> => {
    closing = true;
    switch (end) {
      case TurnEnd.ModelRefused:
        finish(SessionEndReason.Error, modelRefusal(spec.model));
        return;
      case TurnEnd.SignedOut: {
        const message = `Codex says account "${spec.account.label}" is signed out.`;
        finish(SessionEndReason.AccountRefused, message, {
          problem: AccountProblem.SignedOut,
          message,
          seenIdentity: null,
        });
        return;
      }
      case TurnEnd.UsageLimit: {
        const limit = await currentLimit();
        if (done) return;
        events.push({
          type: 'rate_limit',
          status: 'rejected',
          resetsAt: limit?.resetsAt ?? null,
          utilization: limit?.utilization ?? null,
          limitType: limit?.limitType ?? null,
        });
        finish(SessionEndReason.RateLimited, 'Codex reports the usage limit is reached.');
        return;
      }
    }
  };

  /** Never throws: a throw in a notification handler would be an uncaught exception in the daemon. */
  function onNotification(n: { method: string; params: unknown }): void {
    if (done || closing) return;
    try {
      if (!hasKnownShape(n)) {
        log.warn({ method: n.method }, 'codex sent a notification of a shape 10db does not read');
        return;
      }
      if (n.method === 'turn/completed') {
        turnsCompleted += 1;
        const end = endOfTurn(n.params);
        if (end !== null) {
          void endOnTurn(end);
          return;
        }
      }
      const mapped = mapCodexNotification(n, state);
      if (started) for (const event of mapped) events.push(event);
    } catch (error) {
      log.error(
        { method: n.method, errName: error instanceof Error ? error.name : 'unknown' },
        'a codex notification could not be handled',
      );
    }
  }

  /** Steers the active turn, or starts one between turns. */
  const deliver = async (text: string): Promise<void> => {
    if (done || closing || threadId === null) return;
    try {
      if (state.turnId !== null) {
        try {
          await ask(
            'turn/steer',
            {
              threadId,
              expectedTurnId: state.turnId,
              input: [{ type: 'text', text }],
            },
            Acknowledged,
          );
          return;
        } catch (error) {
          // The turn may have ended as the message was sent; then it is a turn of its own.
          if (!(error instanceof CodexRpcError) || error.code === CLIENT_ERROR_CODE) throw error;
          log.warn({ method: 'turn/steer' }, 'codex refused to steer the turn');
        }
      }
      await startTurn(threadId, text);
    } catch (error) {
      if (error instanceof SessionOver) return;
      log.error(
        { errName: error instanceof Error ? error.name : 'unknown' },
        'a message could not be delivered to codex',
      );
      finish(SessionEndReason.Error, 'Codex did not accept a message sent to the session.');
    }
  };

  /** Asks the active turn to stop, waiting `graceMs` for the acknowledgement. */
  const interruptTurn = async (thread: string, turnId: string): Promise<void> => {
    if (rpc === null) return;
    const interrupt = rpc.call('turn/interrupt', { threadId: thread, turnId }, Acknowledged);
    let timer: { cancel(): void } = { cancel: () => undefined };
    const grace = new Promise<void>((resolve) => {
      timer = clock.setTimeout(resolve, graceMs);
    });
    try {
      await Promise.race([interrupt, grace, over]);
    } catch {
      // A refused interrupt, or a session that ended meanwhile, is the end of the wait.
    } finally {
      timer.cancel();
      interrupt.catch(() => undefined);
    }
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
    rpc.onNotification(onNotification);
    void rpc.exited.then(({ code }) => {
      if (stopRequested) finish(SessionEndReason.Stopped, null);
      else if (started)
        finish(
          SessionEndReason.Error,
          `Codex exited (${String(code)}) before the session ended.${stderrNote()}`,
        );
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

    threadId = thread.thread.id;
    started = true;
    events.push({ type: 'started', providerSessionId: thread.thread.id, pid: child.pid ?? null });
    try {
      await startTurn(thread.thread.id, spec.prompt);
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
    // A start that cannot finish its checks is refused, not a crash the runner would retry.
    const failed = started ? SessionEndReason.Error : SessionEndReason.SandboxRefused;
    if (error instanceof CallTimeout) {
      finish(failed, `${error.message}.${unlessStarted(started)}`);
      return;
    }
    if (error instanceof CodexRpcError) {
      finish(
        failed,
        `Codex could not start the session. ${noAccountWhy(START_CALL_MS, [stderrTail], spec.account.kind).printed}.${unlessStarted(started)}`,
      );
      return;
    }
    log.error(
      { errName: error instanceof Error ? error.name : 'unknown' },
      'a codex session failed to start',
    );
    finish(failed, `The Codex session could not start.${unlessStarted(started)}`);
  });

  return {
    events,
    send: (text) => {
      // One at a time, so messages reach Codex in the order they were sent.
      sends = sends.then(() => deliver(text));
    },
    stop: async () => {
      if (done) return;
      stopRequested = true;
      closing = true;
      const turnId = state.turnId;
      if (started && threadId !== null && turnId !== null) await interruptTurn(threadId, turnId);
      finish(SessionEndReason.Stopped, null);
    },
  };
}
