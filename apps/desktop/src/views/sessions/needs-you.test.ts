import { describe, expect, it } from 'vitest';
import { mintId } from '@10db/contracts';
import { inboxItemDto } from '../../test/fixtures';
import { openCardsByConversation } from './needs-you';

describe('openCardsByConversation', () => {
  const one = mintId('Conversation');
  const other = mintId('Conversation');
  const card = (conversationId: string | number, state: 'OPEN' | 'RESOLVED' = 'OPEN') =>
    inboxItemDto({ state, detail: { conversationId } });

  it('groups open cards by the conversation that raised them', () => {
    const cards = openCardsByConversation([card(one), card(one), card(other)]);
    expect(cards.get(one)).toHaveLength(2);
    expect(cards.get(other)).toHaveLength(1);
  });
  it('ignores a conversation id that does not parse', () => {
    expect(openCardsByConversation([card('not-an-id'), card(42), inboxItemDto()]).size).toBe(0);
  });
  it('does not count a resolved card', () => {
    expect(openCardsByConversation([card(one, 'RESOLVED')]).size).toBe(0);
  });
});
