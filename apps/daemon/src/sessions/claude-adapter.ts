import { query as sdkQuery, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { systemClock } from '../clock';
import { AUTOUPDATE_OFF } from '../environment';
import { checkAccount, seenFrom, type SeenAccount } from './account-check';
import { createChannel } from './channel';
import { startClaudeLogin, type LoginSpawn } from './claude-connect';
import { seenModelsFrom } from './claude-model-list';
import { userMessage } from './claude-mapping';
import {
  LANE_STARTS,
  refusedSession,
  spawnClaude,
  startClaudeSession,
  startShapeSession,
  UNSANDBOXED_REFUSAL,
  type ClaudeSessionDeps,
  type QueryFn,
} from './claude-session';
import { settleWithin } from './settle-within';
import { claudeAuthStatus, type SignInCheck } from './sign-in-check';
import {
  AccountProbeError,
  CompletionError,
  ConversationUnreadError,
  type AccountProbeSpec,
  type CompletionSpec,
  type LanePermissionMode,
  type SessionAdapter,
} from './types';

/** How long an identity probe waits for `accountInfo()`. */
const IDENTITY_PROBE_MS = 15_000;

export interface ClaudeAdapterOptions extends ClaudeSessionDeps {
  /** The injected harness plugin directory. */
  readonly pluginDir: string;
  /**
   * The permission mode a sandboxed session runs in, over the one its spec carries. Only the live
   * test sets it, to pin a mode whatever the app-wide setting says.
   */
  readonly lanePermissionMode?: LanePermissionMode;
  /**
   * Asks whether the account a session runs on is signed in, when a start gets no account. Defaults to
   * `claude auth status` on `claudePath`; tests answer it so none of them runs the builder's claude.
   */
  readonly signInCheck?: SignInCheck;
  /** Starts `claude auth login`; tests stand in for the process. */
  readonly spawnLogin?: LoginSpawn;
  /** The SDK's query(); tests pass a scripted one. */
  readonly query?: QueryFn;
  /**
   * Lets a session with no lane sandbox start. Only tests that script the SDK set it: the daemon
   * sandboxes every real session, and this adapter refuses one that arrives without a sandbox.
   */
  readonly allowUnsandboxed?: true;
}

/** Ends the stream so the process exits; anything it throws after the abort means nothing here. */
async function drain(q: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const message of q) if (message === undefined) break;
  } catch {
    return;
  }
}

/** Claude Code started only to say who it is: no prompt, no project settings, no MCP servers, no tools. */
async function probeAccount(
  probe: AccountProbeSpec,
  opts: ClaudeAdapterOptions,
  runQuery: QueryFn,
): Promise<SeenAccount> {
  const clock = opts.clock ?? systemClock;
  const input = createChannel<SDKUserMessage>();
  const abortController = new AbortController();
  const q = runQuery({
    prompt: input,
    options: {
      cwd: probe.cwd,
      env: { ...probe.env, ...AUTOUPDATE_OFF },
      pathToClaudeCodeExecutable: opts.claudePath,
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: 'default',
      canUseTool: () =>
        Promise.resolve({ behavior: 'deny', message: 'An identity probe runs no tools.' }),
      abortController,
    },
  });
  try {
    const info = await settleWithin(clock, q.accountInfo(), IDENTITY_PROBE_MS);
    if (!info)
      throw new AccountProbeError(
        `Claude Code reported no account within ${String(IDENTITY_PROBE_MS / 1_000)} s`,
      );
    // The list answers even for a signed-out process, so it is kept apart from the identity: the caller
    // writes it only after the account check passes. A list that cannot be read leaves the stored one.
    const models = seenModelsFrom(
      await settleWithin(clock, q.supportedModels(), IDENTITY_PROBE_MS),
    );
    return { ...seenFrom(info), ...(models === undefined ? {} : { models }) };
  } finally {
    input.end();
    abortController.abort();
    void drain(q);
  }
}

/** How long a one-shot question may take before it is given up on, unless it says otherwise. */
const COMPLETION_MS = 120_000;

/**
 * One question to the model: Claude Code starts in an empty folder with no tool, no settings file,
 * no MCP server and no saved session, proves it is the expected account, and answers in one turn.
 */
async function complete(
  ask: CompletionSpec,
  opts: ClaudeAdapterOptions,
  runQuery: QueryFn,
): Promise<string> {
  if (ask.signal?.aborted === true) throw new CompletionError('The question was withdrawn.');
  const clock = opts.clock ?? systemClock;
  const input = createChannel<SDKUserMessage>();
  const abortController = new AbortController();
  const q = runQuery({
    prompt: input,
    options: {
      cwd: ask.cwd,
      env: { ...ask.env, ...AUTOUPDATE_OFF },
      model: ask.model,
      ...(ask.effort === undefined ? {} : { effort: ask.effort }),
      pathToClaudeCodeExecutable: opts.claudePath,
      settingSources: [],
      strictMcpConfig: true,
      tools: [],
      maxTurns: 1,
      persistSession: false,
      permissionMode: 'default',
      canUseTool: () =>
        Promise.resolve({ behavior: 'deny', message: 'A question to the model runs no tools.' }),
      abortController,
    },
  });
  let timer: { cancel(): void } = { cancel: () => undefined };
  const timeout = new Promise<never>((_, reject) => {
    timer = clock.setTimeout(() => {
      reject(new CompletionError('The model did not answer in time.'));
    }, ask.timeoutMs ?? COMPLETION_MS);
  });
  // A caller that gives up ends the question now, not when the model would have answered.
  let withdrawn: () => void = () => undefined;
  const withdrawal = new Promise<never>((_, reject) => {
    withdrawn = () => {
      reject(new CompletionError('The question was withdrawn.'));
    };
    ask.signal?.addEventListener('abort', withdrawn, { once: true });
  });
  const answer = (async () => {
    const info = await q.accountInfo();
    const refusal = checkAccount(ask.account, seenFrom(info));
    if (refusal) throw new CompletionError(`${refusal.message}. Nothing was sent.`);
    input.push(userMessage(ask.prompt));
    input.end();
    for await (const message of q) {
      if (message.type !== 'result') continue;
      if (message.subtype === 'success' && !message.is_error) return message.result;
      throw new CompletionError(
        message.subtype === 'success' ? message.result : `The model stopped: ${message.subtype}.`,
      );
    }
    throw new CompletionError('The model ended without an answer.');
  })();
  try {
    return await Promise.race([answer, timeout, withdrawal]);
  } catch (error) {
    throw error instanceof CompletionError
      ? error
      : new CompletionError(error instanceof Error ? error.message : 'The model failed.');
  } finally {
    timer.cancel();
    ask.signal?.removeEventListener('abort', withdrawn);
    input.end();
    abortController.abort();
    void drain(q);
    // Whichever of the answer, the timeout and the withdrawal lost the race must not become an
    // unhandled rejection.
    answer.catch(() => undefined);
    timeout.catch(() => undefined);
    withdrawal.catch(() => undefined);
  }
}

/** Runs managed sessions on the builder's installed Claude Code through the Agent SDK (spec §3). */
export function createClaudeAdapter(opts: ClaudeAdapterOptions): SessionAdapter {
  const runQuery: QueryFn = opts.query ?? ((params) => sdkQuery(params));
  return {
    start: (spec) =>
      (spec.sandbox ?? null) === null && opts.allowUnsandboxed !== true
        ? refusedSession(UNSANDBOXED_REFUSAL)
        : startClaudeSession(
            {
              profile: 'lane',
              spec,
              pluginDir: opts.pluginDir,
              ...(opts.lanePermissionMode === undefined
                ? {}
                : { lanePermissionMode: opts.lanePermissionMode }),
              signInCheck: opts.signInCheck ?? ((env) => claudeAuthStatus(opts.claudePath, env)),
            },
            opts,
            runQuery,
            LANE_STARTS,
          ),
    startShape: (spec) =>
      startShapeSession(spec, {
        claudePath: opts.claudePath,
        logger: opts.logger,
        query: runQuery,
        spawn: (options, onSpawn) =>
          spawnClaude(
            options,
            {
              onSpawn,
              onStderr: (chunk) => {
                opts.logger.debug({ stderr: chunk.slice(0, 500) }, 'plan claude stderr');
              },
            },
            'interactive',
          ),
        ...(opts.stopGraceMs === undefined ? {} : { stopGraceMs: opts.stopGraceMs }),
        ...(opts.clock === undefined ? {} : { clock: opts.clock }),
      }),
    probeAccount: (probe) => probeAccount(probe, opts, runQuery),
    startLogin: (login) =>
      startClaudeLogin(login, {
        claudePath: opts.claudePath,
        logger: opts.logger,
        ...(opts.spawnLogin === undefined ? {} : { spawn: opts.spawnLogin }),
        ...(opts.clock === undefined ? {} : { clock: opts.clock }),
      }),
    complete: (ask) => complete(ask, opts, runQuery),
    // A message pushed before a restart is pushed again to a resumed Claude Code session.
    readClientUuids: (spec) =>
      Promise.reject(
        new ConversationUnreadError(
          `10db does not read back Claude Code conversation ${spec.providerSessionId}`,
        ),
      ),
  };
}
