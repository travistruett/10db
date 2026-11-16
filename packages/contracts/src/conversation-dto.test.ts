import { describe, expect, it } from 'vitest';
import { ConversationDeltaFrame, ConversationDto, ConversationItemDto } from './conversation-dto';
import { mintId } from './ids';

// Sessions spec §10: the conversation's DTOs, and the live frame the event socket carries.

const AT = '2026-11-13T10:00:00.000Z';
const common = {
  id: mintId('ConversationItem'),
  conversationId: mintId('Conversation'),
  seq: 1,
  author: 'agent',
  partial: false,
  hasFull: false,
  deliveredAt: null,
  createdAt: AT,
} as const;
const call = {
  kind: 'other',
  id: 'toolu_1',
  harnessTool: 'Read',
  status: 'done',
  title: 'a.ts',
  startedAt: AT,
  durationMs: null,
  parentId: null,
  refusal: null,
  deniedBy: null,
  limit: null,
  soft: null,
  name: 'Read',
  inputPreview: '{}',
} as const;
const capabilities = {
  harness: 'claude',
  label: 'Claude',
  steer: 'inject',
  receipts: true,
  readBack: true,
  images: ['png'],
  slashCommands: true,
  plan: true,
  reasoning: true,
  subagents: true,
  backgroundTasks: true,
  webSearch: true,
  modelSwitch: 'next_turn',
  takeover: true,
  costUsd: false,
  judge: 'native',
};

describe('ConversationItemDto', () => {
  it.each<{ name: string; item: object }>([
    { name: 'message', item: { kind: 'message', text: 'hi' } },
    { name: 'agent_message', item: { kind: 'agent_message', text: 'hi' } },
    { name: 'reasoning', item: { kind: 'reasoning', text: 'hm' } },
    { name: 'notice', item: { kind: 'notice', text: 'n' } },
    {
      name: 'a model change notice',
      item: {
        kind: 'notice',
        text: 'Now on Opus',
        change: { label: 'Opus', model: 'claude-opus-5-5' },
      },
    },
    { name: 'digest', item: { kind: 'digest', text: 'd' } },
    { name: 'tool_call', item: { kind: 'tool_call', call } },
    { name: 'card', item: { kind: 'card', inboxItemId: mintId('InboxItem') } },
    { name: 'plan', item: { kind: 'plan', steps: [{ text: 'x', status: 'pending' }] } },
    { name: 'shape_event', item: { kind: 'shape_event', event: 'propose', text: 'Propose' } },
    { name: 'turn_marker', item: { kind: 'turn_marker', marker: 'send_now', resolvedAt: null } },
  ])('$name parses', ({ item }) => {
    expect(ConversationItemDto.safeParse({ ...common, ...item }).success).toBe(true);
  });
});

describe('ConversationDeltaFrame', () => {
  const frame = {
    live: true,
    type: 'conversation.delta',
    conversationId: mintId('Conversation'),
    itemId: mintId('ConversationItem'),
    offset: 0,
  } as const;
  it.each<{ name: string; extra: object; ok: boolean }>([
    { name: 'a text frame', extra: { kind: 'agent_message', text: 'Hel' }, ok: true },
    { name: 'a reasoning frame', extra: { kind: 'reasoning', text: 'hm' }, ok: true },
    {
      name: 'a call frame with its view',
      extra: { kind: 'tool_call', callPatch: { view: call } },
      ok: true,
    },
    {
      name: 'a call frame with output',
      extra: { kind: 'tool_call', callPatch: { output: 'ok' } },
      ok: true,
    },
    {
      name: 'a frame that is not live',
      extra: { kind: 'agent_message', text: 'x', live: false },
      ok: false,
    },
  ])('$name: $ok', ({ extra, ok }) => {
    expect(ConversationDeltaFrame.safeParse({ ...frame, ...extra }).success).toBe(ok);
  });
});

describe('ConversationDto', () => {
  const dto = {
    id: mintId('Conversation'),
    owner: { kind: 'shape', id: 'shp_x' },
    state: 'idle_cold',
    capabilities,
    model: null,
    effort: null,
    contextPct: null,
    queued: 0,
    costUsd: null,
    sendNow: false,
    pausedUntil: null,
    commands: null,
  };
  it('parses, and refuses an unknown state', () => {
    expect(ConversationDto.safeParse(dto).success).toBe(true);
    expect(ConversationDto.safeParse({ ...dto, state: 'dozing' }).success).toBe(false);
  });
});
