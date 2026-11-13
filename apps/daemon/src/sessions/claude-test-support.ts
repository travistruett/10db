import { randomUUID } from 'node:crypto';
import type {
  ApiKeySource,
  NonNullableUsage,
  SDKAssistantMessage,
  SDKBackgroundTasksChangedMessage,
  SDKCommandsChangedMessage,
  SDKCompactBoundaryMessage,
  SDKPartialAssistantMessage,
  SDKPermissionDeniedMessage,
  SDKRateLimitEvent,
  SDKRateLimitInfo,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKUserMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';

/** Test fixtures: SDK messages built with the SDK's own types. */
export const PROVIDER_SESSION = 'prov-session-1';

type Content = SDKAssistantMessage['message']['content'];

export function initMessage(
  apiKeySource: ApiKeySource = 'none',
  mcpServers: SDKSystemMessage['mcp_servers'] = [{ name: '10db', status: 'connected' }],
  model = 'claude-sonnet-5-5',
): SDKSystemMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource,
    claude_code_version: '2.1.299',
    cwd: '/repo',
    tools: ['Read', 'Write', 'Bash', 'mcp__10db__write_handoff'],
    mcp_servers: mcpServers,
    model,
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [{ name: '10db-harness', path: '/harness' }],
    uuid: randomUUID(),
    session_id: PROVIDER_SESSION,
  };
}

export const textBlock = (text: string): Content[number] => ({
  type: 'text',
  text,
  citations: null,
});
export const toolUseBlock = (name: string, input: unknown, id = 'toolu_1'): Content[number] => ({
  type: 'tool_use',
  id,
  name,
  input,
});

export function assistantMessage(
  content: Content,
  error?: SDKAssistantMessage['error'],
  id = 'msg_1',
  parent: string | null = null,
): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id,
      container: null,
      content,
      context_management: null,
      diagnostics: null,
      model: 'claude-haiku-5-5',
      role: 'assistant',
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      type: 'message',
      usage: {
        cache_creation: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        fallback_credit: null,
        inference_geo: null,
        input_tokens: 10,
        iterations: null,
        output_tokens: 5,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
        speed: null,
      },
    },
    parent_tool_use_id: parent,
    ...(error ? { error } : {}),
    uuid: randomUUID(),
    session_id: PROVIDER_SESSION,
  };
}

function usage(
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
): NonNullableUsage {
  return {
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: cacheCreation },
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
    fallback_credit: null,
    inference_geo: '',
    input_tokens: input,
    iterations: [],
    output_tokens: output,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: 'standard',
    speed: 'standard',
  };
}

export function resultMessage(opts: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
  costUsd: number;
  /** The last message the model wrote in the turn; none by default. */
  text?: string;
}): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1_000,
    duration_api_ms: 900,
    is_error: false,
    num_turns: 1,
    result: opts.text ?? '',
    stop_reason: 'end_turn',
    total_cost_usd: opts.costUsd,
    usage: usage(opts.input, opts.output, opts.cacheRead ?? 0, opts.cacheCreation ?? 0),
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: PROVIDER_SESSION,
  };
}

export function rateLimitEvent(info: SDKRateLimitInfo): SDKRateLimitEvent {
  return {
    type: 'rate_limit_event',
    rate_limit_info: info,
    uuid: randomUUID(),
    session_id: PROVIDER_SESSION,
  };
}

export function backgroundTasksChanged(
  tasks: SDKBackgroundTasksChangedMessage['tasks'],
): SDKBackgroundTasksChangedMessage {
  return {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks,
    uuid: randomUUID(),
    session_id: PROVIDER_SESSION,
  };
}

export function compactBoundary(trigger: 'manual' | 'auto'): SDKCompactBoundaryMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger, pre_tokens: 150_000 },
    uuid: randomUUID(),
    session_id: PROVIDER_SESSION,
  };
}

export function permissionDenied(
  fields: Pick<SDKPermissionDeniedMessage, 'tool_name' | 'tool_use_id'> &
    Partial<SDKPermissionDeniedMessage>,
): SDKPermissionDeniedMessage {
  return {
    type: 'system',
    subtype: 'permission_denied',
    message: 'denied',
    uuid: randomUUID(),
    session_id: PROVIDER_SESSION,
    ...fields,
  };
}

type StreamEventBody = SDKPartialAssistantMessage['event'];

/** A partial-message frame around one streaming event; `parent` is a subagent's tool use. */
export function streamEvent(
  event: StreamEventBody,
  parent: string | null = null,
): SDKPartialAssistantMessage {
  return {
    type: 'stream_event',
    event,
    parent_tool_use_id: parent,
    uuid: randomUUID(),
    session_id: PROVIDER_SESSION,
  };
}

// The streaming events are built as Claude Code sends them; only the fields 10db reads matter, so
// each is checked loosely by the session and cast here, at the fixture's boundary.
export const messageStart = (id: string): StreamEventBody =>
  ({ type: 'message_start', message: { id } }) as unknown as StreamEventBody;
export const blockStart = (
  index: number,
  type: 'text' | 'thinking' | 'tool_use',
): StreamEventBody =>
  ({
    type: 'content_block_start',
    index,
    content_block:
      type === 'text'
        ? { type, text: '' }
        : type === 'thinking'
          ? { type, thinking: '' }
          : { type, id: 'toolu_1', name: 'Bash', input: {} },
  }) as unknown as StreamEventBody;
export const textDelta = (index: number, text: string): StreamEventBody =>
  ({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  }) as unknown as StreamEventBody;
export const thinkingDelta = (index: number, thinking: string): StreamEventBody =>
  ({
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking },
  }) as unknown as StreamEventBody;
export const inputJsonDelta = (index: number, partial: string): StreamEventBody =>
  ({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partial },
  }) as unknown as StreamEventBody;
export const blockStop = (index: number): StreamEventBody =>
  ({ type: 'content_block_stop', index }) as unknown as StreamEventBody;

/** The user frame carrying a tool's result back to the model. */
export function toolResultMessage(
  toolUseId: string,
  content: string,
  isError = false,
): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
    parent_tool_use_id: null,
    session_id: PROVIDER_SESSION,
  };
}

/** Claude Code's push of its slash commands after a change. */
export function commandsChanged(commands: SlashCommand[]): SDKCommandsChangedMessage {
  return {
    type: 'system',
    subtype: 'commands_changed',
    commands,
    uuid: randomUUID(),
    session_id: PROVIDER_SESSION,
  };
}
