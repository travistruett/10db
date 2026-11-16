import {
  ConversationItemDto,
  ConversationItemKind,
  noticeText,
  parseItemBody,
  type ConversationFileDto,
  type NoticeOffer,
} from '@10db/contracts';
import type { ConversationItemRow } from '@10db/db';

// Sessions spec §10: a stored item as the UI reads it. The body is parsed as its kind's, the boundary
// a row read from the database crosses.

/** What the conversation's other rows add to an item: a message's pictures, a notice's offer. */
export interface ItemExtras {
  readonly files: readonly ConversationFileDto[];
  readonly offer: NoticeOffer | null;
}

/** An item as its DTO; `hasFull` says what it keeps on disk past what it holds. */
export function itemDtoOf(
  row: ConversationItemRow,
  hasFull: boolean,
  extras: ItemExtras = { files: [], offer: null },
): ConversationItemDto {
  const common = {
    id: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    author: row.author,
    partial: row.partial,
    hasFull,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
    ...(row.turnId === null ? {} : { turnId: row.turnId }),
  };
  switch (row.kind) {
    case ConversationItemKind.Message: {
      const body = parseItemBody(row.kind, row.body);
      return ConversationItemDto.parse({
        ...common,
        kind: row.kind,
        text: body.text,
        mentions: body.mentions ?? [],
        ...(extras.files.length === 0 ? {} : { files: extras.files }),
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
        ...('kind' in body && body.kind === 'model_change'
          ? { change: { label: body.label, model: body.model } }
          : {}),
        ...('kind' in body && body.kind === 'handed_to'
          ? { handedTo: { taskId: body.taskId, title: body.title, place: body.place } }
          : {}),
        ...(extras.offer === null ? {} : { offer: extras.offer }),
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
