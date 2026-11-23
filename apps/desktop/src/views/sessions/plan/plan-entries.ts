import { ScreenMessageBody, type ConversationItemDto, type ShapeId } from '@10db/contracts';
import { createElement } from 'react';
import type { ConversationEntry } from '../../../conversation';
import { Screenshot } from './screenshot';

// The Plan's own items in a session's transcript: a `shape_event` is a note, or a picture the agent took of
// a screen. Every other kind is the conversation kit's to map.

type Item<K extends ConversationItemDto['kind']> = Extract<ConversationItemDto, { kind: K }>;

/** A `screen` row's body, or null when it is not one this version understands. */
function screenOf(text: string): ScreenMessageBody | null {
  try {
    const parsed = ScreenMessageBody.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function shapeEventEntry(item: Item<'shape_event'>, shapeId: ShapeId): ConversationEntry | null {
  const { id } = item;
  switch (item.event) {
    case 'propose':
    case 'rehearse':
    case 'review':
    case 'design_review':
    case 'figma_open':
    case 'figma_bring_back':
    case 'event':
      return { kind: 'notice', id, text: item.text, tone: 'info' };
    case 'screen': {
      const screen = screenOf(item.text);
      if (screen === null) return null;
      return { kind: 'custom', id, render: () => createElement(Screenshot, { shapeId, screen }) };
    }
    case 'edit':
      return null;
  }
}

/**
 * A session with a plan draws its `shape_event` items through this map and leaves every other kind to the
 * kit's: undefined for an item that is not the Plan's, null for one that draws nothing.
 */
export function planEventEntry(
  item: ConversationItemDto,
  shapeId: ShapeId,
): ConversationEntry | null | undefined {
  return item.kind === 'shape_event' ? shapeEventEntry(item, shapeId) : undefined;
}
