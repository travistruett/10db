import { describe, expect, it } from 'vitest';
import { ConversationItemKind, parseItemBody } from './conversation';
import { InvalidError } from './errors';
import { mintId } from './ids';

const call = {
  kind: 'other',
  id: 'toolu_1',
  harnessTool: '10db.plan',
  status: 'done',
  title: 'Read · src/a.ts',
  startedAt: '2026-11-12T10:00:00.000Z',
  durationMs: null,
  parentId: null,
  refusal: null,
  deniedBy: null,
  limit: null,
  soft: null,
  name: '10db.plan',
  inputPreview: 'Read · src/a.ts',
};

describe('parseItemBody', () => {
  it.each<{ kind: ConversationItemKind; body: unknown }>([
    { kind: ConversationItemKind.Message, body: { text: 'hello' } },
    { kind: ConversationItemKind.AgentMessage, body: { text: 'hi' } },
    { kind: ConversationItemKind.Reasoning, body: { text: 'thinking' } },
    { kind: ConversationItemKind.ToolCall, body: call },
    { kind: ConversationItemKind.Notice, body: { text: 'a notice' } },
    { kind: ConversationItemKind.Digest, body: { text: 'so far' } },
    { kind: ConversationItemKind.Card, body: { inboxItemId: mintId('InboxItem') } },
    {
      kind: ConversationItemKind.Plan,
      body: { steps: [{ text: 'read', status: 'in_progress' }] },
    },
    { kind: ConversationItemKind.ShapeEvent, body: { kind: 'propose', text: '{}' } },
    {
      kind: ConversationItemKind.TurnMarker,
      body: { marker: 'send_now', resolvedAt: null },
    },
  ])(
    '$kind: a valid body parses, and an empty one is refused naming the kind',
    ({ kind, body }) => {
      expect(parseItemBody(kind, body)).toEqual(body);
      expect(() => parseItemBody(kind, {})).toThrow(InvalidError);
      expect(() => parseItemBody(kind, {})).toThrow(kind);
    },
  );

  it('covers every item kind', () => {
    expect(Object.values(ConversationItemKind)).toHaveLength(10);
  });
});
