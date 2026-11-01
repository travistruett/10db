import type {
  HookJSONOutput,
  McpServerConfig,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { MAX_STEP_SUMMARY } from '@10db/contracts';
import type { GuardVerdict } from '../guard';
import { SandboxedMcpServer } from '../sandbox';
import type { SessionEvent, SessionMcpServer, ToolDecision, TurnResult } from './types';

export const SUMMARY_CHARS = 200;
const BRIEF_CHARS = 80;
/** The most of a turn's last message a turn_complete event carries: what a step result may hold. */
const TURN_TEXT_CHARS = MAX_STEP_SUMMARY;
/** Unix seconds stay below this until the year 33658; milliseconds are already above it. */
const MILLISECONDS_FLOOR = 1e12;

/** What a tool call is about, in a few words: the command, or the file it touches. */
export function toolBrief(input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    for (const key of ['command', 'file_path', 'notebook_path', 'path']) {
      // The SDK types tool input as unknown; the value is checked to be a string before it is used.
      const value: unknown = Reflect.get(input, key);
      if (typeof value === 'string') return value.slice(0, BRIEF_CHARS);
    }
  }
  // JSON.stringify returns undefined for undefined and functions, despite its declared type.
  const json = JSON.stringify(input) as string | undefined;
  return (json ?? '').slice(0, BRIEF_CHARS);
}

/** The SDK reports reset times as Unix seconds or milliseconds depending on the CLI build; accept both. */
export function resetsAtToDate(value: number | undefined): Date | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value < MILLISECONDS_FLOOR ? value * 1_000 : value);
}

/**
 * Context used, as 0–100. Computed from the token counts so it never depends on whether the SDK's
 * own `percentage` is a fraction or a percent; that field is only the fallback when no window is known.
 */
export function contextEvent(usage: {
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly percentage: number;
}): Extract<SessionEvent, { type: 'context' }> {
  const raw =
    usage.maxTokens > 0
      ? (100 * usage.totalTokens) / usage.maxTokens
      : usage.percentage <= 1
        ? usage.percentage * 100
        : usage.percentage;
  return {
    type: 'context',
    percentage: Math.round(raw * 10) / 10,
    totalTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
  };
}

/**
 * Maps one SDK message to session events. Never emits `context` or `ended`; the adapter owns those.
 * `if` rather than `switch`: the SDK adds message types often, and every other type maps to nothing.
 */
export function mapSdkMessage(
  msg: SDKMessage,
  ctx: { readonly pid: number | null },
): SessionEvent[] {
  if (msg.type === 'system') {
    if (msg.subtype === 'init')
      return [{ type: 'started', providerSessionId: msg.session_id, pid: ctx.pid }];
    if (msg.subtype === 'compact_boundary')
      return [{ type: 'compacted', trigger: msg.compact_metadata.trigger }];
    return [];
  }
  if (msg.type === 'assistant') {
    const events: SessionEvent[] = [];
    for (const block of msg.message.content) {
      if (block.type === 'text') {
        const text = block.text.trim();
        if (text)
          events.push({ type: 'activity', kind: 'text', summary: text.slice(0, SUMMARY_CHARS) });
      } else if (block.type === 'tool_use') {
        events.push({
          type: 'activity',
          kind: 'tool',
          summary: `${block.name} ${toolBrief(block.input)}`.slice(0, SUMMARY_CHARS),
        });
      }
    }
    if (msg.error === 'rate_limit')
      events.push({
        type: 'rate_limit',
        status: 'rejected',
        resetsAt: null,
        utilization: null,
        limitType: null,
      });
    return events;
  }
  if (msg.type === 'result') {
    const usage = msg.usage;
    const result: TurnResult =
      msg.subtype === 'error_max_turns'
        ? 'max_turns'
        : msg.subtype !== 'success' || msg.is_error
          ? 'error'
          : 'success';
    // What the model wrote last: a review that never calls complete_step may have put its findings here.
    const text = msg.subtype === 'success' ? msg.result.trim().slice(0, TURN_TEXT_CHARS) : '';
    return [
      {
        type: 'turn_complete',
        // Only a turn that didn't end normally says so; the others stay as they were.
        ...(result === 'success' ? {} : { result }),
        ...(text === '' ? {} : { text }),
        inputTokens: usage.input_tokens + usage.cache_creation_input_tokens,
        outputTokens: usage.output_tokens,
        cachedTokens: usage.cache_read_input_tokens,
        costUsd: msg.total_cost_usd,
      },
    ];
  }
  if (msg.type === 'rate_limit_event') {
    const info = msg.rate_limit_info;
    // Spending extra usage costs money a subscription run never asked for, so it pauses like a hard limit.
    const overage = info.isUsingOverage === true;
    // A share of the limit; a value outside 0 to 1 is a shape 10db hasn't seen, so no threshold fires on it.
    const utilization =
      typeof info.utilization === 'number' && info.utilization >= 0 && info.utilization <= 1
        ? info.utilization
        : null;
    // Claude Code's payload is not checked against its types, so a limit type is a string or nothing.
    const limitType = typeof info.rateLimitType === 'string' ? info.rateLimitType : null;
    return [
      {
        type: 'rate_limit',
        status: overage ? 'rejected' : info.status,
        resetsAt: resetsAtToDate(overage ? (info.overageResetsAt ?? info.resetsAt) : info.resetsAt),
        utilization,
        limitType,
      },
    ];
  }
  return [];
}

export function toPermissionResult(
  decision: ToolDecision,
  input: Record<string, unknown>,
): PermissionResult {
  if (decision.behavior === 'allow')
    return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
  return {
    behavior: 'deny',
    message: decision.message,
    ...(decision.interrupt === undefined ? {} : { interrupt: decision.interrupt }),
  };
}

/** An `ask` sends the call to canUseTool, past any allow rule and auto mode's classifier. */
export function toHookOutput(verdict: GuardVerdict): HookJSONOutput {
  if (verdict.decision === 'allow') return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.decision,
      permissionDecisionReason: verdict.reason,
    },
  };
}

export function userMessage(text: string, priority?: 'now' | 'next' | 'later'): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  };
}

/**
 * A repo-declared MCP server in the SDK's shape. A stdio server is the lane sandbox's own launch
 * under srt, through `env -i`; it never gets an `env` block, which Claude Code would merge over the
 * session's environment, credentials and all.
 */
export function toSdkMcpServer(server: SessionMcpServer): McpServerConfig {
  if (server instanceof SandboxedMcpServer) {
    const { command, args } = server.launch();
    return { type: 'stdio', command, args: [...args] };
  }
  return {
    type: server.type,
    url: server.url,
    ...(server.headers ? { headers: { ...server.headers } } : {}),
  };
}
