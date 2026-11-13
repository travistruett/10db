import {
  PREVIEW_CHARS,
  ScreenMessageBody,
  ToolCallView,
  type ShapeMessageDto,
} from '@10db/contracts';
import { createElement } from 'react';
import type { ConversationEntry } from '../../conversation';
import { Screenshot } from './screenshot';

// Plan's stored messages as the conversation kit's entries. A tool line is one `other` call: the
// kit's row reads its title, the tool's name before the first ` · ` and its target after. A line
// whose second part is `refused` is a call 10db stopped, with its third part, when there is one,
// as the reason. The digest and edit notes are for the session, not the builder.

const SEPARATOR = ' · ';

/** A `screen` row's body, or null when it is not one this version understands. */
function screenOf(body: string): ScreenMessageBody | null {
  try {
    const parsed = ScreenMessageBody.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A tool line as the call it records. */
function toolCall(message: ShapeMessageDto): ToolCallView {
  const [, second, ...rest] = message.body.split(SEPARATOR);
  const refused = second === 'refused';
  const reason = rest.join(SEPARATOR);
  // The kit draws a wire type here, so the call is checked against its schema as it is built.
  return ToolCallView.parse({
    id: message.id,
    kind: 'other',
    harnessTool: '10db.plan',
    name: '10db.plan',
    title: message.body,
    inputPreview: message.body.slice(0, PREVIEW_CHARS),
    status: refused ? 'denied' : 'done',
    startedAt: message.createdAt,
    durationMs: null,
    parentId: null,
    refusal: refused && reason !== '' ? reason : null,
    deniedBy: refused ? '10db' : null,
    limit: null,
    soft: null,
  });
}

function entryOf(message: ShapeMessageDto): ConversationEntry | null {
  const { id, body } = message;
  switch (message.kind) {
    case 'text':
      // A note's text (a resume, a model change) is 10db speaking, not either side.
      if (message.author === 'note') return { kind: 'notice', id, text: body, tone: 'info' };
      return message.author === 'builder'
        ? { kind: 'builder', id, text: body, extra: null }
        : { kind: 'reply', id, text: body, partial: false };
    case 'tool':
      return body === '' ? null : { kind: 'tool', id, call: toolCall(message) };
    case 'screen': {
      const screen = screenOf(body);
      if (screen === null) return null;
      return {
        kind: 'custom',
        id,
        render: () => createElement(Screenshot, { shapeId: message.shapeId, screen }),
      };
    }
    case 'propose':
      return { kind: 'notice', id, text: 'You pressed Propose.', tone: 'info' };
    case 'rehearse':
    case 'event':
    case 'notice':
      return { kind: 'notice', id, text: body, tone: 'info' };
    case 'edit':
    case 'digest':
      return null;
  }
}

/** The entries Plan's messages draw as, in order. */
export function planEntries(messages: readonly ShapeMessageDto[]): readonly ConversationEntry[] {
  return messages.flatMap((m) => {
    const entry = entryOf(m);
    return entry === null ? [] : [entry];
  });
}
