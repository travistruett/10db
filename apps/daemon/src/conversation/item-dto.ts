import {
  ConversationItemDto,
  ConversationItemKind,
  noticeText,
  parseItemBody,
} from '@10db/contracts';
import type { ConversationItemRow } from '@10db/db';

// Sessions spec §10: a stored item as the UI reads it. The body is parsed as its kind's, the boundary
// a row read from the database crosses.

/** An item as its DTO; `hasFull` says what it keeps on disk past what it holds. */
export function itemDtoOf(row: ConversationItemRow, hasFull: boolean): ConversationItemDto {
  const common = {
    id: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    author: row.author,
    partial: row.partial,
    hasFull,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
  };
  switch (row.kind) {
    case ConversationItemKind.Message: {
      const body = parseItemBody(row.kind, row.body);
      return ConversationItemDto.parse({
        ...common,
        kind: row.kind,
        text: body.text,
        mentions: body.mentions ?? [],
      });
    }
    case ConversationItemKind.AgentMessage:
    case ConversationItemKind.Reasoning:
    case ConversationItemKind.Digest:
      return ConversationItemDto.parse({
        ...common,
        kind: row.kind,
        text: parseItemBody(row.kind, row.body).text,
      });
    case ConversationItemKind.Notice: {
      const body = parseItemBody(row.kind, row.body);
      return ConversationItemDto.parse({
        ...common,
        kind: row.kind,
        text: noticeText(body),
        ...('kind' in body ? { change: { label: body.label, model: body.model } } : {}),
      });
    }
    case ConversationItemKind.ToolCall:
      return ConversationItemDto.parse({
        ...common,
        kind: row.kind,
        call: parseItemBody(row.kind, row.body),
      });
    case ConversationItemKind.Card:
      return ConversationItemDto.parse({
        ...common,
        kind: row.kind,
        inboxItemId: parseItemBody(row.kind, row.body).inboxItemId,
      });
    case ConversationItemKind.Plan:
      return ConversationItemDto.parse({
        ...common,
        kind: row.kind,
        steps: parseItemBody(row.kind, row.body).steps,
      });
    case ConversationItemKind.ShapeEvent: {
      const body = parseItemBody(row.kind, row.body);
      return ConversationItemDto.parse({
        ...common,
        kind: row.kind,
        event: body.kind,
        text: body.text,
      });
    }
    case ConversationItemKind.TurnMarker: {
      const body = parseItemBody(row.kind, row.body);
      return ConversationItemDto.parse({
        ...common,
        kind: row.kind,
        marker: body.marker,
        resolvedAt: body.resolvedAt,
      });
    }
  }
}
