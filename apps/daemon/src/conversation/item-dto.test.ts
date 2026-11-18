import { ConversationItemAuthor, ConversationItemKind, mintId } from '@10db/contracts';
import type { ConversationItemRow } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { itemDtoOf } from './item-dto';

const AT = '2026-11-17T10:00:00.000Z';

function message(body: { text: string; purpose?: 'carry_on' }): ConversationItemRow {
  return {
    id: mintId('ConversationItem'),
    conversationId: mintId('Conversation'),
    seq: 1,
    author: ConversationItemAuthor.Builder,
    kind: ConversationItemKind.Message,
    body,
    turnId: null,
    partial: false,
    pushedAt: null,
    pushUuids: [],
    deliveredAt: null,
    handedBackAt: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

describe('a stored message as its DTO', () => {
  it.each<{
    name: string;
    body: { text: string; purpose?: 'carry_on' };
    purpose: string | undefined;
  }>([
    {
      name: 'a carry-on keeps its purpose',
      body: { text: 'Go on', purpose: 'carry_on' },
      purpose: 'carry_on',
    },
    { name: 'a message with none has none', body: { text: 'Hi' }, purpose: undefined },
  ])('$name', ({ body, purpose }) => {
    const dto = itemDtoOf(message(body), false);
    expect(dto.kind === 'message' ? dto.purpose : 'not a message').toBe(purpose);
  });
});
