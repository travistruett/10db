import {
  ConversationItemAuthor,
  ConversationItemKind,
  InvalidError,
  noticeText,
  parseItemBody,
  ShapeMessageAuthor,
  ShapeMessageKind,
  type TaskMessageAuthor,
  TaskMessageKind,
  ToolCallStatus,
} from '@10db/contracts';
import type { Json } from '../json';
import type { schema } from '../index';

// The maps between Plan's and the threads' rows and conversation items. Migration
// 0076_conversation_copy makes the same choices in SQL, and its test checks every copied row
// against these.

/** The harness name of a Plan tool line, a finished call of 10db's own. */
export const PLAN_TOOL = '10db.plan';
/** A Plan tool line's preview is cut at this many code points, which SQL's `substr` counts too. */
const PLAN_PREVIEW_CODE_POINTS = 100;

type ItemRow = typeof schema.conversationItems.$inferSelect;

export interface ItemOf {
  readonly author: ConversationItemAuthor;
  readonly kind: ConversationItemKind;
  readonly body: Json;
}

/** The first 100 code points of a Plan tool line: at most 200 UTF-16 units, the preview's limit. */
export function planLinePreview(line: string): string {
  return Array.from(line).slice(0, PLAN_PREVIEW_CODE_POINTS).join('');
}

function shapeAuthorItem(author: ShapeMessageAuthor): ConversationItemAuthor {
  switch (author) {
    case ShapeMessageAuthor.Builder:
      return ConversationItemAuthor.Builder;
    case ShapeMessageAuthor.Claude:
      return ConversationItemAuthor.Agent;
    case ShapeMessageAuthor.Note:
      return ConversationItemAuthor.System;
  }
}

function itemAuthorShape(author: ConversationItemAuthor): ShapeMessageAuthor {
  switch (author) {
    case ConversationItemAuthor.Builder:
      return ShapeMessageAuthor.Builder;
    case ConversationItemAuthor.Agent:
      return ShapeMessageAuthor.Claude;
    case ConversationItemAuthor.System:
      return ShapeMessageAuthor.Note;
  }
}

/** A Plan row as an item; `callId` names a tool line's call. */
export function shapeItemOf(
  m: {
    readonly author: ShapeMessageAuthor;
    readonly kind: ShapeMessageKind;
    readonly body: string;
    readonly createdAt: string;
  },
  callId: string,
): ItemOf {
  const author = shapeAuthorItem(m.author);
  switch (m.kind) {
    case ShapeMessageKind.Text:
      return {
        author,
        kind:
          m.author === ShapeMessageAuthor.Builder
            ? ConversationItemKind.Message
            : ConversationItemKind.AgentMessage,
        body: { text: m.body },
      };
    case ShapeMessageKind.Notice:
    case ShapeMessageKind.Digest:
      return { author, kind: m.kind, body: { text: m.body } };
    case ShapeMessageKind.Tool:
      // The whole line stays in the title, since Plan's read budget parses it back.
      return {
        author,
        kind: ConversationItemKind.ToolCall,
        body: {
          kind: 'other',
          id: callId,
          harnessTool: PLAN_TOOL,
          status: ToolCallStatus.Done,
          title: m.body,
          startedAt: m.createdAt,
          durationMs: null,
          parentId: null,
          refusal: null,
          deniedBy: null,
          limit: null,
          soft: null,
          name: PLAN_TOOL,
          inputPreview: planLinePreview(m.body),
        },
      };
    case ShapeMessageKind.Propose:
    case ShapeMessageKind.Rehearse:
    case ShapeMessageKind.Review:
    case ShapeMessageKind.DesignReview:
    case ShapeMessageKind.Edit:
    case ShapeMessageKind.Event:
    case ShapeMessageKind.Screen:
      return {
        author,
        kind: ConversationItemKind.ShapeEvent,
        body: { kind: m.kind, text: m.body },
      };
  }
}

/**
 * `read`'s answer, or null when the row it reads holds a body its kind can't parse: one such row is
 * left out, so the rest of a transcript still opens.
 */
function readable<T>(read: () => T | null): T | null {
  try {
    return read();
  } catch (error) {
    if (error instanceof InvalidError) return null;
    throw error;
  }
}

/** An item as a Plan row; null for what Plan has no word for, or a row it can't read. */
export function shapeMessageOf(
  item: Pick<ItemRow, 'author' | 'kind' | 'body'>,
): { author: ShapeMessageAuthor; kind: ShapeMessageKind; body: string } | null {
  return readable(() => shapeMessage(item));
}

function shapeMessage(
  item: Pick<ItemRow, 'author' | 'kind' | 'body'>,
): { author: ShapeMessageAuthor; kind: ShapeMessageKind; body: string } | null {
  const author = itemAuthorShape(item.author);
  switch (item.kind) {
    case ConversationItemKind.Message:
    case ConversationItemKind.AgentMessage:
      return {
        author,
        kind: ShapeMessageKind.Text,
        body: parseItemBody(item.kind, item.body).text,
      };
    case ConversationItemKind.Notice:
      return { author, kind: item.kind, body: noticeText(parseItemBody(item.kind, item.body)) };
    case ConversationItemKind.Digest:
      return { author, kind: item.kind, body: parseItemBody(item.kind, item.body).text };
    case ConversationItemKind.ToolCall: {
      const call = parseItemBody(item.kind, item.body);
      return call.harnessTool === PLAN_TOOL
        ? { author, kind: ShapeMessageKind.Tool, body: call.title }
        : null;
    }
    case ConversationItemKind.ShapeEvent: {
      const event = parseItemBody(item.kind, item.body);
      return { author, kind: event.kind, body: event.text };
    }
    case ConversationItemKind.Reasoning:
    case ConversationItemKind.Card:
    case ConversationItemKind.Plan:
    case ConversationItemKind.TurnMarker:
      return null;
  }
}

/** A thread row as an item: a reply is the agent's message. */
export function taskItemOf(m: {
  readonly author: TaskMessageAuthor;
  readonly kind: TaskMessageKind;
  readonly body: string;
}): ItemOf {
  switch (m.kind) {
    case TaskMessageKind.Message:
    case TaskMessageKind.Notice:
      return { author: m.author, kind: m.kind, body: { text: m.body } };
    case TaskMessageKind.Reply:
      return { author: m.author, kind: ConversationItemKind.AgentMessage, body: { text: m.body } };
  }
}

/** An item as a thread row; null for what a thread has no word for, or a row it can't read. */
export function taskMessageOf(
  item: Pick<ItemRow, 'author' | 'kind' | 'body'>,
): { author: TaskMessageAuthor; kind: TaskMessageKind; body: string } | null {
  return readable(() => taskMessage(item));
}

function taskMessage(
  item: Pick<ItemRow, 'author' | 'kind' | 'body'>,
): { author: TaskMessageAuthor; kind: TaskMessageKind; body: string } | null {
  switch (item.kind) {
    case ConversationItemKind.Message:
    case ConversationItemKind.Notice:
      return {
        author: item.author,
        kind: item.kind,
        body: noticeText(parseItemBody(item.kind, item.body)),
      };
    case ConversationItemKind.AgentMessage:
      return {
        author: item.author,
        kind: TaskMessageKind.Reply,
        body: parseItemBody(item.kind, item.body).text,
      };
    case ConversationItemKind.Reasoning:
    case ConversationItemKind.ToolCall:
    case ConversationItemKind.Digest:
    case ConversationItemKind.Card:
    case ConversationItemKind.Plan:
    case ConversationItemKind.ShapeEvent:
    case ConversationItemKind.TurnMarker:
      return null;
  }
}
