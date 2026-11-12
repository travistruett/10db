import type {
  AccountInfo,
  Options,
  SDKMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type { AccountRefusal, ModelMarkBasis } from '@10db/contracts';
import { systemClock, type Clock } from '../clock';
import { AUTOUPDATE_OFF } from '../environment';
import type { Logger } from '../log';
import {
  checkAccount,
  checkInitCredentials,
  credentialProblem,
  modelMatches,
  seenFrom,
} from './account-check';
import { createChannel } from './channel';
import type { QueryFn } from './claude-adapter';
import {
  interruptReceipt,
  mapSdkMessage,
  modelRefusalOf,
  toSdkMcpServer,
  toShapeHookOutput,
  userMessage,
} from './claude-mapping';
import { claudeQueryOptions } from './claude-query-options';
import {
  canUseToolBridge,
  createHookCwds,
  measurementHooks,
  preToolUseHook,
  type ToolGate,
} from './claude-session-hooks';
import { contextEvent } from './context-event';
import { currentToolNames } from './mcp-tool-names';
import { TENDB_MCP_SERVER } from './project-mcp';
import { settleWithin } from './settle-within';
import {
  SessionEndReason,
  type SessionEvent,
  type ShapeSessionHandle,
  type ShapeSessionSpec,
} from './types';

export interface ShapeSessionDeps {
  readonly claudePath: string;
  readonly logger: Logger;
  readonly query: QueryFn;
  readonly stopGraceMs?: number;
  readonly clock?: Clock;
  /** Starts Claude Code as the daemon's own child and tells its pid, so the session's commands can be watched. */
  readonly spawn?: (options: SpawnOptions, onSpawn: (pid: number | null) => void) => SpawnedProcess;
}

/** How long Claude Code may take to report its account before the first message is sent. */
const ACCOUNT_MS = 30_000;
const STOP_GRACE_MS = 5_000;
/** A line for the first message naming project servers that didn't connect, so the session doesn't hunt for their tools. */
function failedServersNote(names: readonly string[]): string {
  return (
    `Note from 10db: these MCP servers of the project failed to connect and are not in this session: ${names.join(', ')}. ` +
    "Don't look for their tools; tell the builder when the plan needs one."
  );
}

/**
 * The SDK options of a Shape session (Shape spec §5.2): no settings file and no plugin, the project's
 * approved MCP servers over the control channel, commands in a read-only lane sandbox, `default`
 * permission mode in which a call no allow rule covers reaches the permission broker, and a PreToolUse
 * hook that judges the session's calls and its subagents' alike.
 */
function shapeOptions(
  spec: ShapeSessionSpec,
  deps: ShapeSessionDeps,
  gate: ToolGate,
  abortController: AbortController,
  onSpawn: (pid: number | null) => void,
  listedTools: () => Promise<readonly string[]>,
): Options {
  const { spawn } = deps;
  const { sandboxEnv, ...profileOptions } = claudeQueryOptions(
    {
      kind: 'explore',
      systemPrompt: spec.systemPrompt,
      tools: spec.tools,
      allowedTools: spec.allowedTools,
      disallowedTools: spec.disallowedTools,
      agents: spec.agents,
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
      listedTools,
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
    abortController,
    ...(spawn === undefined
      ? {}
      : { spawnClaudeCodeProcess: (options: SpawnOptions) => spawn(options, onSpawn) }),
  };
}

/**
 * One conversation's Claude Code session. It proves the account before the first message, as a lane
 * does, and reports the same events; `interrupt` ends the running turn and leaves the session open.
 */
export function startShapeSession(
  spec: ShapeSessionSpec,
  deps: ShapeSessionDeps,
): ShapeSessionHandle {
  const clock = deps.clock ?? systemClock;
  const graceMs = deps.stopGraceMs ?? STOP_GRACE_MS;
  const log = deps.logger.child({ sessionId: spec.sessionId, shapeId: spec.shapeId });
  const events = createChannel<SessionEvent>();
  const input = createChannel<SDKUserMessage>();
  const abortController = new AbortController();
  const totals = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let account: AccountInfo | undefined;
  let pid: number | null = null;
  let ended = false;
  let stopRequested = false;
  let promptSent = false;
  let started = false;
  /** The tool names the latest init message listed; the repo's MCP servers come after it. */
  let initTools: readonly string[] = [];
  let failure: {
    reason: SessionEndReason;
    message: string;
    refusal?: AccountRefusal;
    basis?: ModelMarkBasis;
  } | null = null;
  let resolvePreflight: (ok: boolean) => void = () => undefined;
  const preflightOk = new Promise<boolean>((resolve) => {
    resolvePreflight = resolve;
  });
  let resolveVerified: (ok: boolean) => void = () => undefined;
  const verified = new Promise<boolean>((resolve) => {
    resolveVerified = resolve;
  });
  let markFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });

  const emit = (event: SessionEvent): void => {
    if (!ended) events.push(event);
  };
  const end = (
    reason: SessionEndReason,
    message: string | null,
    refusal?: AccountRefusal,
    basis?: ModelMarkBasis,
  ): void => {
    if (ended) return;
    ended = true;
    resolvePreflight(false);
    resolveVerified(false);
    input.end();
    events.push({
      type: 'ended',
      reason,
      message,
      ...(refusal ? { refusal } : {}),
      ...(basis ? { refusalBasis: basis } : {}),
    });
    events.end();
    markFinished();
  };
  // Read through a function: TypeScript would otherwise keep the narrowing from before the awaits.
  const refused = (): boolean => failure !== null;
  const halted = (): boolean => ended || stopRequested || refused();

  const q = deps.query({
    prompt: input,
    options: shapeOptions(
      spec,
      deps,
      { verified, refused: () => failure !== null },
      abortController,
      (spawned) => {
        pid = spawned;
      },
      () =>
        currentToolNames(
          () => q.mcpServerStatus(),
          initTools,
          (error) => {
            log.debug({ err: String(error) }, 'mcp server tool list unavailable');
          },
        ),
    ),
  });

  const refuse = (
    reason: SessionEndReason,
    message: string,
    refusal?: AccountRefusal,
    basis?: ModelMarkBasis,
  ): void => {
    failure = { reason, message, ...(refusal ? { refusal } : {}), ...(basis ? { basis } : {}) };
    resolvePreflight(false);
    resolveVerified(false);
    log.error({ reason: message }, 'shape session refused');
    input.end();
    void settleWithin(clock, q.interrupt(), graceMs);
    abortController.abort();
  };

  const preflight = async (): Promise<void> => {
    account = await settleWithin(clock, q.accountInfo(), ACCOUNT_MS);
    if (halted()) return;
    if (!account) {
      refuse(
        SessionEndReason.BillingRefused,
        `Claude Code reported no account within ${String(ACCOUNT_MS / 1_000)} s. No message was sent.`,
      );
      return;
    }
    const refusal = checkAccount(spec.account, seenFrom(account));
    if (refusal) {
      refuse(SessionEndReason.AccountRefused, `${refusal.message}. No message was sent.`, refusal);
      return;
    }
    let leftOut: string[];
    try {
      const registered = await q.setMcpServers({
        ...Object.fromEntries(
          Object.entries(spec.projectMcpServers).map(([name, server]) => [
            name,
            toSdkMcpServer(server),
          ]),
        ),
        // Written last, so 10db's own keeps its name.
        [TENDB_MCP_SERVER]: {
          type: 'http',
          url: spec.mcp.url,
          headers: { Authorization: `Bearer ${spec.mcp.token}` },
          timeout: spec.mcp.toolTimeoutMs,
          alwaysLoad: true,
        },
      });
      leftOut = Object.keys(registered.errors).filter((name) => name !== TENDB_MCP_SERVER);
    } catch (error) {
      // The error can quote the rejected config, which holds the token; only its class is logged.
      log.error(
        { errName: error instanceof Error ? error.name : 'unknown' },
        'claude mcp servers could not be registered',
      );
      refuse(
        SessionEndReason.Error,
        'Claude Code could not register 10db’s tools. No message was sent.',
      );
      return;
    }
    if (halted()) {
      resolvePreflight(false);
      return;
    }
    if (leftOut.length > 0) log.warn({ servers: leftOut }, 'project mcp servers failed to connect');
    input.push(
      userMessage(
        leftOut.length > 0 ? `${spec.prompt}\n\n${failedServersNote(leftOut)}` : spec.prompt,
        undefined,
        spec.images,
      ),
    );
    promptSent = true;
    resolvePreflight(true);
  };
  void preflight();

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

  /** On the first init: the credentials and the model the CLI actually uses. */
  const checkInit = (init: Extract<SDKMessage, { type: 'system'; subtype: 'init' }>): void => {
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
        `Model check failed: 10db asked for ${spec.model} but Claude Code runs ${init.model}. The session stopped at its first turn, before any tool ran.`,
      );
      return;
    }
    resolveVerified(true);
  };

  /**
   * Whether the conversation has had a reply: only its first can show the model was refused. A resumed
   * conversation has had one, whatever this process has seen.
   */
  let repliedYet = spec.resumeProviderSessionId !== null;
  const pump = async (): Promise<void> => {
    try {
      for await (const msg of q) {
        if (failure) continue;
        if (msg.type === 'assistant') {
          const firstReply = !repliedYet;
          repliedYet = true;
          const refusal = modelRefusalOf(msg, spec.model, firstReply);
          if (refusal) {
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
            const message = `Claude Code reported ${String(msg.error)} for account "${spec.account.label}"`;
            refuse(SessionEndReason.AccountRefused, `${message}.`, {
              problem,
              message,
              seenIdentity: null,
            });
            continue;
          }
        }
        if (msg.type === 'system' && msg.subtype === 'init') initTools = msg.tools;
        if (msg.type === 'system' && msg.subtype === 'init' && !started) {
          if (!(await preflightOk)) continue;
          checkInit(msg);
          if (refused()) continue;
          started = true;
        }
        for (const event of mapSdkMessage(msg, { pid })) {
          if (event.type === 'turn_complete') {
            totals.inputTokens += event.inputTokens;
            totals.outputTokens += event.outputTokens;
            totals.cachedTokens += event.cachedTokens;
            emit({ ...event, ...totals });
          } else emit(event);
        }
        if (msg.type === 'assistant') readContext();
      }
      end(
        failure ? failure.reason : stopRequested ? 'stopped' : 'completed',
        failure?.message ?? null,
        failure?.refusal,
        failure?.basis,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (failure) end(failure.reason, failure.message, failure.refusal, failure.basis);
      else if (stopRequested) end('stopped', null);
      else end('error', message);
    }
  };
  void pump();

  return {
    events,
    send(text, images, uuid) {
      if (halted()) return;
      // Never ahead of the first message: one sent during the preflight waits for it.
      if (promptSent) {
        input.push(userMessage(text, 'next', images, uuid));
        return;
      }
      void preflightOk.then((ok) => {
        if (ok && !halted()) input.push(userMessage(text, 'next', images, uuid));
      });
    },
    async interrupt() {
      if (halted()) return null;
      return interruptReceipt(await settleWithin(clock, q.interrupt(), graceMs));
    },
    async stop() {
      if (ended) return;
      stopRequested = true;
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
