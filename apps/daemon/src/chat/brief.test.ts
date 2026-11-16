import {
  ConversationItemAuthor,
  ConversationItemKind,
  mintId,
  TASK_MESSAGE_MAX_CHARS,
} from '@10db/contracts';
import type { ConversationItemRow } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { briefFromChat, briefRequestText, chatLines, lastBuilderMessage } from './brief';

// Sessions spec §7.3 (Do it): the brief made from the chat alone leaves out its own request and the reply to it.

const conversationId = mintId('Conversation');
let seq = 0;
const row = (
  kind: ConversationItemKind,
  author: ConversationItemAuthor,
  body: Record<string, string>,
): ConversationItemRow => ({
  id: mintId('ConversationItem'),
  conversationId,
  seq: (seq += 1),
  author,
  kind,
  body,
  turnId: null,
  partial: false,
  pushedAt: null,
  pushUuids: [],
  deliveredAt: null,
  handedBackAt: null,
  createdAt: '2026-11-16T10:00:00.000Z',
  updatedAt: '2026-11-16T10:00:00.000Z',
});
const said = (text: string) =>
  row(ConversationItemKind.Message, ConversationItemAuthor.Builder, { text });
const asked = (draft?: string) =>
  row(ConversationItemKind.Message, ConversationItemAuthor.Builder, {
    text: briefRequestText(draft),
    purpose: 'brief',
  });
const replied = (text: string) =>
  row(ConversationItemKind.AgentMessage, ConversationItemAuthor.Agent, { text });

describe('the brief made from the chat', () => {
  it('leaves out every brief request and the agent items of its turn, a second request included', () => {
    const items = [
      said('Fix the login'),
      replied('On it'),
      asked(),
      replied('Here is a brief. Change nothing.'),
      said('Also the logout'),
      replied('Noted'),
      asked('and tests'),
      replied('A second brief'),
    ];
    expect(chatLines(items)).toEqual([
      'Builder: Fix the login',
      'You: On it',
      'Builder: Also the logout',
      'You: Noted',
    ]);
    expect(briefFromChat(items)).not.toMatch(/Change nothing|brief/i);
    expect(briefFromChat(items)).toContain("The builder's last message: Also the logout");
  });

  it('takes the last message that is the builder’s own, never the request', () => {
    expect(lastBuilderMessage([said('one'), asked(), replied('x')])).toBe('one');
    expect(lastBuilderMessage([asked()])).toBeNull();
  });

  it('keeps a 12,000-character digest plus a long last message under the task message cap', () => {
    const items = [
      said('a'.repeat(15_000)),
      replied('b'.repeat(15_000)),
      said('c'.repeat(TASK_MESSAGE_MAX_CHARS - 100)),
    ];
    const brief = briefFromChat(items);
    expect(brief.length).toBeLessThanOrEqual(TASK_MESSAGE_MAX_CHARS);
    expect(brief).toContain('c'.repeat(1000));
  });
});
