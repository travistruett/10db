import {
  PREVIEW_CHARS,
  ScreenMessageBody,
  ToolCallView,
  type ConversationItemDto,
  type ShapeId,
} from '@10db/contracts';
import { createElement } from 'react';
import type { ConversationEntry } from '../../../conversation';
import { itemEntry, liveEntries } from '../../../conversation/item-entries';
import type { LiveItems } from '../../../conversation/live-items';
import { Screenshot } from './screenshot';

// Plan's conversation items, then what streams now, as the conversation kit's entries.
// A Plan tool line (`10db.plan`) is one `other` call: the kit's row reads its title, the tool's name
// before the first ` · ` and its target after. A line whose second part is `refused` is a call 10db
// stopped, with its third part, when there is one, as the reason. The digest and edit notes are for
// the session, not the builder; a card shows where Plan waits for answers, not in the list.

const SEPARATOR = ' · ';
const PLAN_TOOL = '10db.plan';

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

/** A Plan tool line as the call it records. */
function planLineCall(item: Item<'tool_call'>): ToolCallView {
  const line = item.call.title;
  const [, second, ...rest] = line.split(SEPARATOR);
  const refused = second === 'refused';
  const reason = rest.join(SEPARATOR);
  // The kit draws a wire type here, so the call is checked against its schema as it is built.
  return ToolCallView.parse({
    id: item.id,
    kind: 'other',
    harnessTool: PLAN_TOOL,
    name: PLAN_TOOL,
    title: line,
    inputPreview: line.slice(0, PREVIEW_CHARS),
    status: refused ? 'denied' : 'done',
    startedAt: item.createdAt,
    durationMs: null,
    parentId: null,
    refusal: refused && reason !== '' ? reason : null,
    deniedBy: refused ? '10db' : null,
    limit: null,
    soft: null,
  });
}

function shapeEventEntry(item: Item<'shape_event'>, shapeId: ShapeId): ConversationEntry | null {
  const { id } = item;
  switch (item.event) {
    case 'propose':
      return { kind: 'notice', id, text: 'You pressed Propose.', tone: 'info' };
    case 'rehearse':
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

/** Plan's own items first; the kinds every conversation has go to the kit's map. */
function entryOf(
  item: ConversationItemDto,
  sendNow: () => void,
  shapeId: ShapeId,
): ConversationEntry | null {
  switch (item.kind) {
    case 'tool_call':
      if (item.call.harnessTool !== PLAN_TOOL)
        return { kind: 'tool', id: item.id, call: item.call };
      return item.call.title === ''
        ? null
        : { kind: 'tool', id: item.id, call: planLineCall(item) };
    case 'shape_event':
      return shapeEventEntry(item, shapeId);
    case 'message':
    case 'agent_message':
    case 'reasoning':
    case 'notice':
    case 'card':
    case 'plan':
    case 'turn_marker':
    case 'digest':
      // Plan shows its question and permission cards beside the transcript and keeps no receipts.
      return itemEntry(item, {
        sendNow,
        label: 'Agent',
        receipts: false,
        working: false,
        cards: [],
      });
  }
}

/** The entries Plan's conversation draws as: its stored items in `seq` order, then what streams. */
export function planItemEntries(
  items: readonly ConversationItemDto[],
  live: LiveItems,
  sendNow: () => void,
  shapeId: ShapeId,
): readonly ConversationEntry[] {
  const stored = new Set<string>(items.map((item) => item.id));
  return [
    ...items.flatMap((item) => {
      const entry = entryOf(item, sendNow, shapeId);
      return entry === null ? [] : [entry];
    }),
    ...liveEntries(live, stored),
  ];
}
