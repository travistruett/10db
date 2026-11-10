import type {
  HookJSONOutput,
  McpServerConfig,
  PermissionResult,
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { UUID } from 'node:crypto';
import { MAX_STEP_SUMMARY, ModelMarkBasis } from '@10db/contracts';
import type { GuardVerdict } from '../guard';
import { SandboxedMcpServer } from '../sandbox';
import { modelRefusalBasis, MODEL_NOT_FOUND_ERROR } from './account-check';
import type {
  InterruptReceipt,
  SessionEvent,
  SessionMcpServer,
  ShapeImage,
  ShapeVerdict,
  ToolDecision,
  TurnResult,
} from './types';

export const SUMMARY_CHARS = 200;
const BRIEF_CHARS = 80;
/** The most of a turn's last message a turn_complete event carries: what a step result may hold. */
const TURN_TEXT_CHARS = MAX_STEP_SUMMARY;
/** Unix seconds stay below this until the year 33658; milliseconds are already above it. */
const MILLISECONDS_FLOOR = 1e12;

/**
 * Whether an assistant message shows the account cannot run the model the session launched on, and what that rests
 * on; null when it does not. The first reply of a session, before any tool ran, may carry any error that names the
 * launched model (see `modelRefusalBasis`); Claude Code's own `model_not_found` counts wherever it comes.
 */
export function modelRefusalOf(
  msg: SDKAssistantMessage,
  launched: string,
  firstReply: boolean,
): ModelMarkBasis | null {
  if (!firstReply) return msg.error === MODEL_NOT_FOUND_ERROR ? ModelMarkBasis.Error : null;
  const text = msg.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
  return modelRefusalBasis(msg.error, text.join('\n'), launched);
}

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
 * The client uuids of the user messages a frame says its turn consumed, the evidence each was taken
 * (Workbench spec §6.3). The turn's first assistant message stamps those its prompt brought; a message
 * folded into the running turn between tool rounds is stamped on no later assistant message of a turn
 * a typed prompt started, only on the turn's result, which lists every one. An older producer stamps
 * only the one it is answering.
 */
function consumedBy(
  msg: Pick<SDKAssistantMessage, 'user_message_uuid' | 'user_message_uuids'>,
): readonly string[] {
  return (
    msg.user_message_uuids ?? (msg.user_message_uuid === undefined ? [] : [msg.user_message_uuid])
  );
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
    if (msg.subtype === 'background_tasks_changed')
      return [
        {
          type: 'background_tasks',
          tasks: msg.tasks
            .filter((t) => t.ambient !== true)
            .map((t) => ({ id: t.task_id, description: t.description })),
        },
      ];
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
    const taken = consumedBy(msg);
    if (taken.length > 0) events.push({ type: 'consumed', uuids: taken });
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
    // The result lists what the turn consumed, a message folded in between tool rounds among it,
    // which no later assistant message stamps; it comes first, so the turn's end sees it taken.
    const taken = consumedBy(msg);
    return [
      ...(taken.length > 0 ? [{ type: 'consumed' as const, uuids: taken }] : []),
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

/** What Claude Code's interrupt answered, as a session reports it: null when it gave no receipt. */
export function interruptReceipt(
  answer: { readonly still_queued?: readonly string[] } | undefined,
): InterruptReceipt {
  return answer?.still_queued === undefined ? null : { stillQueued: [...answer.still_queued] };
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

/**
 * An `ask` sends the call to canUseTool, past any allow rule and auto mode's classifier. A settled
 * `allow` approves the call in the hook, so no classifier or card follows; a bare one has no opinion.
 */
export function toHookOutput(verdict: GuardVerdict): HookJSONOutput {
  if (verdict.decision === 'allow') {
    if (verdict.settled === undefined) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: verdict.settled,
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.decision,
      permissionDecisionReason: verdict.reason,
    },
  };
}

/** A Shape session's hook answer: an allowed call may run with 10db's input in place of the model's. */
export function toShapeHookOutput(verdict: ShapeVerdict): HookJSONOutput {
  if (verdict.decision !== 'allow' || !('updatedInput' in verdict)) return toHookOutput(verdict);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: verdict.updatedInput,
    },
  };
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (text: string): text is UUID => UUID_TEXT.test(text);

/**
 * A user message for the session. `uuid` is the client uuid a turn that takes the message stamps in
 * `user_message_uuids`; text that is no UUID is left off, as Claude Code would refuse it.
 */
export function userMessage(
  text: string,
  priority?: 'now' | 'next' | 'later',
  images: readonly ShapeImage[] = [],
  uuid?: string,
): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content:
        images.length === 0
          ? text
          : [
              { type: 'text', text },
              ...images.map((image) => ({
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: image.mediaType,
                  data: image.data,
                },
              })),
            ],
    },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
    ...(uuid !== undefined && isUuid(uuid) ? { uuid } : {}),
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
