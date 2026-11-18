import { ConversationItemDto, mintId, type InboxItemDto } from '@10db/contracts';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { builderItem, replyItem, systemItem, toolItem } from '../test/conversation-fixtures';
import { inboxItemDto } from '../test/fixtures';
import { commandCall } from '../test/tool-call-fixtures';
import { renderWithTheme } from '../test/theme';
import type { ConversationEntry } from './entry';
import { itemEntries, type ItemEntryOptions } from './item-entries';
import type { LiveItems } from './live-items';

// One map from a conversation's items, and what streams, to the kit's rows.

const conv = mintId('Conversation');
const NONE: LiveItems = new Map();

const opts: ItemEntryOptions = {
  sendNow: () => undefined,
  label: 'Claude Code',
  receipts: true,
  working: false,
  cards: [],
};

function summary(entry: ConversationEntry): string {
  switch (entry.kind) {
    case 'builder':
    case 'reasoning':
      return `${entry.kind} ${entry.text}`;
    case 'reply':
      return `reply${entry.partial ? ' partial' : ''}${entry.streaming === true ? ' streaming' : ''} ${entry.text}`;
    case 'notice':
      return `notice ${entry.text}`;
    case 'divider':
      return `divider ${entry.text}${entry.action === null ? '' : ` [${entry.action.label}]`}`;
    case 'tool':
      return `tool ${entry.call.status}${entry.call.deniedBy === null ? '' : ` by ${entry.call.deniedBy}`}${entry.call.refusal === null ? '' : ` (${entry.call.refusal})`} ${entry.call.title}`;
    case 'custom':
      return 'custom';
  }
}

const entries = (
  items: readonly ConversationItemDto[],
  over: Partial<ItemEntryOptions> = {},
  live: LiveItems = NONE,
) => itemEntries(items, live, { ...opts, ...over });

const answeredCard = (choice: string): [ConversationItemDto, InboxItemDto] => {
  const card = inboxItemDto({
    kind: 'permission',
    state: 'RESOLVED',
    answer: { choice },
  });
  return [systemItem(conv, { kind: 'card', inboxItemId: card.id }), card];
};

describe('itemEntries', () => {
  it.each<[string, ConversationItemDto, string[]]>([
    ['the builder’s message', builderItem(conv, 'Hi'), ['builder Hi']],
    [
      'a carry-on line, which 10db posted, as a notice',
      ConversationItemDto.parse({
        ...builderItem(conv, 'The builder chose a new branch, b. Carry on.'),
        purpose: 'carry_on',
      }),
      ['notice The builder chose a new branch, b. Carry on.'],
    ],
    ['a reply', replyItem(conv, '# Hi'), ['reply # Hi']],
    ['a reply cut short', replyItem(conv, 'Half', { partial: true }), ['reply partial Half']],
    ['a note', systemItem(conv, { kind: 'agent_message', text: 'Resumed' }), ['notice Resumed']],
    [
      'reasoning',
      systemItem(conv, { kind: 'reasoning', text: 'Weighing' }),
      ['reasoning Weighing'],
    ],
    [
      'a call keeps who denied it and why',
      toolItem(
        conv,
        commandCall({
          title: 'pnpm test',
          status: 'denied',
          deniedBy: '10db',
          refusal: 'folder in use',
        }),
      ),
      ['tool denied by 10db (folder in use) pnpm test'],
    ],
    ['a notice', systemItem(conv, { kind: 'notice', text: 'Heads up' }), ['notice Heads up']],
    [
      'a model change',
      systemItem(conv, {
        kind: 'notice',
        text: 'x',
        change: { label: 'Claude Code', model: 'opus' },
      }),
      ['divider Now on Claude Code · opus'],
    ],
    ['an open card', systemItem(conv, { kind: 'card', inboxItemId: mintId('InboxItem') }), []],
    [
      'a plan',
      systemItem(conv, {
        kind: 'plan',
        steps: [
          { text: 'Read', status: 'completed' },
          { text: 'Write', status: 'pending' },
        ],
      }),
      ['notice Made a plan · 2 steps'],
    ],
    ['a digest', systemItem(conv, { kind: 'digest', text: 'x' }), []],
    [
      'an open restart marker',
      systemItem(conv, { kind: 'turn_marker', marker: 'send_now', resolvedAt: null }),
      ['divider These waited through a restart. Nothing was sent. [Send Now]'],
    ],
    [
      'a settled restart marker',
      systemItem(conv, {
        kind: 'turn_marker',
        marker: 'send_now',
        resolvedAt: '2026-11-13T09:00:00.000Z',
      }),
      [],
    ],
  ])('%s', (_name, item, expected) => {
    expect(entries([item]).map(summary)).toEqual(expected);
  });

  it.each([
    ['allow_once', 'You allowed this once'],
    ['allow_workstream', 'You allowed this for the session'],
    ['deny', 'You denied this'],
    ['Retry once', 'You answered: Retry once'],
  ])('an answered card (%s) leaves one dimmed line', (choice, words) => {
    const [item, card] = answeredCard(choice);
    expect(entries([item], { cards: [card] }).map(summary)).toEqual([`notice ${words}`]);
  });

  it('shows the waiting-for-receipt line only while working with receipts and no delivery', () => {
    const waiting = { ...builderItem(conv, 'Hi'), deliveredAt: null };
    const draw = (over: Partial<ItemEntryOptions>) => {
      const entry = entries([waiting], over)[0];
      if (entry?.kind !== 'builder') throw new Error('no builder entry');
      return renderWithTheme(<>{entry.extra}</>);
    };
    const line = 'Waiting for Claude Code to read it';
    for (const [over, shown] of [
      [{ working: true }, true],
      [{ working: true, receipts: false }, false],
      [{ working: false }, false],
    ] as const) {
      const { unmount } = draw(over);
      expect(screen.queryByText(line) !== null).toBe(shown);
      unmount();
    }
  });

  it('in the builder’s terminal, a message not yet sent is held and a sent one is not', () => {
    const draw = (deliveredAt: string | null) => {
      const entry = entries([{ ...builderItem(conv, 'Hi'), deliveredAt }], {
        inTerminal: true,
        receipts: false,
      })[0];
      if (entry?.kind !== 'builder') throw new Error('no builder entry');
      return renderWithTheme(<>{entry.extra}</>);
    };
    const held = draw(null);
    expect(screen.queryByText('Held until you hand back')).not.toBeNull();
    held.unmount();
    draw('2026-11-13T09:00:00.000Z');
    expect(screen.queryByText('Held until you hand back')).toBeNull();
  });

  it('draws a message’s mentions as chips', () => {
    const item = { ...builderItem(conv, 'See @src/a.ts'), mentions: ['src/a.ts'] };
    const entry = entries([item])[0];
    if (entry?.kind !== 'builder') throw new Error('no builder entry');
    const { container } = renderWithTheme(<>{entry.extra}</>);
    expect(container.querySelector('code')?.textContent).toBe('src/a.ts');
  });

  it('puts what streams after what is stored, and not twice', () => {
    const stored = replyItem(conv, 'Done');
    const live: LiveItems = new Map([
      [stored.id, { kind: 'agent_message', text: 'Done' }],
      [mintId('ConversationItem'), { kind: 'agent_message', text: 'Next, I' }],
    ]);
    expect(entries([stored], {}, live).map(summary)).toEqual([
      'reply Done',
      'reply streaming Next, I',
    ]);
  });

  it('presses Send Now through the marker', () => {
    const sendNow = vi.fn();
    const marker = systemItem(conv, { kind: 'turn_marker', marker: 'send_now', resolvedAt: null });
    const entry = entries([marker], { sendNow })[0];
    if (entry?.kind !== 'divider') throw new Error('no divider');
    entry.action?.onClick();
    expect(sendNow).toHaveBeenCalledOnce();
  });
});
