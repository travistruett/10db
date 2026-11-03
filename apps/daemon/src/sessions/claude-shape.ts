import type {
  AccountInfo,
  Options,
  SDKMessage,
  SDKUserMessage,
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
}

/** How long Claude Code may take to report its account before the first message is sent. */
const ACCOUNT_MS = 30_000;
const STOP_GRACE_MS = 5_000;
const UNVERIFIED =
  'The billing check for this session did not pass, so 10db allows no tools in it.';
const NO_TOOLS =
  'A Shape session asks for nothing: the calls it may make are settled before they run.';

/**
 * The SDK options of a Shape session (Shape spec §5.2): no settings file, no plugin, no project MCP
 * server, `default` permission mode in which `canUseTool` denies whatever no allow rule covers, and
 * a PreToolUse hook that judges the session's calls and its subagents' alike.
 */
function shapeOptions(
  spec: ShapeSessionSpec,
  deps: ShapeSessionDeps,
  gate: { readonly verified: Promise<boolean>; readonly refused: () => boolean },
  abortController: AbortController,
): Options {
  return {
    cwd: spec.cwd,
    model: spec.model,
    effort: spec.effort,
    ...(spec.resumeProviderSessionId ? { resume: spec.resumeProviderSessionId } : {}),
    env: { ...spec.env },
    pathToClaudeCodeExecutable: deps.claudePath,
    // Never the project's, the user's or a local settings file; never a plugin (the harness's skills
    // and personas are for lanes). MCP servers arrive over the control channel, not the command line.
    settingSources: [],
    strictMcpConfig: true,
    settings: { autoCompactEnabled: true },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.systemPrompt },
    tools: [...spec.tools],
    allowedTools: [...spec.allowedTools],
    disallowedTools: [...spec.disallowedTools],
    // Reviewers run on the session's own model.
    agents: Object.fromEntries(
      Object.entries(spec.agents).map(([name, agent]) => [
        name,
        {
          description: agent.description,
          prompt: agent.prompt,
          tools: [...agent.tools],
          model: 'inherit',
        },
      ]),
    ),
    permissionMode: 'default',
    canUseTool: () => Promise.resolve({ behavior: 'deny', message: NO_TOOLS }),
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (hookInput) => {
              if (hookInput.hook_event_name !== 'PreToolUse') return {};
              if (!(await gate.verified) || gate.refused())
                return toHookOutput({ decision: 'deny', reason: UNVERIFIED });
              try {
                return toShapeHookOutput(
                  spec.preToolUse({
                    toolName: hookInput.tool_name,
                    input: hookInput.tool_input,
                    agentId: hookInput.agent_id,
                    agentType: hookInput.agent_type,
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
    },
    abortController,
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
    try {
      await q.setMcpServers({
        [TENDB_MCP_SERVER]: {
          type: 'http',
          url: spec.mcp.url,
          headers: { Authorization: `Bearer ${spec.mcp.token}` },
          timeout: spec.mcp.toolTimeoutMs,
          alwaysLoad: true,
        },
      });
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
    input.push(userMessage(spec.prompt, undefined, spec.images));
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
        for (const event of mapSdkMessage(msg, { pid: null })) {
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
