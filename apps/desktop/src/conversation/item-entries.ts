import {
  InboxState,
  OUTPUT_TAIL_CHARS,
  PermissionChoice,
  type ConversationItemDto,
  type InboxItemDto,
  type TaskId,
  type ToolCallView,
} from '@10db/contracts';
import { createElement } from 'react';
import type { ConversationEntry } from './entry';
import type { LiveCall, LiveItems } from './live-items';
import { MentionChips } from './mention-chips';

// A conversation's stored items, then what streams now, as the kit's entries. The kinds every
// conversation has are mapped here; a screen maps its own (Plan's events, a task's rows) before or after.

type Item<K extends ConversationItemDto['kind']> = Extract<ConversationItemDto, { kind: K }>;

export interface ItemEntryOptions {
  /** Sends what waited under the Send now line. */
  readonly sendNow: () => void;
  /** The agent's name as its capabilities give it. */
  readonly label: string;
  /** The agent says which sent messages a turn took. */
  readonly receipts: boolean;
  /** A turn is under way. */
  readonly working: boolean;
  /** The session is in the builder's terminal: a message not yet sent waits for Hand Back. */
  readonly inTerminal?: boolean;
  /** The Inbox cards the conversation has asked, open or answered: an answered one leaves a history line. */
  readonly cards: readonly InboxItemDto[];
  /** Opens the task Do It made, from the row that says the chat handed its work to it; without it the row has no Open. */
  readonly openTask?: (task: {
    readonly taskId: TaskId;
    readonly title: string;
    readonly place: 'worktree' | 'here';
  }) => void;
}

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/** What the builder answered on a card, in words. */
function answeredWords(card: InboxItemDto): string | null {
  const choice = card.answer?.choice;
  if (choice === undefined) return null;
  switch (choice) {
    case PermissionChoice.AllowOnce:
      return 'You allowed this once';
    case PermissionChoice.AllowWorkstream:
      return 'You allowed this for the session';
    case PermissionChoice.AllowProject:
      return 'You allowed this in the project';
    case PermissionChoice.Deny:
      return 'You denied this';
    default:
      return `You answered: ${choice}`;
  }
}

function messageEntry(item: Item<'message'>, opts: ItemEntryOptions): ConversationEntry {
  const unsent = item.deliveredAt === null;
  const held = opts.inTerminal === true && unsent;
  const waiting = opts.working && opts.receipts && unsent;
  const line = held
    ? 'Held until you hand back'
    : waiting
      ? `Waiting for ${opts.label} to read it`
      : null;
  const extra =
    item.mentions.length === 0 && line === null
      ? null
      : createElement(MentionChips, { paths: item.mentions, waiting: line });
  return { kind: 'builder', id: item.id, text: item.text, extra };
}

/**
 * The entry a stored item draws as, or null when it draws nothing (a digest, an open card, a settled
 * marker). A kind a screen owns (`shape_event`) is its own to map: it gets null here.
 */
export function itemEntry(
  item: ConversationItemDto,
  opts: ItemEntryOptions,
): ConversationEntry | null {
  const { id } = item;
  switch (item.kind) {
    case 'message':
      return messageEntry(item, opts);
    case 'agent_message':
      // A note's text (a resume, a model change) is 10db speaking, not either side.
      return item.author === 'system'
        ? { kind: 'notice', id, text: item.text, tone: 'info' }
        : { kind: 'reply', id, text: item.text, partial: item.partial };
    case 'reasoning':
      return { kind: 'reasoning', id, text: item.text, durationMs: null };
    case 'tool_call':
      return { kind: 'tool', id, call: item.call };
    case 'notice':
      if (item.handedTo !== undefined) {
        const { taskId, title, place } = item.handedTo;
        const { openTask } = opts;
        return {
          kind: 'divider',
          id,
          text:
            place === 'here'
              ? `Started a pass: ${title} · Your folder`
              : `Started a task: ${title} · Separate copy`,
          action:
            openTask === undefined
              ? null
              : {
                  label: 'Open',
                  onClick: () => {
                    openTask({ taskId, title, place });
                  },
                },
        };
      }
      return item.change === undefined
        ? { kind: 'notice', id, text: item.text, tone: 'info' }
        : {
            kind: 'divider',
            id,
            text: `Now on ${item.change.label} · ${item.change.model}`,
            action: null,
          };
    case 'card': {
      const card = opts.cards.find((c) => c.id === item.inboxItemId);
      if (card === undefined || card.state === InboxState.Open) return null;
      const words = answeredWords(card);
      return words === null ? null : { kind: 'notice', id, text: words, tone: 'info' };
    }
    case 'plan':
      return {
        kind: 'notice',
        id,
        text: `Made a plan · ${plural(item.steps.length, 'step', 'steps')}`,
        tone: 'info',
      };
    case 'turn_marker':
      return item.resolvedAt === null
        ? {
            kind: 'divider',
            id,
            text: 'These waited through a restart. Nothing was sent.',
            action: { label: 'Send Now', onClick: opts.sendNow },
          }
        : null;
    case 'digest':
    case 'shape_event':
      return null;
  }
}

/** A running command shows the output streamed so far, its tail as the stored call keeps it. */
function withOutput(call: ToolCallView, output: LiveCall['output']): ToolCallView {
  if (call.kind !== 'command' || output === '') return call;
  return { ...call, outputTail: output.slice(-OUTPUT_TAIL_CHARS) };
}

/** What streams now, after what is stored: a reply as it arrives, the agent's thinking, a call. */
export function liveEntries(live: LiveItems, stored: ReadonlySet<string>): ConversationEntry[] {
  return [...live].flatMap(([id, item]): ConversationEntry[] => {
    if (stored.has(id)) return [];
    switch (item.kind) {
      case 'agent_message':
        return [{ kind: 'reply', id, text: item.text, partial: false, streaming: true }];
      case 'reasoning':
        return [{ kind: 'reasoning', id, text: item.text, durationMs: null }];
      case 'tool_call':
        return item.call === null
          ? []
          : [{ kind: 'tool', id, call: withOutput(item.call, item.output) }];
    }
  });
}

/** The entries a conversation draws as: its stored items in `seq` order, then what streams. */
export function itemEntries(
  items: readonly ConversationItemDto[],
  live: LiveItems,
  opts: ItemEntryOptions,
): readonly ConversationEntry[] {
  const stored = new Set<string>(items.map((item) => item.id));
  return [
    ...items.flatMap((item) => {
      const entry = itemEntry(item, opts);
      return entry === null ? [] : [entry];
    }),
    ...liveEntries(live, stored),
  ];
}
