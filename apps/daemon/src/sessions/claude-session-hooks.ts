import type {
  HookCallbackMatcher,
  HookJSONOutput,
  Options,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Logger } from '../log';
import { toHookOutput, toPermissionResult } from './claude-mapping';
import type { AgentSessionCore, ToolDecision, ToolRequest } from './types';

export const BILLING_UNVERIFIED =
  'The billing check for this session did not pass, so 10db allows no tools in it.';

/** Every tool waits for `verified`; from the moment `refused()` is true every tool is denied. */
export interface ToolGate {
  readonly verified: Promise<boolean>;
  refused(): boolean;
}

/** The hook's cwd for each call, read once by canUseTool for the same tool use id; the newest 256 are kept. */
export interface HookCwds {
  remember(toolUseId: string, cwd: string): void;
  take(toolUseId: string): string | undefined;
}

/** How many calls' hook directories are kept for `canUseTool`: a call the hook allowed never reaches it. */
const HOOK_CWDS_KEPT = 256;

/**
 * The PreToolUse hook is the only place Claude Code says where a call runs (its `cwd`, which an
 * earlier Bash call's `cd` moves); `canUseTool` for the same call gets it by the tool use id, so the
 * permission broker reads a relative path from the same directory the guard does.
 */
export function createHookCwds(): HookCwds {
  const cwds = new Map<string, string>();
  return {
    remember(toolUseId, cwd) {
      cwds.set(toolUseId, cwd);
      const oldest = cwds.keys().next();
      if (cwds.size > HOOK_CWDS_KEPT && !oldest.done) cwds.delete(oldest.value);
    },
    take(toolUseId) {
      const cwd = cwds.get(toolUseId);
      cwds.delete(toolUseId);
      return cwd;
    },
  };
}

/** A call as the PreToolUse hook saw it, which is all a later denial of the call can be shown with. */
export interface HookCall {
  readonly toolName: string;
  readonly input: unknown;
}

/** The hook's calls by tool use id, read once when Claude Code reports that call denied. */
export interface HookCalls {
  remember(toolUseId: string, call: HookCall): void;
  take(toolUseId: string): HookCall | undefined;
}

/**
 * Keeps the newest 256 calls, since a call that ran is never read again. A `Map`, because the ids
 * come from the SDK and an id such as `__proto__` must name nothing.
 */
export function createHookCalls(): HookCalls {
  const calls = new Map<string, HookCall>();
  return {
    remember(toolUseId, call) {
      calls.set(toolUseId, call);
      const oldest = calls.keys().next();
      if (calls.size > HOOK_CWDS_KEPT && !oldest.done) calls.delete(oldest.value);
    },
    take(toolUseId) {
      const call = calls.get(toolUseId);
      calls.delete(toolUseId);
      return call;
    },
  };
}

/**
 * What Claude Code adds to a permission request when it says the call needs a person. Its auto mode
 * classifier sets them; a marked call becomes a card that no stored rule answers. The SDK passes
 * these fields at runtime but its typings omit them.
 */
const EscalationFields = z.looseObject({
  requiresUserInteraction: z.boolean().optional(),
  decisionReasonType: z.string().optional(),
});

export function isClassifierEscalation(options: unknown): boolean {
  const parsed = EscalationFields.safeParse(options);
  return (
    parsed.success &&
    (parsed.data.requiresUserInteraction === true ||
      parsed.data.decisionReasonType === 'classifier')
  );
}

/** Claude Code's permission callback, held behind the billing gate and handed the hook's cwd. */
export function canUseToolBridge(bridge: {
  readonly gate: ToolGate;
  readonly cwds: HookCwds;
  readonly canUseTool: (req: ToolRequest) => Promise<ToolDecision>;
  /** Lane: isClassifierEscalation. Explore: () => false. */
  readonly escalated: (options: unknown) => boolean;
  /** Asked only for an mcp__ tool. */
  readonly listedTools: (() => Promise<readonly string[]>) | undefined;
}): NonNullable<Options['canUseTool']> {
  return async (toolName, input, options) => {
    if (!(await bridge.gate.verified) || bridge.gate.refused())
      return { behavior: 'deny', message: BILLING_UNVERIFIED, interrupt: true };
    const cwd = bridge.cwds.take(options.toolUseID);
    // Only a call to an MCP tool is offered a server rule, and only it needs the tool list.
    const listedTools = toolName.startsWith('mcp__') ? await bridge.listedTools?.() : undefined;
    const decision = await bridge.canUseTool({
      toolName,
      input,
      toolUseId: options.toolUseID,
      escalated: bridge.escalated(options),
      signal: options.signal,
      ...(cwd === undefined ? {} : { cwd }),
      ...(listedTools === undefined ? {} : { listedTools }),
    });
    // The session can be refused while the answer was pending.
    if (bridge.gate.refused())
      return { behavior: 'deny', message: BILLING_UNVERIFIED, interrupt: true };
    return toPermissionResult(decision, input);
  };
}

/** Denies while the gate is closed; a judge that throws becomes a deny naming 10db's guard. */
export function preToolUseHook(hook: {
  readonly gate: ToolGate;
  readonly cwds: HookCwds;
  readonly judge: (input: PreToolUseHookInput) => HookJSONOutput;
}): HookCallbackMatcher {
  return {
    hooks: [
      async (hookInput) => {
        if (hookInput.hook_event_name !== 'PreToolUse') return {};
        if (!(await hook.gate.verified) || hook.gate.refused())
          return toHookOutput({ decision: 'deny', reason: BILLING_UNVERIFIED });
        try {
          hook.cwds.remember(hookInput.tool_use_id, hookInput.cwd);
          return hook.judge(hookInput);
        } catch (error) {
          // A guard that fails must never let the call run.
          return toHookOutput({
            decision: 'deny',
            reason: `10db's guard failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      },
    ],
  };
}

/** A tool can write the project's settings mid-session, where no billing check would look again. */
export function settingsRecheckHooks(
  recheck: (what: string) => HookJSONOutput,
): NonNullable<Options['hooks']> {
  return {
    PostToolUse: [{ hooks: [() => Promise.resolve(recheck('A tool changed'))] }],
    PostToolUseFailure: [{ hooks: [() => Promise.resolve(recheck('A tool changed'))] }],
    // Writers that are not tool calls: a background command, a repo MCP server, a dev server.
    ConfigChange: [
      {
        hooks: [
          (hookInput) =>
            Promise.resolve(
              hookInput.hook_event_name === 'ConfigChange' &&
                hookInput.source === 'project_settings'
                ? recheck('Something changed')
                : {},
            ),
        ],
      },
    ],
  };
}

/** Plan's measurement of what each call returned or failed to, for the reads it counts. */
export function measurementHooks(
  spec: Pick<AgentSessionCore, 'postToolUse' | 'toolFailed'>,
  logger: Logger,
): NonNullable<Options['hooks']> {
  return {
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
              logger.warn({ err: String(error) }, 'a tool result could not be measured');
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
              logger.warn({ err: String(error) }, 'a failed tool call could not be noted');
            }
            return Promise.resolve({});
          },
        ],
      },
    ],
  };
}
