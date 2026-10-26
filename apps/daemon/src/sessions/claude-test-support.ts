import { randomUUID } from 'node:crypto';
import type {
  ApiKeySource,
  NonNullableUsage,
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKRateLimitEvent,
  SDKRateLimitInfo,
  SDKResultSuccess,
  SDKSystemMessage,
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
export const toolUseBlock = (name: string, input: unknown): Content[number] => ({
  type: 'tool_use',
  id: 'toolu_1',
  name,
  input,
});

export function assistantMessage(
  content: Content,
  error?: SDKAssistantMessage['error'],
): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg_1',
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
    parent_tool_use_id: null,
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
}): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1_000,
    duration_api_ms: 900,
    is_error: false,
    num_turns: 1,
    result: 'done',
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

export function compactBoundary(trigger: 'manual' | 'auto'): SDKCompactBoundaryMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger, pre_tokens: 150_000 },
    uuid: randomUUID(),
    session_id: PROVIDER_SESSION,
  };
}
