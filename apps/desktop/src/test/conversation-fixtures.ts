import {
  ConversationDto,
  ConversationItemDto,
  mintId,
  type AgentCapabilitiesDto,
  type ConversationId,
  type ToolCallView,
} from '@10db/contracts';

const AT = '2026-11-13T09:00:00.000Z';

/** A Claude session's capabilities, judged by auto mode. */
export const CLAUDE_CAPABILITIES: AgentCapabilitiesDto = {
  harness: 'claude',
  label: 'Agent',
  steer: 'inject',
  receipts: true,
  readBack: true,
  images: ['png', 'jpeg'],
  slashCommands: true,
  plan: false,
  reasoning: true,
  subagents: true,
  backgroundTasks: true,
  webSearch: true,
  modelSwitch: 'next_turn',
  takeover: true,
  costUsd: false,
  judge: 'native',
};

/** An idle explore conversation with nothing queued. */
export function conversationDto(
  overrides: Partial<ConversationDto> & { readonly id?: ConversationId } = {},
): ConversationDto {
  return ConversationDto.parse({
    id: mintId('Conversation'),
    owner: { kind: 'shape', id: mintId('Shape') },
    state: 'idle_cold',
    capabilities: CLAUDE_CAPABILITIES,
    model: null,
    effort: null,
    contextPct: null,
    queued: 0,
    costUsd: null,
    sendNow: false,
    pausedUntil: null,
    commands: null,
    backgroundTasks: [],
    ...overrides,
  });
}

/** Each item takes the next seq from here, so a test's items are in order. */
let nextSeq = 1;

const common = (conversationId: ConversationId, author: ConversationItemDto['author']) => ({
  id: mintId('ConversationItem'),
  conversationId,
  seq: nextSeq++,
  author,
  partial: false,
  hasFull: false,
  deliveredAt: AT,
  createdAt: AT,
});

/** The builder's message. */
export const builderItem = (conversationId: ConversationId, text: string): ConversationItemDto =>
  ConversationItemDto.parse({ ...common(conversationId, 'builder'), kind: 'message', text });

/** The agent's stored reply. */
export const replyItem = (
  conversationId: ConversationId,
  text: string,
  over: Partial<ConversationItemDto> = {},
): ConversationItemDto =>
  ConversationItemDto.parse({
    ...common(conversationId, 'agent'),
    kind: 'agent_message',
    text,
    ...over,
  });

/** A stored tool call. */
export const toolItem = (
  conversationId: ConversationId,
  call: ToolCallView,
  over: Partial<ConversationItemDto> = {},
): ConversationItemDto =>
  ConversationItemDto.parse({
    ...common(conversationId, 'agent'),
    kind: 'tool_call',
    call,
    ...over,
  });

/** Any other item, by its kind's own fields. */
export const systemItem = (
  conversationId: ConversationId,
  fields: Record<string, unknown>,
): ConversationItemDto =>
  ConversationItemDto.parse({ ...common(conversationId, 'system'), ...fields });
