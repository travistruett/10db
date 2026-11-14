import {
  mintId,
  PREVIEW_CHARS,
  ToolCallView,
  type ConversationItemDto,
  type ConversationItemId,
} from '@10db/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationEntry } from '../../conversation';
import type { LiveCall, LiveItems, LiveText } from '../../conversation/live-items';
import { builderItem, replyItem, systemItem, toolItem } from '../../test/conversation-fixtures';
import { commandCall, otherCall } from '../../test/tool-call-fixtures';
import { planItemEntries } from './plan-entries';

// M4b call 15: Plan's items, and what streams, as the kit's entries; one row per item kind and
// per Plan event.

const shapeId = mintId('Shape');
const conv = mintId('Conversation');
const SCREEN = JSON.stringify({
  screen: 'board',
  width: 1200,
  height: 900,
  name: '0001.png',
  mediaType: 'image/png',
});
const NONE: LiveItems = new Map();

/** An entry as its kind and the field that says the most about it. */
function summary(entry: ConversationEntry): string {
  switch (entry.kind) {
    case 'builder':
    case 'reasoning':
      return `${entry.kind} ${entry.text}`;
    case 'reply':
      return [
        'reply',
        ...(entry.partial ? ['partial'] : []),
        ...(entry.streaming === true ? ['streaming'] : []),
        entry.text,
      ].join(' ');
    case 'notice':
      return `notice ${entry.tone} ${entry.text}`;
    case 'divider':
      return `divider ${entry.text}${entry.action === null ? '' : ` [${entry.action.label}]`}`;
    case 'tool':
      return `tool ${entry.call.status} ${entry.call.title}`;
    case 'custom':
      return 'custom';
  }
}

const entries = (items: readonly ConversationItemDto[], live: LiveItems = NONE) =>
  planItemEntries(items, live, () => undefined, shapeId);

const planLine = (title: string) =>
  toolItem(conv, otherCall({ harnessTool: '10db.plan', title, status: 'done' }));

const event = (kind: string, text: string) =>
  systemItem(conv, { kind: 'shape_event', event: kind, text });

const marker = (resolvedAt: string | null) =>
  systemItem(conv, { kind: 'turn_marker', marker: 'send_now', resolvedAt });

describe('planItemEntries', () => {
  it.each<[string, ConversationItemDto, string[]]>([
    ["the builder's message", builderItem(conv, 'Hi'), ['builder Hi']],
    ["Plan's reply", replyItem(conv, '# Plan'), ['reply # Plan']],
    ['a reply cut short', replyItem(conv, 'Half', { partial: true }), ['reply partial Half']],
    [
      'a note',
      systemItem(conv, { kind: 'agent_message', text: 'Resumed' }),
      ['notice info Resumed'],
    ],
    [
      'reasoning',
      systemItem(conv, { kind: 'reasoning', text: 'Weighing it' }),
      ['reasoning Weighing it'],
    ],
    [
      'a Plan tool line',
      planLine('propose_plan · 1 goal, 3 loose · passed'),
      ['tool done propose_plan · 1 goal, 3 loose · passed'],
    ],
    ['an empty Plan tool line', planLine(''), []],
    [
      "the agent's own call, as stored",
      toolItem(conv, commandCall({ title: 'pnpm test', status: 'denied', deniedBy: '10db' })),
      ['tool denied pnpm test'],
    ],
    ['a notice', systemItem(conv, { kind: 'notice', text: 'Heads up' }), ['notice info Heads up']],
    [
      'a model change',
      systemItem(conv, {
        kind: 'notice',
        text: 'Now on Claude Sonnet 5.5 · claude-sonnet-5-5',
        change: { label: 'Claude Sonnet 5.5', model: 'claude-sonnet-5-5' },
      }),
      ['divider Now on Claude Sonnet 5.5 · claude-sonnet-5-5'],
    ],
    ['a digest', systemItem(conv, { kind: 'digest', text: 'x' }), []],
    ['a card', systemItem(conv, { kind: 'card', inboxItemId: mintId('InboxItem') }), []],
    [
      'a plan',
      systemItem(conv, {
        kind: 'plan',
        steps: [
          { text: 'Read', status: 'completed' },
          { text: 'Write', status: 'pending' },
        ],
      }),
      ['notice info Made a plan · 2 steps'],
    ],
    ['Propose', event('propose', 'Propose'), ['notice info You pressed Propose.']],
    ['a rehearsal', event('rehearse', 'Rehearsing'), ['notice info Rehearsing']],
    ['an event', event('event', 'Reopened'), ['notice info Reopened']],
    ['an edit note', event('edit', 'x'), []],
    ['a screenshot', event('screen', SCREEN), ['custom']],
    ['a screenshot that does not parse', event('screen', '{'), []],
    ['an open Send now line', marker(null), ['divider Send now [Send Now]']],
    ['a resolved Send now line', marker('2026-11-13T09:00:00.000Z'), []],
  ])('%s', (_name, item, expected) => {
    expect(entries([item]).map(summary)).toEqual(expected);
  });

  it('presses Send Now through the line', () => {
    const sendNow = vi.fn();
    const [entry] = planItemEntries([marker(null)], NONE, sendNow, shapeId);
    if (entry?.kind !== 'divider') throw new Error('not a divider');
    entry.action?.onClick();
    expect(sendNow).toHaveBeenCalledOnce();
  });

  it('follows what is stored with what streams, a reply as it arrives, until it is stored', () => {
    const message = builderItem(conv, 'Hi');
    const replyId: ConversationItemId = mintId('ConversationItem');
    const callId: ConversationItemId = mintId('ConversationItem');
    const call: LiveCall = {
      kind: 'tool_call',
      call: commandCall({ title: 'ls', status: 'running' }),
      output: '',
      outputOffset: 0,
    };
    const reply: LiveText = { kind: 'agent_message', text: 'Half a sen' };
    const live: LiveItems = new Map<ConversationItemId, LiveText | LiveCall>([
      [callId, call],
      [replyId, reply],
    ]);
    expect(entries([message], live).map(summary)).toEqual([
      'builder Hi',
      'tool running ls',
      'reply streaming Half a sen',
    ]);
    const stored = replyItem(conv, 'Half a sentence.', { id: replyId });
    expect(entries([message, stored], live).map(summary)).toEqual([
      'builder Hi',
      'reply Half a sentence.',
      'tool running ls',
    ]);
  });

  it('shows a running command the output streamed so far, to the tail a stored call keeps', () => {
    const callId: ConversationItemId = mintId('ConversationItem');
    const output = `${'x'.repeat(5_000)}DONE`;
    const live: LiveItems = new Map<ConversationItemId, LiveText | LiveCall>([
      [
        callId,
        {
          kind: 'tool_call',
          call: commandCall({ status: 'running', outputTail: '' }),
          output,
          outputOffset: 0,
        },
      ],
    ]);
    const [entry] = entries([], live);
    const call = entry?.kind === 'tool' ? entry.call : null;
    expect(call?.kind === 'command' ? call.outputTail : null).toBe(output.slice(-4_096));
  });

  /** The one tool call a Plan line maps to. */
  function callOf(title: string): ToolCallView {
    const [entry] = entries([planLine(title)]);
    if (entry?.kind !== 'tool') throw new Error('not a tool entry');
    return entry.call;
  }

  it('maps a Plan line to an other call, the whole line its title and preview', () => {
    const item = planLine('propose_plan · 1 goal, 3 loose · passed');
    const [entry] = entries([item]);
    expect(entry?.kind === 'tool' ? entry.call : null).toMatchObject({
      id: item.id,
      kind: 'other',
      status: 'done',
      title: 'propose_plan · 1 goal, 3 loose · passed',
      harnessTool: '10db.plan',
      name: '10db.plan',
      inputPreview: 'propose_plan · 1 goal, 3 loose · passed',
      startedAt: item.createdAt,
      deniedBy: null,
      refusal: null,
    });
  });

  it('cuts a long line in its preview and keeps it whole in its title', () => {
    const line = `see_screen · ${'x'.repeat(300)}`;
    const call = callOf(line);
    expect(call.title).toBe(line);
    expect(call.kind === 'other' ? call.inputPreview : null).toHaveLength(PREVIEW_CHARS);
  });

  it.each([
    [
      'with a reason',
      'Bash · refused · writes outside the checkout',
      'writes outside the checkout',
    ],
    ['with none', 'propose_plan · refused', null],
  ])('reads a refused line %s as stopped by 10db', (_name, title, refusal) => {
    expect(callOf(title)).toMatchObject({ status: 'denied', deniedBy: '10db', refusal });
  });

  it('builds every tool call the contract accepts', () => {
    for (const title of [
      'propose_plan · 1 goal, 3 loose · passed',
      `see_screen · ${'x'.repeat(300)}`,
      'Bash · refused · writes outside the checkout',
      'propose_plan · refused',
      'see_screen',
    ])
      expect(() => ToolCallView.parse(callOf(title))).not.toThrow();
  });
});
