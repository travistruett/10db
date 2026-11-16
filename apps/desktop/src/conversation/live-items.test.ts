import { mintId, type ConversationDeltaFrame, type ToolCallView } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { applyFrame, liveItemsOf, streamingOf, type LiveItems } from './live-items';

// Sessions spec §6.5: a live item is rebuilt from frames by absolute offset, whatever order, repeat or
// gap they arrive in; a gap asks for /live again.

const conversationId = mintId('Conversation');
const a = mintId('ConversationItem');
const b = mintId('ConversationItem');
const none = new Set<ReturnType<typeof mintId<'ConversationItem'>>>();

const text = (itemId: typeof a, offset: number, t: string): ConversationDeltaFrame => ({
  live: true,
  type: 'conversation.delta',
  conversationId,
  itemId,
  kind: 'agent_message',
  offset,
  text: t,
});
const view: ToolCallView = {
  kind: 'command',
  id: 'toolu_1',
  harnessTool: 'Bash',
  status: 'running',
  title: 'pnpm test',
  startedAt: '2026-11-13T10:00:00.000Z',
  durationMs: null,
  parentId: null,
  refusal: null,
  deniedBy: null,
  limit: null,
  soft: null,
  command: 'pnpm test',
  cwd: null,
  outputTail: '',
  outputBytes: 0,
  exitCode: null,
};
const out = (offset: number, output: string): ConversationDeltaFrame => ({
  live: true,
  type: 'conversation.delta',
  conversationId,
  itemId: a,
  kind: 'tool_call',
  offset,
  callPatch: { output },
});

function run(frames: readonly ConversationDeltaFrame[], start: LiveItems = new Map()) {
  let items = start;
  let gap = false;
  for (const frame of frames) {
    const next = applyFrame(items, frame, none);
    items = next.items;
    gap ||= next.gap;
  }
  return { items, gap };
}
const textOf = (items: LiveItems, id: typeof a) => {
  const item = items.get(id);
  return item?.kind === 'tool_call' ? null : item?.text;
};

describe('applyFrame, text', () => {
  it.each<{ name: string; frames: ConversationDeltaFrame[]; want: string; gap: boolean }>([
    { name: 'in order', frames: [text(a, 0, 'Hel'), text(a, 3, 'lo')], want: 'Hello', gap: false },
    {
      name: 'a duplicate',
      frames: [text(a, 0, 'Hel'), text(a, 0, 'Hel')],
      want: 'Hel',
      gap: false,
    },
    {
      name: 'an overlap',
      frames: [text(a, 0, 'Hello'), text(a, 3, 'lo, you')],
      want: 'Hello, you',
      gap: false,
    },
    { name: 'a gap', frames: [text(a, 0, 'Hel'), text(a, 5, 'x')], want: 'Hel', gap: true },
  ])('$name', ({ frames, want, gap }) => {
    const got = run(frames);
    expect(textOf(got.items, a)).toBe(want);
    expect(got.gap).toBe(gap);
  });

  it('keeps interleaved items apart', () => {
    const got = run([text(a, 0, 'one'), text(b, 0, 'two'), text(a, 3, '!'), text(b, 3, '?')]);
    expect([textOf(got.items, a), textOf(got.items, b)]).toEqual(['one!', 'two?']);
  });

  it('drops a frame of an item already stored', () => {
    const got = applyFrame(new Map(), text(a, 0, 'late'), new Set([a]));
    expect(got).toEqual({ items: new Map(), gap: false });
  });
});

describe('applyFrame, a call', () => {
  it('takes the view, then appends output by offset with the same duplicate and gap rules', () => {
    const viewed = run([
      { ...out(0, ''), callPatch: { view } },
      out(0, 'ok\n'),
      out(0, 'ok\n'),
      out(3, 'done\n'),
    ]);
    expect(viewed.items.get(a)).toEqual({
      kind: 'tool_call',
      call: view,
      output: 'ok\ndone\n',
      outputOffset: 0,
    });
    expect(run([out(9, 'x')], viewed.items).gap).toBe(true);
  });

  it('continues a tail /live answered from where it starts', () => {
    const start = liveItemsOf({
      conversationId,
      items: [
        {
          itemId: a,
          kind: 'tool_call',
          call: view,
          output: 'y'.repeat(4096),
          outputOffset: 10_000,
        },
      ],
      waitingForFolder: false,
    });
    const appended = applyFrame(start, out(14_096, 'z'), none);
    expect(appended.gap).toBe(false);
    const call = appended.items.get(a);
    expect(call?.kind === 'tool_call' && call.output.endsWith('z')).toBe(true);
    expect(call?.kind === 'tool_call' && call.output.length).toBe(4096);
    expect(call?.kind === 'tool_call' && call.outputOffset).toBe(10_001);
    expect(applyFrame(start, out(9_000, 'old'), none)).toEqual({ items: start, gap: false });
    expect(applyFrame(start, out(15_000, 'far'), none).gap).toBe(true);
  });
});

describe('streamingOf', () => {
  const call = (status: 'running' | 'done') =>
    ({ kind: 'tool_call', call: commandView(status), output: '', outputOffset: 0 }) as const;
  function commandView(status: 'running' | 'done'): ToolCallView {
    return {
      id: 'c',
      kind: 'command',
      harnessTool: 'Bash',
      title: 'ls',
      startedAt: '2026-11-13T10:00:00.000Z',
      durationMs: null,
      parentId: null,
      refusal: null,
      deniedBy: null,
      limit: null,
      soft: null,
      command: 'ls',
      cwd: null,
      outputTail: '',
      outputBytes: 0,
      exitCode: null,
      status,
    };
  }
  it.each<[string, LiveItems, ReadonlySet<typeof a>, string | null]>([
    ['nothing streams', new Map(), none, null],
    ['a reply streams', new Map([[a, { kind: 'agent_message', text: 'Hi' }]]), none, 'text'],
    [
      'thinking streams last',
      new Map([
        [a, { kind: 'agent_message', text: 'Hi' }],
        [b, { kind: 'reasoning', text: 'Hm' }],
      ]),
      none,
      'reasoning',
    ],
    ['a call runs', new Map([[a, call('running')]]), none, 'tool'],
    ['a call finished, not yet stored', new Map([[a, call('done')]]), none, null],
    [
      'the reply is stored',
      new Map([[a, { kind: 'agent_message', text: 'Hi' }]]),
      new Set([a]),
      null,
    ],
  ])('%s', (_name, live, stored, streaming) => {
    expect(streamingOf(live, stored).streaming).toBe(streaming);
  });
});
