import {
  ConversationDto,
  mintId,
  type AgentCapabilitiesDto,
  type ConversationId,
} from '@10db/contracts';

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
