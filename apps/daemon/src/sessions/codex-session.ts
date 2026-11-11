import { homedir } from 'node:os';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AccountProblem, type AccountRefusal } from '@10db/contracts';
import { z } from 'zod';
import { systemClock, type Clock } from '../clock';
import { CODEX_VERIFIED_ON } from '../environment';
import { checkAccount, missingAccountRefusal, modelMatches, noAccountWhy } from './account-check';
import { createChannel } from './channel';
import { CODEX_CLIENT_INFO, readSeenAccount, type CodexCall } from './codex-account-read';
import type { CodexAdapterOptions } from './codex-adapter';
import {
  judgeHookCall,
  openGuardSocket,
  type GuardAnswer,
  type GuardSocket,
  type HookInput,
} from './codex-guard';
import { CODEX_HOOK_TIMEOUT_SECONDS, GUARD_HOOK_EVENT, type CodexHome } from './codex-home';
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
  type ShapeImage,
} from './types';

export interface CodexSessionDeps extends CodexAdapterOptions {
  /** The home for an account's `CODEX_HOME`. */
  readonly homes: (path: string) => CodexHome;
}

/** How long one call of the start sequence may take before the session ends. */
const START_CALL_MS = 60_000;

/** The read that names the workspace, which a slow or failing ChatGPT backend can fail once. */
const USAGE_READ = 'account/rateLimits/read';

/** How many times the start reads the usage before it gives up. */
export const USAGE_READ_TRIES = 3;

/** How long the start waits on the clock between two usage reads. */
export const USAGE_READ_RETRY_MS = 2_000;

/** The most of the child's stderr kept for a message. */
const STDERR_KEPT_CHARS = 4096;

const TRUSTED = 'trusted';

type HookEntry = z.infer<typeof HooksListResponse>['data'][number]['hooks'][number];

/** Where session sockets live when the adapter is given no directory: short enough for a socket path. */
const defaultSocketDir = (): string => join(homedir(), '.10db', 'run');

/**
 * The socket directory is the files root every session's socket shares, private to this user, so no
 * other user can reach a session's guard; no lane can, since every sandbox denies the root.
 */
const SOCKET_DIR_MODE = 0o700;

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

/**
 * A message on its way to Codex: its text, the pictures that go with it, and the client uuid it goes
 * under, which the thread records on the user message a turn takes it in.
 */
interface Outgoing {
  readonly text: string;
  readonly images: readonly ShapeImage[];
  readonly uuid: string | undefined;
}

/** The `clientUserMessageId` a message goes under, when it has one. */
const clientIdOf = (message: Outgoing): { clientUserMessageId?: string } =>
  message.uuid === undefined ? {} : { clientUserMessageId: message.uuid };

/**
 * The pictures as Codex's user input, after the text, in order: a stored picture as a local image
 * Codex reads itself, one with no file as an image of its bytes.
 */
const pictureInputs = (images: readonly ShapeImage[]): readonly Record<string, string>[] =>
  images.map((image) =>
    image.path === undefined
      ? { type: 'image', url: `data:${image.mediaType};base64,${image.data}` }
      : { type: 'localImage', path: image.path },
  );

/** The text of a message a session that has started sends; nothing was prompted before then. */
const unlessStarted = (started: boolean): string => (started ? '' : ` ${NO_PROMPT}`);

const modelRefusal = (model: string): string =>
  `Codex refused the model "${model}" on this account.`;

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

/** A read of who the account is that got no answer: the message names the read and how it failed. */
class AccountUnread extends Error {
  override readonly name = 'AccountUnread';
}

/** How a failed read failed, in words that hold nothing Codex sent. */
const howItFailed = (error: CodexRpcError | CallTimeout): string =>
  error instanceof CallTimeout
    ? `no answer within ${String(START_CALL_MS / 1_000)} s`
    : 'an error from Codex';

/** A read that may answer if asked again: it went unanswered, or the server failed it. */
const mayAnswerAgain = (error: CodexRpcError | CallTimeout): boolean =>
  error instanceof CallTimeout || error.code !== CLIENT_ERROR_CODE;

const sandboxRefused = (message: string): StartRefused =>
  new StartRefused(SessionEndReason.SandboxRefused, `${message} ${NO_PROMPT}`);

/** The version a user agent such as `codex/0.154.0 (...)` names, which is all that is ever logged. */
function versionOf(userAgent: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(userAgent)?.[1] ?? null;
}

/**
 * Starts a Codex session behind the adapter's safety checks and emits `started` only once every one
 * has passed. A check that fails or cannot complete before `started` ends it `sandbox_refused`, an
 * account that is not the expected one or a signed-out home `account_refused`, and only a refused
 * model, a failed resume or an account that can't be read `error`; no prompt is sent and the child is
 * closed on every path. Each call runs under a deadline on the injected clock.
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
  /**
   * Messages sent and not yet handed to Codex: 10db's own queue. Codex drops a steered message that
   * an interrupted turn had not taken yet, so these are what an interrupt leaves still to run.
   */
  const waiting = new Set<Outgoing>();
  /** The interrupt in flight, if any: no message is steered into the turn it stops. */
  let interrupting: Promise<void> = Promise.resolve();
  /** What each turn an interrupt waits on resolves when its `turn/completed` is read. */
  const turnEnds = new Map<string, () => void>();
  let guardSocket: GuardSocket | null = null;
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
    // Closing the socket refuses every call still waiting on a card.
    void guardSocket?.close().catch(() => undefined);
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

  /** Waits `ms` on the clock; a session that ends meanwhile ends the wait with `SessionOver`. */
  const pause = async (ms: number): Promise<void> => {
    let timer: { cancel(): void } = { cancel: () => undefined };
    const waited = new Promise<void>((resolve) => {
      timer = clock.setTimeout(resolve, ms);
    });
    try {
      await Promise.race([waited, over]);
    } finally {
      timer.cancel();
    }
  };

  /**
   * `ask` for the account reads, the usage read asked again a few times: one slow answer or server
   * error says nothing of the account. A read that still fails is an `AccountUnread`.
   */
  const askAccount: CodexCall = async (method, params, schema) => {
    const tries = method === USAGE_READ ? USAGE_READ_TRIES : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await ask(method, params, schema);
      } catch (error) {
        if (!(error instanceof CodexRpcError || error instanceof CallTimeout)) throw error;
        if (attempt >= tries || !mayAnswerAgain(error)) {
          const who = `account "${spec.account.label}"`;
          throw new AccountUnread(
            method === USAGE_READ
              ? `Codex could not read the usage of ${who}, which names its workspace (the usage read, ${USAGE_READ}): ${howItFailed(error)}, on ${attempt === 1 ? 'the one try' : `each of ${String(attempt)} tries`}`
              : `Codex could not read ${who} (${method}): ${howItFailed(error)}`,
          );
        }
        log.warn({ method, attempt }, 'codex did not answer the usage read; asking again');
        await pause(USAGE_READ_RETRY_MS);
      }
    }
  };

  /**
   * The account could not be read. Only a home the sign-in command calls signed out waits for its
   * sign-in; any other is a start that failed, which the runner recovers from, so a slow or failing
   * read never pauses the account.
   */
  const failUnreadAccount = async (unread: AccountUnread): Promise<never> => {
    const signIn = await signInCheck(childEnv());
    const { why, printed } = noAccountWhy(START_CALL_MS, [stderrTail], spec.account.kind);
    const refusal =
      signIn === 'signed_out' ? missingAccountRefusal(spec.account, why, printed, signIn) : null;
    if (refusal !== null)
      throw new StartRefused(
        SessionEndReason.AccountRefused,
        `${refusal.message}. ${NO_PROMPT}`,
        refusal,
      );
    throw new StartRefused(SessionEndReason.Error, `${unread.message}. ${printed}. ${NO_PROMPT}`);
  };

  /**
   * A sign-in whose usage read names no workspace is refused: the identity is the email and the
   * workspace, so the email alone matches nothing.
   */
  const noWorkspaceRefusal = (): StartRefused => {
    const message = `Codex reported a ChatGPT sign-in with no workspace for account "${spec.account.label}", so it can't be checked against the confirmed one`;
    return new StartRefused(SessionEndReason.AccountRefused, `${message}. ${NO_PROMPT}`, {
      problem: AccountProblem.IdentityMismatch,
      message,
      seenIdentity: null,
    });
  };

  const verifyAccount = async (): Promise<void> => {
    let seen;
    try {
      seen = await readSeenAccount(askAccount, false);
    } catch (error) {
      if (error instanceof AccountUnread) return failUnreadAccount(error);
      if (error instanceof AccountProbeError) throw noWorkspaceRefusal();
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
    // A hook that times out lets its call run, so one waiting on a card must outlast the longest wait.
    const timeout = hook.timeoutSec;
    if (timeout === null || timeout === undefined)
      throw sandboxRefused(
        "Codex does not report the guard hook's timeout, so a call waiting on a card could run when it ends.",
      );
    if (timeout < CODEX_HOOK_TIMEOUT_SECONDS)
      throw sandboxRefused(
        `Codex runs the guard hook with a ${String(timeout)} s timeout, under the ${String(CODEX_HOOK_TIMEOUT_SECONDS)} s 10db sets, so a call waiting on a card could run when it ends.`,
      );
  };

  /**
   * Whether a message names the requested model and says it does not exist or is unknown: the account cannot
   * run it. An error that merely names it (at capacity, a context window exceeded) is not a refusal.
   */
  const refusesModel = (message: string): boolean =>
    message.includes(spec.model) && /does not exist|unknown model/i.test(message);

  /** A server error that refuses the requested model. */
  const isModelRefusal = (error: unknown): boolean =>
    error instanceof CodexRpcError &&
    error.code !== CLIENT_ERROR_CODE &&
    refusesModel(error.message);

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
        throw new StartRefused(SessionEndReason.ModelRefused, modelRefusal(spec.model));
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

  /** Begins a turn with `message`. The reply names the turn if its `turn/started` has not been read yet. */
  const startTurn = async (thread: string, message: Outgoing): Promise<void> => {
    const before = turnsCompleted;
    const reply = await ask(
      'turn/start',
      {
        threadId: thread,
        ...clientIdOf(message),
        input: [
          { type: 'text', text: message.text, text_elements: [] },
          ...pictureInputs(message.images),
        ],
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
    // Codex accepts an unknown model at thread/start, so a model the account cannot run fails only here.
    if (kind === 'badRequest' && refusesModel(parsed.data.turn.error?.message ?? ''))
      return TurnEnd.ModelRefused;
    return null;
  };

  const endOnTurn = async (end: TurnEnd): Promise<void> => {
    closing = true;
    switch (end) {
      case TurnEnd.ModelRefused:
        finish(SessionEndReason.ModelRefused, modelRefusal(spec.model));
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
        const completed = TurnCompleted.safeParse(n.params);
        if (completed.success) turnEnds.get(completed.data.turn.id)?.();
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

  /** Steers the active turn, or starts one between turns; never the turn an interrupt is stopping. */
  const deliver = async (message: Outgoing): Promise<void> => {
    // An interrupt that starts while this one is awaited is waited on too: its receipt names the message.
    for (let awaited = interrupting; ; awaited = interrupting) {
      await awaited;
      if (awaited === interrupting) break;
    }
    waiting.delete(message);
    if (done || closing || threadId === null) return;
    try {
      if (state.turnId !== null) {
        try {
          await ask(
            'turn/steer',
            {
              threadId,
              expectedTurnId: state.turnId,
              ...clientIdOf(message),
              input: [{ type: 'text', text: message.text }, ...pictureInputs(message.images)],
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
      await startTurn(threadId, message);
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

  /**
   * Interrupts the active turn and waits, up to `graceMs`, for Codex to report it ended, so a message
   * sent after it starts a turn of its own.
   */
  const stopTurn = async (thread: string, turnId: string): Promise<void> => {
    const ended = new Promise<void>((resolve) => {
      turnEnds.set(turnId, resolve);
    });
    let timer: { cancel(): void } = { cancel: () => undefined };
    const grace = new Promise<void>((resolve) => {
      timer = clock.setTimeout(resolve, graceMs);
    });
    try {
      await Promise.race([
        Promise.all([interruptTurn(thread, turnId), ended]),
        grace,
        over.catch(() => undefined),
      ]);
    } finally {
      timer.cancel();
      turnEnds.delete(turnId);
    }
  };

  /** The guard hook's answer for one call; a throw here is a refusal, since the socket answers 500. */
  const judgeCall = async (hook: HookInput, signal: AbortSignal): Promise<GuardAnswer> => {
    try {
      const answer = await judgeHookCall(spec, { ...hook, cwd: hook.cwd ?? spec.cwd }, signal);
      if (!answer.allow && answer.interrupt && threadId !== null && state.turnId !== null)
        void interruptTurn(threadId, state.turnId);
      return answer;
    } catch (error) {
      log.error(
        { tool: hook.tool_name, errName: error instanceof Error ? error.name : 'unknown' },
        'the guard could not judge a codex tool call',
      );
      throw error;
    }
  };

  /** Opens the session's guard socket in a private directory; the hook cannot run without it. */
  const openGuard = async (): Promise<string> => {
    const socketDir = deps.socketDir ?? defaultSocketDir();
    try {
      await mkdir(socketDir, { recursive: true, mode: SOCKET_DIR_MODE });
      const path = guardSocketPath(socketDir, spec.sessionId);
      const socket = await openGuardSocket(path, judgeCall, (code) => {
        log.error({ code }, 'the guard socket reported an error');
      });
      if (done) {
        await socket.close();
        throw new SessionOver();
      }
      guardSocket = socket;
      return path;
    } catch (error) {
      if (error instanceof SessionOver) throw error;
      log.error(
        { errName: error instanceof Error ? error.name : 'unknown' },
        'the guard socket could not be opened',
      );
      throw sandboxRefused(
        'The guard socket could not be opened, so no tool call could be checked.',
      );
    }
  };

  const run = async (): Promise<void> => {
    if ((spec.sandbox ?? null) === null)
      throw sandboxRefused('10db refused to start Codex without the lane sandbox.');
    const codexHome = spec.env['CODEX_HOME'];
    if (codexHome === undefined || codexHome === '')
      throw sandboxRefused('The session has no CODEX_HOME, so Codex would run in the shared home.');

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

    const socketPath = await openGuard();
    homeEnv = {
      HOME: home.emptyHome,
      TENDB_MCP_TOKEN: spec.mcp.token,
      TENDB_GUARD_SOCKET: socketPath,
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
      await startTurn(thread.thread.id, {
        text: spec.prompt,
        images: spec.images ?? [],
        uuid: spec.promptUuid,
      });
    } catch (error) {
      if (isModelRefusal(error))
        throw new StartRefused(SessionEndReason.ModelRefused, modelRefusal(spec.model));
      throw error;
    }
  };

  // Messages sent while the session starts wait here for the first turn to begin.
  sends = run().catch((error: unknown) => {
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
    send: (text, images = [], uuid) => {
      const message: Outgoing = { text, images, uuid };
      waiting.add(message);
      // One at a time, so messages reach Codex in the order they were sent.
      sends = sends.then(() => deliver(message));
    },
    // The receipt names what 10db still holds: each runs once the interrupted turn has ended.
    interrupt: async () => {
      const stillQueued = [...waiting].flatMap((m) => (m.uuid === undefined ? [] : [m.uuid]));
      const turnId = state.turnId;
      if (!done && threadId !== null && turnId !== null) {
        interrupting = stopTurn(threadId, turnId);
        await interrupting;
      }
      return { stillQueued };
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
