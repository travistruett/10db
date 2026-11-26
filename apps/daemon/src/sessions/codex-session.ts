import { homedir } from 'node:os';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AccountKind, AccountProblem, type AccountRefusal } from '@10db/contracts';
import { z } from 'zod';
import { systemClock, type Clock } from '../clock';
import { CODEX_VERIFIED_ON } from '../environment';
import { checkAccount, missingAccountRefusal, modelMatches, noAccountWhy } from './account-check';
import { secretFilesIn, YourMcpServer } from '../sandbox';
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
import {
  CODEX_HOOK_TIMEOUT_SECONDS,
  codexChildHome,
  codexHomeProviderOf,
  GUARD_HOOK_EVENT,
  type CodexHome,
  type CodexHomeProvider,
} from './codex-home';
import { codexDeveloperInstructions, codexThreadConfig, LANE_PROFILE } from './codex-lane-config';
import { CODEX_MCP_STATUS_BOUND_MS, McpAuthState, readCodexMcpAuth } from './codex-mcp-auth';
import { refusedToolCalls } from './codex-refused-calls';
import {
  createTurnState,
  hasKnownShape,
  mapCodexNotification,
  rateLimitEvents,
} from './codex-mapping';
import { CODEX_COMMANDS, codexCommandOf, type CodexCommandCall } from './codex-commands';
import { answerCommandApproval, type EscalationAnswer } from './codex-escalation';
import {
  BUILDER_REVIEWS,
  CodexApprovalDecision,
  COMMAND_APPROVAL_METHOD,
  CommandApprovalRequest,
  ConfigReadResponse,
  ESCALATIONS_TO_BUILDER,
  HooksListResponse,
  InitializeResponse,
  NO_APPROVALS,
  RateLimitsReadResponse,
  SERVER_REQUEST_RESOLVED,
  ServerRequestResolved,
  SkillsExtraRootsResponse,
  ThreadResponse,
  TurnCompleted,
  TurnStarted,
  TurnStartResponse,
  CompactStarted,
  ReviewStarted,
} from './codex-protocol';
import {
  CLIENT_ERROR_CODE,
  CodexRpcError,
  createCodexRpc,
  spawnAppServer,
  type CodexRpc,
  type ServerRequest,
} from './codex-rpc';
import type { ClaudeDenial } from './claude-tool-calls';
import { codexLoginStatus } from './codex-sign-in-check';
import { isFullAccess } from './full-access';
import type { SignInCheck } from './sign-in-check';
import {
  AccountProbeError,
  SessionEndReason,
  type SessionEvent,
  type SessionHandle,
  type AgentSessionSpec,
  type ShapeImage,
} from './types';

export interface CodexSessionDeps extends CodexAdapterOptions {
  /** The home for an account's `CODEX_HOME`. */
  readonly homes: (path: string, provider: CodexHomeProvider) => CodexHome;
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

/** The refusals kept for items still to complete; a call the agent never reports is dropped oldest first. */
const DENIALS_KEPT = 256;

/** The most of the child's stderr an `ended` message carries when the process exits unasked. */
const EXIT_STDERR_CHARS = 500;

/** A reply 10db reads nothing from. */
const Acknowledged = z.looseObject({});

/** How a failed turn ends the session, when it does: the kinds `turn/completed` names. */
const TurnEnd = {
  UsageLimit: 'usage_limit',
  SignedOut: 'signed_out',
  ModelRefused: 'model_refused',
  CannotBill: 'cannot_bill',
} as const;
type TurnEnd = (typeof TurnEnd)[keyof typeof TurnEnd];

/** A custom provider's model that Codex has no metadata for: a warning in an `error` item, not a failure. */
const METADATA_WARNING = 'Model metadata for';

const ErrorItem = z.looseObject({
  item: z.looseObject({ type: z.literal('error'), message: z.string() }),
});

/** OpenRouter answers 402 when the account's credit is spent. */
const PAYMENT_REQUIRED = 402;

const HttpFailure = z.looseObject({ httpStatusCode: z.number().optional() });

/** Whether a failed turn's error is a 402, by the status Codex names in `codexErrorInfo`. */
function isPaymentRequired(info: unknown): boolean {
  if (typeof info !== 'object' || info === null) return false;
  return Object.values(info).some(
    (value) => HttpFailure.safeParse(value).data?.httpStatusCode === PAYMENT_REQUIRED,
  );
}

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
  /** The app-server call a slash command is; null for a message to the model. */
  readonly command: CodexCommandCall | null;
  /** Goes only into a turn that is open: dropped, never a turn of its own, when none is. */
  readonly steerOnly: boolean;
}

/** The `clientUserMessageId` a message goes under, when it has one. */
const clientIdOf = (message: Outgoing): { clientUserMessageId?: string } =>
  message.uuid === undefined ? {} : { clientUserMessageId: message.uuid };

/**
 * The pictures as Codex's user input, after the text, in order: each a local image of its stored
 * file, which Codex reads itself, or, for a picture with no file (what a tool answered), an image
 * by its data URL.
 */
const pictureInputs = (images: readonly ShapeImage[]): readonly Record<string, string>[] =>
  images.map((image) =>
    image.path === undefined
      ? { type: 'image', url: `data:${image.mediaType};base64,${image.data}` }
      : { type: 'localImage', path: image.path },
  );

/** The text of a message a session that has started sends; nothing was prompted before then. */
const unlessStarted = (started: boolean): string => (started ? '' : ` ${NO_PROMPT}`);

/** The `sandbox` a Full access thread starts under; it wins over the home's `default_permissions`. */
const FULL_ACCESS_SANDBOX = 'danger-full-access';

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
export function startCodexSession(spec: AgentSessionSpec, deps: CodexSessionDeps): SessionHandle {
  const events = createChannel<SessionEvent>();
  const clock: Clock = deps.clock ?? systemClock;
  const log = deps.logger;
  const signInCheck: SignInCheck =
    deps.signInCheck ?? ((env) => codexLoginStatus(deps.codexPath, env));
  let rpc: CodexRpc | null = null;
  let done = false;
  let started = false;
  /** Refused calls shown so far, so two refused calls of one script keep distinct ids. */
  let refusals = 0;
  /** `stop` was called: the process is expected to end, and what it says no longer matters. */
  let stopRequested = false;
  /** The session is ending (a stop, or a failed turn that ends it), so notifications are no longer read. */
  let closing = false;
  let threadId: string | null = null;
  /** The model the next `turn/start` names: the spec's, until `setModel` picks another. */
  let model = spec.model;
  /** A chat the builder turned Full access on for: Codex's own full-access mode, still under 10db's guard hook. */
  const fullAccess = isFullAccess(spec);
  /**
   * A chat whose sandbox lets a blocked command ask to run outside it: Codex sends 10db each sandbox
   * escalation, which the chat's guard and then the builder answer. Every other session never asks.
   */
  const escalates =
    spec.profile.kind === 'explore' &&
    spec.sandbox?.settings.allowUnsandboxedCommands === true &&
    !fullAccess;
  const approvals = escalates
    ? { approvalPolicy: ESCALATIONS_TO_BUILDER, approvalsReviewer: BUILDER_REVIEWS }
    : { approvalPolicy: NO_APPROVALS };
  /** The escalations waiting on an answer, by request id: each stops when Codex or its turn no longer waits. */
  const escalations = new Map<number | string, { turnId: string; stop: AbortController }>();
  /** Turns that have completed, so a `turn/start` reply is not taken for a turn that already ended. */
  let turnsCompleted = 0;
  const state = createTurnState();
  const graceMs = deps.stopGraceMs ?? STOP_GRACE_MS;
  let sends: Promise<void> = Promise.resolve();
  /** Commands sent while a turn runs: each waits for the turn to end, apart from the steers behind it. */
  let heldCommands: Promise<void> = Promise.resolve();
  /**
   * Messages sent and not yet handed to Codex: 10db's own queue. Codex drops a steered message that
   * an interrupted turn had not taken yet, so these are what an interrupt leaves still to run.
   */
  const waiting = new Set<Outgoing>();
  /** The interrupt in flight, if any: no message is steered into the turn it stops. */
  let interrupting: Promise<void> = Promise.resolve();
  /** What each turn an interrupt waits on resolves when its `turn/completed` is read. */
  const turnEnds = new Map<string, () => void>();
  /** Commands waiting for no turn to run. */
  const idleWaiters: (() => void)[] = [];
  /**
   * The client uuids handed to each turn and not yet taken, by turn id: what a turn that ends first
   * dropped. A message started with waits under `starting` until its turn is named.
   */
  const handed = new Map<string, Set<string>>();
  /** Every client uuid a turn of this session took. */
  const taken = new Set<string>();
  /** The client uuid of a `turn/start` in flight, until its turn is named. */
  let starting: string | null = null;
  /** The `turn/start` in flight, if any; an interrupt waits for the turn it starts. */
  let startInFlight: Promise<void> | null = null;
  /** The turns the handle's `interrupt` stopped: their caller pushes again what they dropped. */
  const stoppedByHandle = new Set<string>();
  /** Notes `uuid` as handed to the turn `turnId`, unless a turn already took it. */
  const handTo = (turnId: string, uuid: string | undefined): void => {
    if (uuid === undefined || taken.has(uuid)) return;
    const uuids = handed.get(turnId) ?? new Set<string>();
    uuids.add(uuid);
    handed.set(turnId, uuids);
  };
  /** The uuids the ended turn was handed and did not take, unless the handle stopped it. */
  const droppedBy = (turnId: string): string[] => {
    const uuids = [...(handed.get(turnId) ?? [])].filter((uuid) => !taken.has(uuid));
    handed.delete(turnId);
    return stoppedByHandle.delete(turnId) ? [] : uuids;
  };
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
    // Closing the socket refuses every call still waiting on a card, and an escalation's card goes too.
    void guardSocket?.close().catch(() => undefined);
    for (const { stop } of escalations.values()) stop.abort();
    escalations.clear();
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
    const { why, printed } = noAccountWhy(START_CALL_MS, [stderrTail], spec.account.harness);
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
    message.includes(model) && /does not exist|unknown model/i.test(message);

  /** A server error that refuses the requested model. */
  const isModelRefusal = (error: unknown): boolean =>
    error instanceof CodexRpcError &&
    error.code !== CLIENT_ERROR_CODE &&
    refusesModel(error.message);

  /**
   * The setup's skill folders, listed by this session's own app-server before its thread starts (live
   * check L4: `skills.config` adds no folders). A root Codex refuses ends the start with no prompt.
   */
  const setSkillRoots = async (): Promise<void> => {
    const roots = spec.setup?.skillRoots ?? [];
    if (roots.length === 0) return;
    try {
      await ask('skills/extraRoots/set', { extraRoots: [...roots] }, SkillsExtraRootsResponse);
    } catch (error) {
      if (error instanceof CodexRpcError || error instanceof CallTimeout)
        throw sandboxRefused("Codex refused the session's skill folders.");
      throw error;
    }
  };

  const startThread = async (): Promise<z.infer<typeof ThreadResponse>> => {
    const developerInstructions = codexDeveloperInstructions(spec);
    // With no lane sandbox the profile is read-only over the checkout, whose secret files it denies.
    let secretFiles: string[] = [];
    if ((spec.sandbox ?? null) === null && !fullAccess) {
      try {
        secretFiles = await secretFilesIn(spec.cwd);
      } catch {
        throw sandboxRefused(
          "The checkout's secret files could not be listed, so none could be denied.",
        );
      }
    }
    const params = {
      cwd: spec.cwd,
      model: spec.model,
      ...approvals,
      // A Full access chat's thread runs Codex's own full-access mode; the home's lane profile gives way to it.
      ...(fullAccess ? { sandbox: FULL_ACCESS_SANDBOX } : {}),
      config: codexThreadConfig(spec, secretFiles),
      ...(developerInstructions === null ? {} : { developerInstructions }),
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
    if (!fullAccess && thread.activePermissionProfile?.id !== LANE_PROFILE)
      throw sandboxRefused('Codex runs the thread under a permission profile other than the lane.');
    // A reviewer other than 10db (Codex's own reviewer model) would answer an escape from the sandbox itself.
    if (escalates && thread.approvalsReviewer !== BUILDER_REVIEWS)
      throw sandboxRefused(
        'Codex would hand requests to run a command outside the sandbox to a reviewer other than 10db.',
      );
    if (!modelMatches(spec.model, thread.model))
      throw new StartRefused(
        SessionEndReason.BillingRefused,
        `Model check failed: 10db asked for ${spec.model} but Codex runs ${thread.model}. ${NO_PROMPT}`,
      );
    return thread;
  };

  /**
   * Lines naming the builder's OAuth servers that Codex reports signed out in this home, for the first turn.
   * A read that errors, or does not answer within Codex's own wait, names none: the prompt is never held for it.
   */
  const signedOutNotes = async (thread: string): Promise<string[]> => {
    const remote = Object.entries(spec.yourMcpServers)
      .filter(
        ([, server]) =>
          !(server.connect instanceof YourMcpServer) && server.connect.headers === null,
      )
      .map(([name]) => name);
    if (remote.length === 0) return [];
    const read = readCodexMcpAuth(ask, thread, remote, clock);
    // Whichever loses the race must not become an unhandled rejection.
    read.catch(() => undefined);
    try {
      const states = await Promise.race([
        read,
        pause(CODEX_MCP_STATUS_BOUND_MS).then((): null => null),
      ]);
      if (states === null) return [];
      return remote
        .filter((name) => states[name] === McpAuthState.NotSignedIn)
        .map(
          (name) =>
            `Note from 10db: ${name} isn't signed in for this account. The builder signs in to it under Settings › Trust. It is not in this session; don't look for its tools.`,
        );
    } catch (error) {
      if (error instanceof SessionOver) throw error;
      log.warn(
        { errName: error instanceof Error ? error.name : 'unknown' },
        'codex mcp sign-in status could not be read',
      );
      return [];
    }
  };

  /** The end of the child's stderr, for the message of a session that ended because the child did. */
  const stderrNote = (): string => {
    const tail = stderrTail.replace(/\s+/g, ' ').trim().slice(-EXIT_STDERR_CHARS);
    return tail === '' ? '' : ` Codex printed: "${tail}"`;
  };

  /** Begins a turn with `message`. The reply names the turn if its `turn/started` has not been read yet. */
  const startTurn = (thread: string, message: Outgoing): Promise<void> => {
    starting = message.uuid ?? null;
    const run = beginTurn(thread, message).finally(() => {
      starting = null;
      startInFlight = null;
    });
    startInFlight = run.catch(() => undefined);
    return run;
  };

  const beginTurn = async (thread: string, message: Outgoing): Promise<void> => {
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
        ...approvals,
        ...(fullAccess ? { sandboxPolicy: { type: 'dangerFullAccess' } } : {}),
        model,
        effort: spec.effort,
      },
      TurnStartResponse,
    );
    if (starting !== null) handTo(reply.turn.id, starting);
    starting = null;
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

  /** The text of the turn that ended the session on a refused payment. */
  let failedText = '';
  /** Whether the session has logged Codex's missing-metadata warning: it repeats every turn. */
  let warnedMetadata = false;

  /** What a failed turn ends the session on, when it names one. */
  const endOfTurn = (params: unknown): TurnEnd | null => {
    const parsed = TurnCompleted.safeParse(params);
    if (!parsed.success || parsed.data.turn.status !== 'failed') return null;
    const kind = errorKind(parsed.data.turn.error?.codexErrorInfo);
    if (kind === 'usageLimitExceeded') return TurnEnd.UsageLimit;
    if (kind === 'unauthorized') return TurnEnd.SignedOut;
    const error = parsed.data.turn.error;
    if (spec.account.kind === AccountKind.OpenRouter && isPaymentRequired(error?.codexErrorInfo)) {
      failedText = error?.message ?? 'payment required';
      return TurnEnd.CannotBill;
    }
    // Codex accepts an unknown model at thread/start, so a model the account cannot run fails only here.
    if (kind === 'badRequest' && refusesModel(parsed.data.turn.error?.message ?? ''))
      return TurnEnd.ModelRefused;
    return null;
  };

  const endOnTurn = async (end: TurnEnd): Promise<void> => {
    closing = true;
    switch (end) {
      case TurnEnd.ModelRefused:
        finish(SessionEndReason.ModelRefused, modelRefusal(model));
        return;
      case TurnEnd.CannotBill: {
        const message = `OpenRouter refused the turn for account "${spec.account.label}": ${failedText}`;
        finish(SessionEndReason.AccountRefused, message, {
          problem: AccountProblem.CannotBill,
          message,
          seenIdentity: null,
        });
        return;
      }
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
      if (n.method === 'turn/started') {
        // The turn a `turn/start` in flight began: its message is handed to it.
        const begun = TurnStarted.safeParse(n.params);
        if (begun.success && starting !== null) {
          handTo(begun.data.turn.id, starting);
          starting = null;
        }
      }
      if (n.method === 'item/completed') {
        const warning = ErrorItem.safeParse(n.params);
        if (warning.success && warning.data.item.message.startsWith(METADATA_WARNING)) {
          if (!warnedMetadata) {
            warnedMetadata = true;
            log.warn({ message: warning.data.item.message }, 'codex has no metadata for the model');
          }
          return;
        }
      }
      if (n.method === SERVER_REQUEST_RESOLVED) {
        const resolved = ServerRequestResolved.safeParse(n.params);
        if (resolved.success) escalations.get(resolved.data.requestId)?.stop.abort();
        return;
      }
      let ended: string | null = null;
      if (n.method === 'turn/completed') {
        turnsCompleted += 1;
        const completed = TurnCompleted.safeParse(n.params);
        if (completed.success) {
          ended = completed.data.turn.id;
          turnEnds.get(ended)?.();
          // An escalation still waiting would let a command out after its turn gave the checkout back.
          for (const waiting of escalations.values())
            if (waiting.turnId === ended) waiting.stop.abort();
        }
        const end = endOfTurn(n.params);
        if (end !== null) {
          void endOnTurn(end);
          return;
        }
      }
      const mapped = mapCodexNotification(n, state);
      for (const event of mapped) {
        if (event.type === 'consumed') for (const uuid of event.uuids) taken.add(uuid);
        if (event.type === 'turn_complete' && ended !== null) {
          const dropped = droppedBy(ended);
          if (started) events.push(dropped.length > 0 ? { ...event, dropped } : event);
        } else if (started) events.push(event);
      }
      // A command held for the turn to end goes now.
      if (state.turnId === null) for (const wake of idleWaiters.splice(0)) wake();
    } catch (error) {
      log.error(
        { method: n.method, errName: error instanceof Error ? error.name : 'unknown' },
        'a codex notification could not be handled',
      );
    }
  }

  /** Resolves once no turn runs and none is starting, or the session is ending. */
  const untilIdle = async (): Promise<void> => {
    for (;;) {
      if (done || closing) return;
      if (startInFlight !== null) {
        await startInFlight;
        continue;
      }
      if (state.turnId === null) return;
      await Promise.race([
        new Promise<void>((resolve) => idleWaiters.push(resolve)),
        over.catch(() => undefined),
      ]);
    }
  };

  /**
   * Sends a slash command as its own call once no turn runs: a command never steers (call 16).
   * Accepted or refused, the message it came in is reported consumed; a refusal is not retried.
   */
  const runCommand = async (message: Outgoing, command: CodexCommandCall): Promise<void> => {
    await untilIdle();
    waiting.delete(message);
    if (done || closing || threadId === null) return;
    try {
      switch (command.method) {
        case 'thread/compact/start':
          await ask(command.method, { threadId }, CompactStarted);
          break;
        case 'review/start': {
          const before = turnsCompleted;
          const reply = await ask(
            command.method,
            { threadId, target: command.target, delivery: 'inline' },
            ReviewStarted,
          );
          // The review runs as a turn, which is the active one until it completes.
          if (
            state.turnId === null &&
            turnsCompleted === before &&
            reply.turn.status === 'inProgress'
          )
            state.turnId = reply.turn.id;
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof CodexRpcError) || error.code === CLIENT_ERROR_CODE) throw error;
      log.warn({ method: command.method }, 'codex refused a command');
    }
    if (message.uuid !== undefined) {
      taken.add(message.uuid);
      events.push({ type: 'consumed', uuids: [message.uuid] });
    }
  };

  /** Steers the active turn, or starts one between turns; never the turn an interrupt is stopping. */
  const deliver = async (message: Outgoing): Promise<void> => {
    // An interrupt that starts while this one is awaited is waited on too: its receipt names the message.
    for (let awaited = interrupting; ; awaited = interrupting) {
      await awaited;
      if (awaited === interrupting) break;
    }
    if (message.command !== null) {
      try {
        await runCommand(message, message.command);
      } catch (error) {
        if (error instanceof SessionOver) return;
        log.error(
          { errName: error instanceof Error ? error.name : 'unknown' },
          'a command could not be delivered to codex',
        );
        finish(SessionEndReason.Error, 'Codex did not accept a command sent to the session.');
      }
      return;
    }
    waiting.delete(message);
    if (done || closing || threadId === null) return;
    try {
      const steered = state.turnId;
      if (steered !== null) {
        // Handed before the call: a turn that ends as the steer is answered dropped it.
        handTo(steered, message.uuid);
        try {
          await ask(
            'turn/steer',
            {
              threadId,
              expectedTurnId: steered,
              ...clientIdOf(message),
              input: [{ type: 'text', text: message.text }, ...pictureInputs(message.images)],
            },
            Acknowledged,
          );
          return;
        } catch (error) {
          // The turn may have ended as the message was sent; then it is a turn of its own.
          if (message.uuid !== undefined) handed.get(steered)?.delete(message.uuid);
          if (!(error instanceof CodexRpcError) || error.code === CLIENT_ERROR_CODE) throw error;
          log.warn({ method: 'turn/steer' }, 'codex refused to steer the turn');
        }
      }
      if (message.steerOnly) {
        log.warn({}, 'a message for the open turn was dropped: no turn is open to take it');
        return;
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
   * sent after it starts a turn of its own. A turn Codex has not reported ended by then may still be
   * running, and nothing may be steered into it: the session ends, and what it held goes to the next.
   */
  const stopTurn = async (thread: string, turnId: string): Promise<void> => {
    const turn = { ended: false };
    const ended = new Promise<void>((resolve) => {
      turnEnds.set(turnId, () => {
        turn.ended = true;
        resolve();
      });
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
    if (!turn.ended && !done) {
      closing = true;
      finish(
        SessionEndReason.Error,
        `Codex did not end the interrupted turn within ${String(graceMs / 1_000)} s, so the session was closed; its messages go to the next one.`,
      );
    }
  };

  /** The turn a `turn/start` in flight begins, waited for up to `graceMs`; null when none is named. */
  const turnStarting = async (): Promise<string | null> => {
    if (startInFlight === null) return state.turnId;
    let timer: { cancel(): void } = { cancel: () => undefined };
    const grace = new Promise<void>((resolve) => {
      timer = clock.setTimeout(resolve, graceMs);
    });
    try {
      await Promise.race([startInFlight, grace, over.catch(() => undefined)]);
    } finally {
      timer.cancel();
    }
    return state.turnId;
  };

  /** Keeps who refused a call for its item, which Codex reports as declined. */
  const noteDenial = (toolUseId: string, denial: ClaudeDenial): void => {
    state.denials.set(toolUseId, denial);
    // A refusal for an item the agent never reports is dropped, oldest first.
    if (state.denials.size > DENIALS_KEPT) {
      const [oldest] = state.denials.keys();
      if (oldest !== undefined) state.denials.delete(oldest);
    }
  };

  /** Hands a message to the open turn only, in order with every other message sent. */
  const enqueue = (message: Outgoing): void => {
    waiting.add(message);
    // One at a time, so messages reach Codex in the order they were sent. A command sent
    // mid-turn waits for the turn on a chain of its own, so a steer after it still reaches that turn.
    if (message.command !== null && state.turnId !== null) {
      heldCommands = heldCommands.then(() => deliver(message));
    } else {
      sends = sends.then(() => deliver(message));
    }
  };

  /**
   * Answers one request to run a blocked command outside the sandbox. A decline with a reason is steered
   * into the turn, since Codex's decline tells the model nothing; a request Codex stopped waiting on is not.
   */
  const answerEscalation = async ({
    id,
    params,
  }: ServerRequest): Promise<{ decision: CodexApprovalDecision }> => {
    const request = CommandApprovalRequest.safeParse(params);
    if (!request.success || done || closing) return { decision: CodexApprovalDecision.Decline };
    const stop = new AbortController();
    escalations.set(id, { turnId: request.data.turnId, stop });
    let answer: EscalationAnswer;
    try {
      answer = await answerCommandApproval(spec, {
        request: request.data,
        cwd: spec.cwd,
        signal: stop.signal,
        // Codex reports the escalated item itself once it is declined, so only its refusal is kept.
        onDenied: noteDenial,
      });
    } catch (error) {
      log.error(
        { errName: error instanceof Error ? error.name : 'unknown' },
        'a request to run a codex command outside the sandbox could not be answered',
      );
      answer = { decision: CodexApprovalDecision.Decline, steer: null };
    } finally {
      escalations.delete(id);
    }
    // The session's end aborts every escalation still waiting, so an aborted one covers it too.
    if (answer.steer !== null && !stop.signal.aborted)
      enqueue({ text: answer.steer, images: [], uuid: undefined, command: null, steerOnly: true });
    return { decision: answer.decision };
  };

  /** The guard hook's answer for one call; a throw here is a refusal, since the socket answers 500. */
  const judgeCall = async (hook: HookInput, signal: AbortSignal): Promise<GuardAnswer> => {
    try {
      const answer = await judgeHookCall(
        spec,
        { ...hook, cwd: hook.cwd ?? spec.cwd },
        signal,
        (toolUseId, denial, refused) => {
          noteDenial(toolUseId, denial);
          // Codex reports no item for a call its hook refused: the thread shows the call from the hook's input.
          if (started)
            for (const call of refusedToolCalls(refused, denial, clock.now().getTime(), refusals++))
              events.push({ type: 'tool_call', call });
        },
      );
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
    // A conversation with no lane sandbox runs read-only (`readOnlyPermissions`); a lane never starts without one.
    if ((spec.sandbox ?? null) === null && spec.profile.kind !== 'explore')
      throw sandboxRefused('10db refused to start Codex without the lane sandbox.');
    const codexHome = spec.env['CODEX_HOME'];
    if (codexHome === undefined || codexHome === '')
      throw sandboxRefused('The session has no CODEX_HOME, so Codex would run in the shared home.');

    const home = deps.homes(codexHome, codexHomeProviderOf(spec.account.kind));
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
      HOME: codexChildHome(spec.env).home,
      TENDB_MCP_TOKEN: spec.mcp.token,
      TENDB_GUARD_SOCKET: socketPath,
      // A card the hook raises waits on the builder, so the hook's own wait bounds it, not a tool's.
      TENDB_GUARD_MAX_SECONDS: String(
        Math.ceil((spec.hookWaitMs ?? spec.mcp.toolTimeoutMs) / 1_000),
      ),
    };
    const child = (deps.spawn ?? spawnAppServer)(deps.codexPath, childEnv());
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_KEPT_CHARS);
    });
    rpc = createCodexRpc(child, log);
    rpc.onNotification(onNotification);
    // Any other session leaves the request unanswered (-32601), which Codex reads as declined.
    if (escalates) rpc.onRequest(COMMAND_APPROVAL_METHOD, answerEscalation);
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
    await setSkillRoots();
    const thread = await startThread();

    threadId = thread.thread.id;
    started = true;
    events.push({ type: 'started', providerSessionId: thread.thread.id, pid: child.pid ?? null });
    events.push({ type: 'commands', commands: CODEX_COMMANDS });
    const notes = await signedOutNotes(thread.thread.id);
    try {
      await startTurn(thread.thread.id, {
        text: notes.length === 0 ? spec.prompt : `${notes.join('\n')}\n\n${spec.prompt}`,
        images: spec.images ?? [],
        uuid: spec.promptUuid,
        steerOnly: false,
        command: null,
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
        `Codex could not start the session. ${noAccountWhy(START_CALL_MS, [stderrTail], spec.account.harness).printed}.${unlessStarted(started)}`,
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
    send: (text, images = [], uuid, options) => {
      enqueue({
        text,
        images,
        uuid,
        command: codexCommandOf(text),
        steerOnly: options?.steerOnly === true,
      });
    },
    // The receipt names what 10db still holds: each runs once the interrupted turn has ended.
    interrupt: async () => {
      const stillQueued = [...waiting].flatMap((m) => (m.uuid === undefined ? [] : [m.uuid]));
      // A message whose `turn/start` is in flight was handed over: the turn it starts is stopped.
      const stopping = (async () => {
        const turnId = await turnStarting();
        if (done || threadId === null || turnId === null) return;
        stoppedByHandle.add(turnId);
        await stopTurn(threadId, turnId);
      })();
      interrupting = stopping;
      await stopping;
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
    setModel: (next) => {
      model = next;
      return Promise.resolve();
    },
  };
}
