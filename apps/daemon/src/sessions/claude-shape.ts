import type {
  AccountInfo,
  Options,
  SDKMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type { AccountRefusal } from '@10db/contracts';
import { systemClock, type Clock } from '../clock';
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
  contextEvent,
  mapSdkMessage,
  toHookOutput,
  toPermissionResult,
  toSdkMcpServer,
  toShapeHookOutput,
  userMessage,
} from './claude-mapping';
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
const UNVERIFIED =
  'The billing check for this session did not pass, so 10db allows no tools in it.';
/** A line for the first message naming project servers that didn't connect, so the session doesn't hunt for their tools. */
function failedServersNote(names: readonly string[]): string {
  return (
    `Note from 10db: these MCP servers of the project failed to connect and are not in this session: ${names.join(', ')}. ` +
    "Don't look for their tools; tell the builder when the plan needs one."
  );
}

/** How many calls' hook directories are kept for `canUseTool`: a call the hook allowed never reaches it. */
const HOOK_CWDS_KEPT = 256;

/**
 * The SDK options of a Shape session (Shape spec §5.2): no settings file and no plugin, the project's
 * approved MCP servers over the control channel, commands in a read-only lane sandbox, `default`
 * permission mode in which a call no allow rule covers reaches the permission broker, and a PreToolUse
 * hook that judges the session's calls and its subagents' alike.
 */
function shapeOptions(
  spec: ShapeSessionSpec,
  deps: ShapeSessionDeps,
  gate: { readonly verified: Promise<boolean>; readonly refused: () => boolean },
  abortController: AbortController,
  onSpawn: (pid: number | null) => void,
): Options {
  const { spawn } = deps;
  const { sandbox } = spec;
  // `canUseTool` hears nothing of where a call runs; the hook does, by the same tool use id.
  const hookCwds = new Map<string, string>();
  return {
    cwd: spec.cwd,
    model: spec.model,
    effort: spec.effort,
    ...(spec.resumeProviderSessionId ? { resume: spec.resumeProviderSessionId } : {}),
    // Default mode: Claude Code forces it while the scrub is on, and it keeps the processes outside
    // the sandbox free of the session's variables.
    env:
      sandbox === null
        ? { ...spec.env }
        : { ...spec.env, ...sandbox.env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' },
    pathToClaudeCodeExecutable: deps.claudePath,
    // Never the project's, the user's or a local settings file; never a plugin (the harness's skills
    // and personas are for lanes). MCP servers arrive over the control channel, not the command line.
    settingSources: [],
    strictMcpConfig: true,
    settings:
      sandbox === null
        ? { autoCompactEnabled: true }
        : { autoCompactEnabled: true, permissions: { ask: [...sandbox.askRules] } },
    ...(sandbox === null ? {} : { sandbox: sandbox.settings }),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.systemPrompt },
    tools: [...spec.tools],
    allowedTools: [...spec.allowedTools],
    disallowedTools: [...spec.disallowedTools, ...(sandbox?.disallowedTools ?? [])],
    // An agent with no model of its own runs on the session's; a call may still name one.
    agents: Object.fromEntries(
      Object.entries(spec.agents).map(([name, agent]) => [
        name,
        {
          description: agent.description,
          prompt: agent.prompt,
          tools: [...agent.tools],
          model: agent.model ?? 'inherit',
        },
      ]),
    ),
    permissionMode: 'default',
    canUseTool: async (toolName, input, options) => {
      if (!(await gate.verified) || gate.refused())
        return { behavior: 'deny', message: UNVERIFIED, interrupt: true };
      const cwd = hookCwds.get(options.toolUseID);
      hookCwds.delete(options.toolUseID);
      const decision = await spec.canUseTool({
        toolName,
        input,
        toolUseId: options.toolUseID,
        escalated: false,
        signal: options.signal,
        ...(cwd === undefined ? {} : { cwd }),
      });
      // The session can be refused while the answer was pending.
      if (gate.refused()) return { behavior: 'deny', message: UNVERIFIED, interrupt: true };
      return toPermissionResult(decision, input);
    },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (hookInput) => {
              if (hookInput.hook_event_name !== 'PreToolUse') return {};
              if (!(await gate.verified) || gate.refused())
                return toHookOutput({ decision: 'deny', reason: UNVERIFIED });
              try {
                hookCwds.set(hookInput.tool_use_id, hookInput.cwd);
                const oldest = hookCwds.keys().next();
                if (hookCwds.size > HOOK_CWDS_KEPT && !oldest.done) hookCwds.delete(oldest.value);
                return toShapeHookOutput(
                  spec.preToolUse({
                    toolName: hookInput.tool_name,
                    input: hookInput.tool_input,
                    agentId: hookInput.agent_id,
                    agentType: hookInput.agent_type,
                    cwd: hookInput.cwd,
                  }),
                );
              } catch (error) {
                // A guard that fails must never let the call run.
                return toHookOutput({
                  decision: 'deny',
                  reason: `10db's guard failed: ${error instanceof Error ? error.message : String(error)}`,
                });
              }
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            (hookInput) => {
              if (hookInput.hook_event_name !== 'PostToolUse') return Promise.resolve({});
              try {
                spec.postToolUse?.({
                  toolName: hookInput.tool_name,
                  input: hookInput.tool_input,
                  response: hookInput.tool_response,
                  agentId: hookInput.agent_id,
                  agentType: hookInput.agent_type,
                });
              } catch (error) {
                // A measurement that fails leaves the Read counted as it was, which is the safe side.
                deps.logger.warn({ err: String(error) }, 'a tool result could not be measured');
              }
              return Promise.resolve({});
            },
          ],
        },
      ],
      PostToolUseFailure: [
        {
          hooks: [
            (hookInput) => {
              if (hookInput.hook_event_name !== 'PostToolUseFailure') return Promise.resolve({});
              try {
                spec.toolFailed?.({
                  toolName: hookInput.tool_name,
                  input: hookInput.tool_input,
                  agentId: hookInput.agent_id,
                  agentType: hookInput.agent_type,
                });
              } catch (error) {
                // As with a measurement that fails, the Read stays counted, which is the safe side.
                deps.logger.warn({ err: String(error) }, 'a failed tool call could not be noted');
              }
              return Promise.resolve({});
            },
          ],
        },
      ],
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
  let failure: { reason: SessionEndReason; message: string; refusal?: AccountRefusal } | null =
    null;
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
  ): void => {
    if (ended) return;
    ended = true;
    resolvePreflight(false);
    resolveVerified(false);
    input.end();
    events.push({ type: 'ended', reason, message, ...(refusal ? { refusal } : {}) });
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
    ),
  });

  const refuse = (reason: SessionEndReason, message: string, refusal?: AccountRefusal): void => {
    failure = { reason, message, ...(refusal ? { refusal } : {}) };
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

  const pump = async (): Promise<void> => {
    try {
      for await (const msg of q) {
        if (failure) continue;
        if (msg.type === 'assistant') {
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
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (failure) end(failure.reason, failure.message, failure.refusal);
      else if (stopRequested) end('stopped', null);
      else end('error', message);
    }
  };
  void pump();

  return {
    events,
    send(text, images) {
      if (halted()) return;
      // Never ahead of the first message: one sent during the preflight waits for it.
      if (promptSent) {
        input.push(userMessage(text, 'next', images));
        return;
      }
      void preflightOk.then((ok) => {
        if (ok && !halted()) input.push(userMessage(text, 'next', images));
      });
    },
    async interrupt() {
      if (halted()) return;
      await settleWithin(clock, q.interrupt(), graceMs);
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
