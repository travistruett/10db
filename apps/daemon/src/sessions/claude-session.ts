import { spawn } from 'node:child_process';
import type {
  AccountInfo,
  HookJSONOutput,
  McpServerConfig,
  Options,
  Query,
  SDKSystemMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import { AccountKind, type AccountRefusal, type ModelMarkBasis } from '@10db/contracts';
import { systemClock, type Clock } from '../clock';
import { AUTOUPDATE_OFF } from '../environment';
import type { Logger } from '../log';
import { atPriority } from '../priority';
import {
  checkAccount,
  checkInitCredentials,
  credentialProblem,
  missingAccountRefusal,
  modelMatches,
  noAccountWhy,
  seenFrom,
} from './account-check';
import { createChannel } from './channel';
import {
  interruptReceipt,
  mapSdkMessage,
  modelRefusalOf,
  toSdkMcpServer,
  toShapeHookOutput,
  userMessage,
} from './claude-mapping';
import { ReportedMode } from '../trust';
import { renderClaudeAutoMode } from './claude-auto-mode';
import { claudeQueryOptions } from './claude-query-options';
import {
  canUseToolBridge,
  createHookCwds,
  isClassifierEscalation,
  measurementHooks,
  preToolUseHook,
  settingsRecheckHooks,
  type ToolGate,
} from './claude-session-hooks';
import { contextEvent } from './context-event';
import { currentToolNames } from './mcp-tool-names';
import { TENDB_MCP_SERVER } from './project-mcp';
import { projectSettingsBillingProblem } from './project-settings';
import { settleWithin } from './settle-within';
import type { SignInCheck, SignInState } from './sign-in-check';
import {
  SessionEndReason,
  type LanePermissionMode,
  type SessionEvent,
  type AgentSessionCore,
  type SessionHandle,
  type ShapeImage,
  type ExploreSessionSpec,
  type LaneSessionSpec,
} from './types';

export const CLAUDE_MCP_SERVER = TENDB_MCP_SERVER;
/** How long each start of a lane's Claude Code may take to report its account before the prompt is sent. */
const START_WAITS_MS: readonly number[] = [30_000, 60_000, 120_000];
/** The pause before a lane's second start, and before its third. */
const START_BACKOFF_MS: readonly number[] = [10_000, 30_000];
/** The latest stderr of one start that is kept to say what Claude Code printed. */
const STDERR_KEPT_CHARS = 4_000;
const STOP_GRACE_MS = 5_000;
/** How long a halting hook answer has to reach claude before the process is closed under it. */
const HALT_GRACE_MS = 1_000;
const STDERR_LOG_CHARS = 2_000;
/** What Claude Code's error says when it rejects the settings it was started with, the sandbox among them. */
const SANDBOX_SETTINGS_ERROR = 'Error processing settings';

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

/**
 * What a sandboxed lane runs in when neither the adapter nor the session's spec names a mode. The
 * hook asks 10db about the calls the classifier must not settle
 * (docs/architecture/decisions/2026-10-31-lanes-run-in-auto-mode-inside-the-sandbox.md).
 */
const LANE_PERMISSION_MODE: LanePermissionMode = 'auto';

function laneMode(
  spec: LaneSessionSpec,
  deps: Pick<QueryDeps, 'lanePermissionMode'>,
): LanePermissionMode {
  return deps.lanePermissionMode ?? spec.profile.lanePermissionMode ?? LANE_PERMISSION_MODE;
}

export const UNSANDBOXED_REFUSAL =
  '10db refused to start Claude Code without the lane sandbox. This is a bug in 10db; nothing ran.';

/** A session that ends at once with `message`, before claude is spawned. */
export function refusedSession(message: string): SessionHandle {
  const events = createChannel<SessionEvent>();
  events.push({ type: 'ended', reason: 'error', message });
  events.end();
  return {
    events,
    send: () => undefined,
    interrupt: () => Promise.resolve(null),
    stop: () => Promise.resolve(),
  };
}

export interface QueryDeps {
  readonly claudePath: string;
  readonly pluginDir: string;
  readonly abortController: AbortController;
  /** Resolves true once the session's credentials match its billing mode; tools wait for it. */
  readonly billingVerified: Promise<boolean>;
  readonly onSpawn: (pid: number | null) => void;
  readonly onStderr: (chunk: string) => void;
  /** Re-checks the project's settings after something may have changed them; its output can halt the agent. */
  readonly recheckSettings: (what: string) => HookJSONOutput;
  /** True once the session has been refused after it started; every tool is denied from then on. */
  readonly isRefused: () => boolean;
  /** The mode a sandboxed session runs in, over its spec's; `LANE_PERMISSION_MODE` when neither names one. */
  readonly lanePermissionMode?: LanePermissionMode;
  /** The tool names the session has now, asked for a call to an MCP tool and handed to `canUseTool` with it. */
  readonly listedTools?: () => Promise<readonly string[]>;
}

/** Spawns claude as our own child, so recovery knows its pid and the log gets its stderr. */
export function spawnClaude(
  options: SpawnOptions,
  deps: Pick<QueryDeps, 'onSpawn' | 'onStderr'>,
  priority: 'lane' | 'interactive' = 'lane',
): SpawnedProcess {
  // The SDK's forwarded signal fires after its graceful stdin-close path, so it is not handed to spawn().
  // Background priority for a lane and everything it starts: its commands, its repo MCP servers. A Plan
  // conversation is the builder's to wait on, so it runs at the priority the daemon does.
  const launch =
    priority === 'lane'
      ? atPriority('lane', options.command, options.args)
      : { file: options.command, args: options.args };
  const child = spawn(launch.file, [...launch.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  deps.onSpawn(child.pid ?? null);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    deps.onStderr(chunk);
  });
  options.signal.addEventListener(
    'abort',
    () => {
      if (child.exitCode === null) child.kill('SIGTERM');
    },
    { once: true },
  );
  return child;
}

/** 10db's own server and the repo's approved ones, keyed by name. 10db's is written last, so it keeps its name. */
export function buildMcpServers(
  spec: Pick<AgentSessionCore, 'projectMcpServers' | 'mcp'>,
): Record<string, McpServerConfig> {
  return {
    ...Object.fromEntries(
      Object.entries(spec.projectMcpServers).map(([name, server]) => [
        name,
        toSdkMcpServer(server),
      ]),
    ),
    [CLAUDE_MCP_SERVER]: {
      type: 'http',
      url: spec.mcp.url,
      headers: { Authorization: `Bearer ${spec.mcp.token}` },
      timeout: spec.mcp.toolTimeoutMs,
      // Deferred behind tool search, the agent might not see write_handoff when it needs it.
      alwaysLoad: true,
    },
  };
}

export function buildQueryOptions(spec: LaneSessionSpec, deps: QueryDeps): Options {
  const { sandboxEnv, ...profileOptions } = claudeQueryOptions(
    {
      kind: 'lane',
      allowedTools: spec.profile.allowedTools,
      permissionMode: laneMode(spec, deps),
      pluginDir: deps.pluginDir,
      autoMode: renderClaudeAutoMode(spec.policy),
      setup: { instructions: spec.instructions ?? null, plugins: spec.setup?.plugins ?? [] },
    },
    spec.sandbox ?? null,
  );
  const sandbox = spec.sandbox ?? null;
  const gate: ToolGate = { verified: deps.billingVerified, refused: deps.isRefused };
  const cwds = createHookCwds();
  return {
    cwd: spec.cwd,
    model: spec.model,
    effort: spec.effort,
    ...(spec.resumeProviderSessionId ? { resume: spec.resumeProviderSessionId } : {}),
    env: { ...spec.env, ...sandboxEnv, ...AUTOUPDATE_OFF },
    pathToClaudeCodeExecutable: deps.claudePath,
    ...profileOptions,
    canUseTool: canUseToolBridge({
      gate,
      cwds,
      canUseTool: (req) => spec.canUseTool(req),
      escalated: isClassifierEscalation,
      listedTools: deps.listedTools,
    }),
    hooks: {
      PreToolUse: [
        preToolUseHook({
          gate,
          cwds,
          judge: (hookInput) =>
            toShapeHookOutput(
              spec.preToolUse({
                toolName: hookInput.tool_name,
                input: hookInput.tool_input,
                cwd: hookInput.cwd,
                // Each call carries the mode Claude Code reports with it; none is not auto mode.
                reportedMode:
                  hookInput.permission_mode === 'auto' ? ReportedMode.Auto : ReportedMode.Other,
              }),
            ),
        }),
      ],
      ...(sandbox ? {} : settingsRecheckHooks(deps.recheckSettings)),
    },
    abortController: deps.abortController,
    spawnClaudeCodeProcess: (options) => spawnClaude(options, deps),
  };
}

/**
 * Plan's SDK options (Shape spec §5.2): the profile's options, the project's approved MCP servers over
 * the control channel, and a PreToolUse hook that judges the session's calls and its subagents' alike.
 */
function exploreQueryOptions(
  spec: ExploreSessionSpec,
  deps: {
    readonly claudePath: string;
    readonly logger: Logger;
    readonly gate: ToolGate;
    readonly abortController: AbortController;
    readonly onSpawn: (pid: number | null) => void;
    readonly listedTools: () => Promise<readonly string[]>;
    readonly spawn: ExploreSpawn | undefined;
  },
): Options {
  const { spawn, gate } = deps;
  const { sandboxEnv, ...profileOptions } = claudeQueryOptions(
    {
      kind: 'explore',
      systemPrompt: spec.profile.systemPrompt,
      tools: spec.profile.tools,
      allowedTools: spec.profile.allowedTools,
      disallowedTools: spec.profile.disallowedTools,
      agents: spec.profile.agents,
      setup: { instructions: spec.instructions ?? null, plugins: spec.setup?.plugins ?? [] },
    },
    spec.sandbox,
  );
  // `canUseTool` hears nothing of where a call runs; the hook does, by the same tool use id.
  const cwds = createHookCwds();
  return {
    cwd: spec.cwd,
    model: spec.model,
    effort: spec.effort,
    ...(spec.resumeProviderSessionId ? { resume: spec.resumeProviderSessionId } : {}),
    // The updater switch comes last, so neither env moves the pinned copy.
    env: { ...spec.env, ...sandboxEnv, ...AUTOUPDATE_OFF },
    pathToClaudeCodeExecutable: deps.claudePath,
    ...profileOptions,
    canUseTool: canUseToolBridge({
      gate,
      cwds,
      canUseTool: (req) => spec.canUseTool(req),
      escalated: () => false,
      listedTools: deps.listedTools,
    }),
    hooks: {
      PreToolUse: [
        preToolUseHook({
          gate,
          cwds,
          judge: (hookInput) =>
            toShapeHookOutput(
              spec.preToolUse({
                toolName: hookInput.tool_name,
                input: hookInput.tool_input,
                agentId: hookInput.agent_id,
                agentType: hookInput.agent_type,
                cwd: hookInput.cwd,
              }),
            ),
        }),
      ],
      ...measurementHooks(spec, deps.logger),
    },
    abortController: deps.abortController,
    ...(spawn === undefined
      ? {}
      : { spawnClaudeCodeProcess: (options: SpawnOptions) => spawn(options, deps.onSpawn) }),
  };
}

/** Starts Claude Code as the daemon's own child and tells its pid, so the session's commands can be watched. */
type ExploreSpawn = (
  options: SpawnOptions,
  onSpawn: (pid: number | null) => void,
) => SpawnedProcess;

export interface ClaudeSessionDeps {
  /** 10db's pinned Claude Code (`startPinnedTools`), or `TENDB_CLAUDE_PATH` in its place. */
  readonly claudePath: string;
  readonly logger: Logger;
  /** How long stop() waits for interrupt, then for exit after abort. */
  readonly stopGraceMs?: number;
  /** Times the preflight and the stop grace periods; tests pass a ManualClock. */
  readonly clock?: Clock;
}

/** One Claude session and what it is for: a lane's task, or one turn of Plan's conversation. */
export type ClaudeSession =
  | {
      readonly profile: 'lane';
      readonly spec: LaneSessionSpec;
      /** The injected harness plugin directory. */
      readonly pluginDir: string;
      /** The mode a sandboxed session runs in, over its spec's. */
      readonly lanePermissionMode?: LanePermissionMode;
      /** Asks whether the account is signed in, when a start gets no account. */
      readonly signInCheck: SignInCheck;
    }
  | {
      readonly profile: 'explore';
      readonly spec: ExploreSessionSpec;
      readonly spawn?: ExploreSpawn;
    };

/** One wait per start; how many waits is how many starts (spec §5.4's `attempts`). */
export interface StartPlan {
  readonly waitsMs: readonly number[];
  readonly backoffMs: readonly number[];
}

/**
 * A lane runs at background priority, so on a busy Mac a start can be slow: the wait grows with each
 * start, and there are as many starts as waits (`START_ATTEMPTS = START_WAITS_MS.length`). A start that
 * gets no account makes the session ask `claude auth status`; only "not signed in" refuses the account
 * at once, anything else starts again after a pause.
 */
export const LANE_STARTS: StartPlan = {
  waitsMs: START_WAITS_MS,
  backoffMs: START_BACKOFF_MS,
};
/** Plan's conversation is the builder's to wait on: one start, which waits 30 s. */
export const EXPLORE_STARTS: StartPlan = { waitsMs: [30_000], backoffMs: [] };

/** A line for the prompt naming repo servers that didn't connect, so the agent doesn't hunt for their tools. */
function laneFailedServersNote(names: readonly string[]): string {
  return (
    `Note from 10db: these MCP servers from the repo's .mcp.json failed to connect and are not in this session: ${names.join(', ')}. ` +
    "Don't look for their tools. Work without them, or say in your handoff that the task needs one."
  );
}

/** A line for the first message naming project servers that didn't connect, so the session doesn't hunt for their tools. */
function exploreFailedServersNote(names: readonly string[]): string {
  return (
    `Note from 10db: these MCP servers of the project failed to connect and are not in this session: ${names.join(', ')}. ` +
    "Don't look for their tools; tell the builder when the plan needs one."
  );
}

/**
 * Where a lane and Plan's conversation differ in one session's run; each rule is one row of the
 * difference table in the plan that merged the two loops. Everything else in the core is shared.
 */
const PROFILE_RULES = {
  lane: {
    /** What every refusal before the prompt ends with. */
    unsent: 'No prompt was sent.',
    mcpUnregistered: 'Claude Code could not register the MCP servers. No prompt was sent.',
    failedServersNote: laneFailedServersNote,
    /** The warning for servers that failed to connect, and whether 10db's own is among the names. */
    failedServersLog: 'claude mcp servers failed to connect',
    failedServersLogTendb: true,
    modelCheckTail:
      "The session stopped at its first turn, before any tool ran; that turn's first request may have been billed.",
    /** A stop during the account wait still lets the account be checked, then releases the pump. */
    stopEndsAccountWait: false,
    /** A rejected rate limit, unless a later turn ends, ends the session as rate limited. */
    rejectedLimitEnds: true,
    /** An assistant rate_limit error carries no reset time: the latest rate_limit_event's fills it. */
    fillsResetsAt: true,
    /** A later init (after a compaction or restart) is skipped, so `started` comes once. */
    skipsLaterInit: true,
    /** Only the first reply this process sees can show the model was refused, a resumed session's too. */
    resumeHasReplied: false,
    /** An interrupt before the prompt went in leaves claude alone. */
    interruptsBeforePrompt: false,
    refusedLog: 'claude session refused',
  },
  explore: {
    unsent: 'No message was sent.',
    mcpUnregistered: 'Claude Code could not register 10db’s tools. No message was sent.',
    failedServersNote: exploreFailedServersNote,
    failedServersLog: 'project mcp servers failed to connect',
    failedServersLogTendb: false,
    modelCheckTail: 'The session stopped at its first turn, before any tool ran.',
    stopEndsAccountWait: true,
    rejectedLimitEnds: false,
    // Plan's notice wording rests on a null reset time (`shape/service.ts`).
    fillsResetsAt: false,
    // `shape/service.ts` takes the new session id from a later `started`.
    skipsLaterInit: false,
    // A resumed conversation has had its first reply, whatever this process has seen.
    resumeHasReplied: true,
    interruptsBeforePrompt: true,
    refusedLog: 'shape session refused',
  },
} as const;

/** What a session's log lines carry: the session and its workstream, or its conversation. */
function logFields(session: ClaudeSession): Record<string, string> {
  switch (session.profile) {
    case 'lane':
      return { sessionId: session.spec.sessionId, workstreamId: session.spec.profile.workstreamId };
    case 'explore':
      return { sessionId: session.spec.sessionId, shapeId: session.spec.profile.shapeId };
  }
}

/** A message sent before the prompt went in, held until it can follow the prompt. */
interface HeldMessage {
  readonly text: string;
  readonly images: readonly ShapeImage[];
  readonly uuid: string | undefined;
}

/** Where one start of Claude Code stands among the starts a session may make. */
interface StartAttempt {
  /** What each earlier start printed on stderr; one entry per earlier start that got no account. */
  readonly earlier: readonly string[];
  /** How long this start and each before it waited for the account. */
  readonly waitedMs: readonly number[];
  /** How long this start waits for the account. */
  readonly waitMs: number;
  /** No start follows this one. */
  readonly last: boolean;
  /**
   * This start got no account and is closed without an `ended` event, so the session starts again:
   * what it printed, and the messages sent to it that never reached claude.
   */
  readonly unanswered: (printed: string, unsent: readonly HeldMessage[]) => void;
}

/** A session that ends at once with its one `ended` event. */
function endedSession(ended: Extract<SessionEvent, { type: 'ended' }>): SessionHandle {
  const events = createChannel<SessionEvent>();
  events.push(ended);
  events.end();
  return {
    events,
    send: () => undefined,
    interrupt: () => Promise.resolve(null),
    stop: () => Promise.resolve(),
  };
}

/** The repo's committed settings can re-point the endpoint or credentials, which no account check would show. */
function settingsRefusal(
  session: ClaudeSession,
  fixHint: string,
): Extract<SessionEvent, { type: 'ended' }> | null {
  if (session.profile !== 'lane' || (session.spec.sandbox ?? null) !== null) return null;
  const problem = projectSettingsBillingProblem(session.spec.cwd);
  if (!problem) return null;
  return {
    type: 'ended',
    reason: SessionEndReason.BillingRefused,
    message: `Billing check failed: ${problem}. No prompt was sent. ${fixHint}`,
  };
}

function startSession(
  session: ClaudeSession,
  opts: ClaudeSessionDeps,
  runQuery: QueryFn,
  attempt: StartAttempt,
): SessionHandle {
  const { spec } = session;
  const rules = PROFILE_RULES[session.profile];
  const graceMs = opts.stopGraceMs ?? STOP_GRACE_MS;
  const clock = opts.clock ?? systemClock;
  const log = opts.logger.child(logFields(session));
  const sandboxed = (spec.sandbox ?? null) !== null;
  // A sandboxed session loads no settings file, so only the account can be at fault.
  const fixHint = sandboxed
    ? "Check the project's account."
    : "Check the project's account and any env block in the repo's .claude/settings.json.";
  const events = createChannel<SessionEvent>();
  const input = createChannel<SDKUserMessage>();
  const abortController = new AbortController();
  const totals = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let account: AccountInfo | undefined;
  // The preflight gates the prompt; billingVerified (preflight plus the init check) gates every tool.
  let resolvePreflight: (ok: boolean) => void = () => undefined;
  const preflightOk = new Promise<boolean>((resolve) => {
    resolvePreflight = resolve;
  });
  // Settles once the preflight knows whether claude reported an account and, if it did not, has retried or
  // refused the start. A claude that exits before reporting one ends the event stream while the sign-in
  // check runs; the lane's pump waits here so that exit is a start with no account, not a finished session.
  let settleAccountStep: () => void = () => undefined;
  const accountStep = new Promise<void>((resolve) => {
    settleAccountStep = resolve;
  });
  let resolveVerified: (ok: boolean) => void = () => undefined;
  const billingVerified = new Promise<boolean>((resolve) => {
    resolveVerified = resolve;
  });
  let pid: number | null = null;
  let started = false;
  /** The permission mode the first init reported; a later init that reports another is logged. */
  let firstInitMode: SDKSystemMessage['permissionMode'];
  /** The tool names the latest init message listed. Repo MCP servers arrive after init, so they are asked for later. */
  let initTools: readonly string[] = [];
  let ended = false;
  let stopRequested = false;
  let promptSent = false;
  let limitRejected = false;
  let lastResetsAt: Date | null = null;
  let failure: string | null = null;
  /** How the session ends once `failure` is set: a billing refusal is final, anything else may be retried. */
  let failureReason: SessionEndReason = SessionEndReason.Error;
  /** The account refusal behind `failure`, when it is the account's. */
  let failureRefusal: AccountRefusal | null = null;
  /** What a model refusal behind `failure` rests on. */
  let failureBasis: ModelMarkBasis | null = null;
  /** The answer a failed re-check gave; every later re-check gives it again. */
  let haltOutput: HookJSONOutput | null = null;
  let markFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  /** The latest of what claude printed on stderr, for the refusal when it reports no account. */
  let stderrTail = '';
  /** Closed without an `ended` event: the session starts claude again. */
  let closedForRetry = false;
  /** Messages sent before the prompt, which wait for the preflight and are lost if it fails. */
  const unsent: HeldMessage[] = [];

  const emit = (event: SessionEvent): void => {
    if (!ended) events.push(event);
  };
  const end = (reason: SessionEndReason, message: string | null): void => {
    if (ended) return;
    ended = true;
    resolvePreflight(false);
    resolveVerified(false);
    input.end();
    if (!closedForRetry)
      events.push({
        type: 'ended',
        reason,
        message,
        ...(failureRefusal && reason === SessionEndReason.AccountRefused
          ? { refusal: failureRefusal }
          : {}),
        ...(failureBasis && reason === SessionEndReason.ModelRefused
          ? { refusalBasis: failureBasis }
          : {}),
      });
    events.end();
    markFinished();
  };
  // Read through a function: TypeScript would otherwise keep the narrowing from before the awaits.
  // A recorded failure halts too: nothing more reaches claude while its halting answer is delivered.
  const halted = (): boolean => ended || stopRequested || failure !== null;
  /** The session ended or was refused while an await was pending. */
  const over = (): boolean => ended || failure !== null;
  const endReason = (): SessionEndReason => {
    if (failure) return failureReason;
    if (stopRequested) return 'stopped';
    return limitRejected ? 'rate_limited' : 'completed';
  };

  const settingsProblem = settingsRefusal(session, fixHint);
  if (settingsProblem) {
    log.error({ reason: settingsProblem.message }, rules.refusedLog);
    return endedSession(settingsProblem);
  }

  const listedTools = (): Promise<readonly string[]> =>
    currentToolNames(
      () => q.mcpServerStatus(),
      initTools,
      (error) => {
        log.debug({ err: String(error) }, 'mcp server tool list unavailable');
      },
    );
  const onSpawn = (p: number | null): void => {
    pid = p;
  };
  const recheckSettings = (what: string): HookJSONOutput => {
    if (haltOutput) return haltOutput;
    if (halted()) return {};
    const problem = projectSettingsBillingProblem(spec.cwd);
    if (!problem) return {};
    const message = `Billing check failed: ${problem}. ${what} the project's settings during the session, which was stopped. ${fixHint}`;
    // Record the failure so every tool is denied and no prompt goes in now, answer the hook, and only
    // then close the process.
    failure = message;
    failureReason = SessionEndReason.BillingRefused;
    resolvePreflight(false);
    log.error({ reason: message }, rules.refusedLog);
    clock.setTimeout(() => {
      input.end();
      void settleWithin(clock, q.interrupt(), graceMs);
      abortController.abort();
    }, HALT_GRACE_MS);
    haltOutput = { continue: false, stopReason: message, decision: 'block', reason: message };
    return haltOutput;
  };
  // The prompt is not pushed yet: it goes in only after the billing preflight passes.
  const q = runQuery({
    prompt: input,
    options:
      session.profile === 'lane'
        ? buildQueryOptions(session.spec, {
            claudePath: opts.claudePath,
            pluginDir: session.pluginDir,
            abortController,
            billingVerified,
            listedTools,
            ...(session.lanePermissionMode === undefined
              ? {}
              : { lanePermissionMode: session.lanePermissionMode }),
            onSpawn,
            isRefused: () => failure !== null,
            recheckSettings,
            onStderr: (chunk) => {
              stderrTail = (stderrTail + chunk).slice(-STDERR_KEPT_CHARS);
              log.debug({ stderr: chunk.slice(0, STDERR_LOG_CHARS) }, 'claude stderr');
            },
          })
        : exploreQueryOptions(session.spec, {
            claudePath: opts.claudePath,
            logger: opts.logger,
            gate: { verified: billingVerified, refused: () => failure !== null },
            abortController,
            onSpawn,
            listedTools,
            spawn: session.spawn,
          }),
  });

  const refuse = (
    reason: SessionEndReason,
    message: string,
    refusal?: AccountRefusal,
    basis?: ModelMarkBasis,
  ): void => {
    failure = message;
    failureReason = reason;
    failureRefusal = refusal ?? null;
    failureBasis = basis ?? null;
    resolvePreflight(false);
    resolveVerified(false);
    log.error({ reason: message }, rules.refusedLog);
    input.end();
    void settleWithin(clock, q.interrupt(), graceMs);
    abortController.abort();
  };
  /**
   * A start that got no account. Plan refuses at once. A lane asks whether the account is signed in:
   * silence is not a sign-out, since a start under load can take minutes, so a start that is not the
   * last closes and the session starts another.
   */
  const noAccount = async (): Promise<void> => {
    if (session.profile === 'explore') {
      refuse(
        SessionEndReason.BillingRefused,
        `Claude Code reported no account within ${String(attempt.waitMs / 1_000)} s. ${rules.unsent}`,
      );
      return;
    }
    // The SDK errors the stream and rejects accountInfo() about the same tick, in either order. Let the pump
    // see how the stream ended before this decides to start again: a sandbox that cannot start is final
    // (the pump ends the session), and a keyed account has no await below to give the pump that turn.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (over()) return;
    // Only `claude auth status`, asked of the account's own config directory, says the account is
    // signed out. A keyed account has no sign-in to check, and a stop in the meantime wants no answer.
    const checkable = spec.account.kind === AccountKind.ClaudeSubscription && !stopRequested;
    const signIn: SignInState = checkable ? await session.signInCheck(spec.env) : 'unknown';
    if (over()) return;
    if (!attempt.last && !stopRequested && signIn !== 'signed_out') {
      // One slow start says nothing about the account: close this claude and let the session start another.
      // Nothing is logged of what it printed beyond its length; the refusal, if it comes, says it.
      log.warn(
        { printedChars: stderrTail.length, signIn },
        'claude reported no account; starting it again',
      );
      closedForRetry = true;
      end(SessionEndReason.Error, null);
      void settleWithin(clock, q.interrupt(), graceMs);
      abortController.abort();
      attempt.unanswered(stderrTail, unsent);
      return;
    }
    const { why, printed } = noAccountWhy(
      attempt.waitedMs,
      [...attempt.earlier, stderrTail],
      spec.account.kind,
    );
    // A signed-out subscription may answer nothing: the account waits for its sign-in, the lane doesn't fail.
    const signedOut = missingAccountRefusal(spec.account, why, printed, signIn);
    if (signedOut)
      refuse(SessionEndReason.AccountRefused, `${signedOut.message}. ${rules.unsent}`, signedOut);
    else
      refuse(
        SessionEndReason.BillingRefused,
        `Account check failed: ${why}. ${printed}. ${rules.unsent} ${fixHint}`,
      );
  };
  /**
   * Before the prompt: the account Claude Code loaded must match the project's billing mode. A named
   * function, not an IIFE: TypeScript reads an IIFE as running inline, and would narrow `ended` to false.
   */
  const preflightSteps = async (): Promise<void> => {
    account = await settleWithin(clock, q.accountInfo(), attempt.waitMs);
    // An account is what the event pump waits for; a start with none is decided below, after the sign-in check.
    if (account) settleAccountStep();
    if (rules.stopEndsAccountWait ? halted() : over()) return;
    if (!account) {
      await noAccount();
      return;
    }
    const refusal = checkAccount(spec.account, seenFrom(account));
    if (refusal) {
      refuse(SessionEndReason.AccountRefused, `${refusal.message}. ${rules.unsent}`, refusal);
      return;
    }
    if (stopRequested) {
      // Stopped during the preflight: release the event pump, which waits on this before the first init.
      resolvePreflight(false);
      return;
    }
    let leftOut: string[];
    try {
      leftOut = Object.keys((await q.setMcpServers(buildMcpServers(spec))).errors);
    } catch (error) {
      // The error can quote the rejected config, which holds credentials; only its class is logged.
      log.error(
        { errName: error instanceof Error ? error.name : 'unknown' },
        'claude mcp servers could not be registered',
      );
      refuse(SessionEndReason.Error, rules.mcpUnregistered);
      return;
    }
    if (halted()) {
      resolvePreflight(false);
      return;
    }
    const repoLeftOut = leftOut.filter((name) => name !== CLAUDE_MCP_SERVER);
    const logged = rules.failedServersLogTendb ? leftOut : repoLeftOut;
    if (logged.length > 0) log.warn({ servers: logged }, rules.failedServersLog);
    input.push(
      userMessage(
        repoLeftOut.length > 0
          ? `${spec.prompt}\n\n${rules.failedServersNote(repoLeftOut)}`
          : spec.prompt,
        undefined,
        spec.images ?? [],
        session.profile === 'lane' ? session.spec.promptUuid : undefined,
      ),
    );
    promptSent = true;
    resolvePreflight(true);
  };
  const preflight = async (): Promise<void> => {
    try {
      await preflightSteps();
    } finally {
      settleAccountStep();
    }
  };
  void preflight();

  /** On the first init: the credentials the CLI actually uses, after the repo's settings were applied. */
  function checkInit(init: SDKSystemMessage): void {
    if (session.profile === 'lane') logInit(log, init, account);
    // init has no plan field, so the preflight's account supplies apiProvider and subscriptionType.
    const credentials = checkInitCredentials(
      spec.account,
      init.apiKeySource,
      seenFrom(account ?? {}),
    );
    if (credentials) {
      refuse(
        SessionEndReason.AccountRefused,
        `${credentials.message}. The session stopped at its first turn, before any tool ran.`,
        credentials,
      );
      return;
    }
    if (!modelMatches(spec.model, init.model)) {
      refuse(
        SessionEndReason.BillingRefused,
        `Model check failed: 10db asked for ${spec.model} but Claude Code runs ${init.model}. ${rules.modelCheckTail}`,
      );
      return;
    }
    resolveVerified(true);
  }

  let mcpStatusLogged = false;
  /**
   * Once, after a lane's first turn: MCP startup doesn't block init, so init often still says `pending`
   * for a server `npx` is downloading. Names and status only; the status's `config` holds header values.
   */
  const logMcpStatus = (): void => {
    if (session.profile !== 'lane' || mcpStatusLogged) return;
    mcpStatusLogged = true;
    q.mcpServerStatus().then(
      (servers) => {
        log.info(
          { mcpServers: servers.map((s) => ({ name: s.name, status: s.status })) },
          'claude session mcp status',
        );
      },
      (error: unknown) => {
        log.debug({ err: String(error) }, 'mcp server status unavailable');
      },
    );
  };

  const readContext = (): void => {
    q.getContextUsage({ detail: 'summary' }).then(
      (usage) => {
        emit(contextEvent(usage));
      },
      (error: unknown) => {
        log.debug({ err: String(error) }, 'context usage unavailable');
      },
    );
  };

  /** Whether an assistant message has come yet: only the first can show the model was refused. */
  let repliedYet = rules.resumeHasReplied && spec.resumeProviderSessionId !== null;
  const pump = async (): Promise<void> => {
    try {
      for await (const msg of q) {
        if (failure) continue;
        if (msg.type === 'assistant') {
          const firstReply = !repliedYet;
          repliedYet = true;
          const refusal = modelRefusalOf(msg, spec.model, firstReply);
          if (refusal) {
            // `init.model` echoes even a made-up ID, so only the first reply shows the account cannot run it.
            refuse(
              SessionEndReason.ModelRefused,
              `Claude Code reported that account "${spec.account.label}" cannot run the model ${spec.model}.`,
              undefined,
              refusal,
            );
            continue;
          }
          const problem = credentialProblem(msg.error);
          if (problem) {
            const refusal = {
              problem,
              message: `Claude Code reported ${String(msg.error)} for account "${spec.account.label}"`,
              seenIdentity: null,
            };
            refuse(SessionEndReason.AccountRefused, `${refusal.message}.`, refusal);
            continue;
          }
        }
        if (msg.type === 'system' && msg.subtype === 'init') {
          initTools = msg.tools;
          if (started) {
            // A later init (after a compaction or restart) is not checked again, but a lane logs a mode
            // other than the first init's, so a lane that left auto mode shows up.
            if (session.profile === 'lane' && msg.permissionMode !== firstInitMode) {
              log.info({ permissionMode: msg.permissionMode }, 'claude session permission mode');
            }
            if (rules.skipsLaterInit) continue;
          } else {
            if (!(await preflightOk)) continue;
            checkInit(msg);
            if (failure) continue;
            firstInitMode = msg.permissionMode;
            started = true;
          }
        }
        // Claude Code can change mode mid-session, for example leaving auto mode after repeated classifier refusals.
        if (
          session.profile === 'lane' &&
          msg.type === 'system' &&
          msg.subtype === 'status' &&
          msg.permissionMode !== undefined
        ) {
          log.info({ permissionMode: msg.permissionMode }, 'claude session permission mode');
        }
        for (const event of mapSdkMessage(msg, { pid })) {
          if (event.type === 'turn_complete') {
            totals.inputTokens += event.inputTokens;
            totals.outputTokens += event.outputTokens;
            totals.cachedTokens += event.cachedTokens;
            limitRejected = false;
            emit({
              ...event,
              inputTokens: totals.inputTokens,
              outputTokens: totals.outputTokens,
              cachedTokens: totals.cachedTokens,
            });
            logMcpStatus();
          } else if (event.type === 'rate_limit') {
            if (rules.rejectedLimitEnds && event.status === 'rejected') limitRejected = true;
            if (event.resetsAt) lastResetsAt = event.resetsAt;
            emit(
              event.resetsAt || !rules.fillsResetsAt ? event : { ...event, resetsAt: lastResetsAt },
            );
          } else {
            emit(event);
          }
        }
        if (msg.type === 'assistant') readContext();
      }
      if (session.profile === 'lane' && !started) await accountStep;
      end(endReason(), failure);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        session.profile === 'lane' &&
        sandboxed &&
        !started &&
        !failure &&
        !stopRequested &&
        message.includes(SANDBOX_SETTINGS_ERROR)
      ) {
        // Final, whatever the account says: a start again would meet the same sandbox.
        log.error({ reason: message }, 'claude session sandbox refused');
        end(
          SessionEndReason.SandboxRefused,
          `The lane sandbox could not start: ${message.split('\n')[0] ?? message}`,
        );
        return;
      }
      if (session.profile === 'lane' && !started) await accountStep;
      if (failure) end(failureReason, failure);
      else if (stopRequested) end('stopped', null);
      else end('error', message);
    }
  };
  void pump();

  return {
    events,
    send(text, images = [], uuid) {
      if (halted()) return;
      // Never ahead of the prompt: a message sent during the preflight waits for it, and is dropped if it fails.
      if (promptSent) {
        input.push(userMessage(text, 'next', images, uuid));
        return;
      }
      unsent.push({ text, images, uuid });
      void preflightOk.then((ok) => {
        if (ok && !halted()) input.push(userMessage(text, 'next', images, uuid));
      });
    },
    async interrupt() {
      if (halted() || (!rules.interruptsBeforePrompt && !promptSent)) return null;
      return interruptReceipt(await settleWithin(clock, q.interrupt(), graceMs));
    },
    async stop() {
      if (ended) return;
      stopRequested = true;
      // A stop wants no retry or refusal: release the event pump if it waits for the account check.
      settleAccountStep();
      input.end();
      await settleWithin(clock, q.interrupt(), graceMs);
      const abortTimer = clock.setTimeout(() => {
        abortController.abort();
      }, graceMs);
      const forceTimer = clock.setTimeout(() => {
        end('stopped', 'claude did not exit after it was aborted');
      }, graceMs * 2);
      await finished;
      abortTimer.cancel();
      forceTimer.cancel();
    },
  };
}

/** A lane's first init, logged: the billing it runs on and the servers the CLI loaded. Never email or organization. */
function logInit(log: Logger, init: SDKSystemMessage, account: AccountInfo | undefined): void {
  log.info(
    {
      apiKeySource: init.apiKeySource,
      apiProvider: account?.apiProvider,
      subscriptionType: account?.subscriptionType,
      claudeCodeVersion: init.claude_code_version,
      model: init.model,
      // The mode in effect, which is `default` where auto mode is unavailable whatever was asked for.
      permissionMode: init.permissionMode,
    },
    'claude session billing',
  );
  // The servers the CLI loaded: 10db's own plus the repo's. Names and status only, never their config.
  log.info(
    { mcpServers: init.mcp_servers.map((s) => ({ name: s.name, status: s.status })) },
    'claude session mcp',
  );
}

/**
 * A session that starts Claude Code again when a start gets no account from it, up to one start per
 * wait in `starts`. A slow start (a lane runs at background priority) is not a signed-out account: only
 * the last start's silence is refused. A start that closes for another emits no event, so the caller
 * sees one session; messages sent meanwhile go to the next start, and a stop in between ends it as
 * stopped.
 */
export function startClaudeSession(
  session: ClaudeSession,
  deps: ClaudeSessionDeps,
  runQuery: QueryFn,
  starts: StartPlan,
): SessionHandle {
  const attempts = starts.waitsMs.length;
  const log = deps.logger.child(logFields(session));
  const events = createChannel<SessionEvent>();
  /** What each start that got no account printed. */
  const printed: string[] = [];
  /** Set by a start that closed for another; its unsent messages grow while the next one is made. */
  let pending: { readonly unsent: HeldMessage[] } | null = null;
  let stopRequested = false;
  let current: SessionHandle | null = null;
  // Read through a function: TypeScript would otherwise keep the narrowing from the assignments.
  const closedStart = (): { readonly unsent: HeldMessage[] } | null => pending;
  const stopAsked = (): boolean => stopRequested;
  const clock = deps.clock ?? systemClock;
  /** Wakes the pause between two starts early; a stop does. */
  let wake: () => void = () => undefined;
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = clock.setTimeout(resolve, ms);
      wake = () => {
        timer.cancel();
        resolve();
      };
    });
  const settled = (async () => {
    let carried: readonly HeldMessage[] = [];
    for (let number = 1; number <= attempts; number += 1) {
      pending = null;
      const handle = startSession(session, deps, runQuery, {
        earlier: [...printed],
        waitedMs: starts.waitsMs.slice(0, number),
        waitMs: starts.waitsMs[number - 1] ?? 0,
        last: number === attempts,
        unanswered: (text, unsent) => {
          printed.push(text);
          pending = { unsent: [...unsent] };
        },
      });
      current = handle;
      for (const held of carried) handle.send(held.text, held.images, held.uuid);
      for await (const event of handle.events) events.push(event);
      const closed = closedStart();
      if (!closed) break;
      if (!stopAsked()) {
        // Back off before the next start: a Mac that is too loaded to start Claude Code in time needs a moment.
        log.info({ starts: number }, 'claude session starts again');
        await pause(starts.backoffMs[number - 1] ?? 0);
      }
      if (stopAsked()) {
        events.push({ type: 'ended', reason: SessionEndReason.Stopped, message: null });
        break;
      }
      // Read after the pause: a message sent during it waits in the same list.
      carried = closed.unsent;
    }
    events.end();
  })();
  return {
    events,
    send(text, images = [], uuid) {
      const waiting = closedStart();
      if (waiting) waiting.unsent.push({ text, images, uuid });
      else current?.send(text, images, uuid);
    },
    // Between two starts no turn runs, so there is nothing to interrupt.
    interrupt: () => (closedStart() || !current ? Promise.resolve(null) : current.interrupt()),
    async stop() {
      stopRequested = true;
      wake();
      await current?.stop();
      await settled;
    },
  };
}

export interface ShapeSessionDeps extends ClaudeSessionDeps {
  readonly query: QueryFn;
  /** Starts Claude Code as the daemon's own child and tells its pid, so the session's commands can be watched. */
  readonly spawn?: ExploreSpawn;
}

/**
 * One conversation's Claude Code session. It proves the account before the first message, as a lane
 * does, and reports the same events; `interrupt` ends the running turn and leaves the session open.
 */
export function startShapeSession(spec: ExploreSessionSpec, deps: ShapeSessionDeps): SessionHandle {
  return startClaudeSession(
    { profile: 'explore', spec, ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }) },
    deps,
    deps.query,
    EXPLORE_STARTS,
  );
}
