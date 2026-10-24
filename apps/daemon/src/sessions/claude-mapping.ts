import type {
  HookJSONOutput,
  McpServerConfig,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { GuardVerdict } from '../guard';
import type { ProjectMcpServer } from './project-mcp';
import type { SessionEvent, ToolDecision } from './types';

export const SUMMARY_CHARS = 200;
const BRIEF_CHARS = 80;
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
      events.push({ type: 'rate_limit', status: 'rejected', resetsAt: null });
    return events;
  }
  if (msg.type === 'result') {
    const usage = msg.usage;
    return [
      {
        type: 'turn_complete',
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
    return [
      {
        type: 'rate_limit',
        status: overage ? 'rejected' : info.status,
        resetsAt: resetsAtToDate(overage ? (info.overageResetsAt ?? info.resetsAt) : info.resetsAt),
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

export function toHookOutput(verdict: GuardVerdict): HookJSONOutput {
  if (verdict.decision === 'allow') return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
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
 * Claude Code merges a stdio server's `env` over its own environment, which is the session's: the
 * subscription token, an API key, AWS credentials. So 10db never relies on `env`. It launches the server
 * through `env -i`, which starts from an empty environment and sets only the names given.
 */
export const STDIO_LAUNCHER = '/usr/bin/env';

/** A repo-declared MCP server in the SDK's shape. */
export function toSdkMcpServer(server: ProjectMcpServer): McpServerConfig {
  if (server.type === 'stdio') {
    const assignments = Object.entries(server.env).map(([name, value]) => `${name}=${value}`);
    return {
      type: 'stdio',
      command: STDIO_LAUNCHER,
      args: ['-i', ...assignments, server.command, ...server.args],
    };
  }
  return {
    type: server.type,
    url: server.url,
    ...(server.headers ? { headers: { ...server.headers } } : {}),
  };
}
