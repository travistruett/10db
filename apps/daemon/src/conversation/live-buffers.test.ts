import { mintId, type ConversationDeltaFrame, type ToolCallView } from '@10db/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createLiveBuffers, type LiveBuffers } from './live-buffers';

// Sessions spec §6.5: deltas coalesce into at most one frame per item per 50 ms, each at the absolute
// offset its text starts at; a call's view goes at once, and its output only as what was appended.

const conversationId = mintId('Conversation');
let clock: ManualClock;
let frames: ConversationDeltaFrame[];
let live: LiveBuffers;
beforeEach(() => {
  clock = new ManualClock();
  frames = [];
  live = createLiveBuffers({ conversationId, clock, send: (f) => frames.push(f) });
});

const command = (status: ToolCallView['status']): ToolCallView => ({
  kind: 'command',
  id: 'toolu_1',
  harnessTool: 'Bash',
  status,
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
});
const texts = () => frames.map((f) => [f.offset, f.text]);

describe('live buffers', () => {
  it('sends three deltas within 50 ms as one frame, and a later one at its offset', () => {
    live.text('m1', 'agent_message', 0, 'Hel');
    live.text('m1', 'agent_message', 3, 'lo');
    live.text('m1', 'agent_message', 5, ',');
    clock.advance(50);
    live.text('m1', 'agent_message', 6, ' you');
    clock.advance(60);
    expect(texts()).toEqual([
      [0, 'Hello,'],
      [6, ' you'],
    ]);
    expect(frames[0]?.itemId).toBe(live.itemIdOf('m1'));
  });

  it('adds nothing for a delta repeated inside one window', () => {
    live.text('m1', 'agent_message', 0, 'Hel');
    live.text('m1', 'agent_message', 0, 'Hel');
    live.text('m1', 'agent_message', 3, 'lo');
    clock.advance(50);
    expect(texts()).toEqual([[0, 'Hello']]);
  });

  it('keeps interleaved items at their own offsets', () => {
    live.text('m1', 'agent_message', 0, 'one');
    live.text('r1', 'reasoning', 0, 'think');
    clock.advance(50);
    live.text('m1', 'agent_message', 3, '!');
    live.text('r1', 'reasoning', 5, '?');
    clock.advance(50);
    expect(frames.map((f) => [f.kind, f.offset, f.text])).toEqual([
      ['agent_message', 0, 'one'],
      ['reasoning', 0, 'think'],
      ['agent_message', 3, '!'],
      ['reasoning', 5, '?'],
    ]);
  });

  it('sends a call’s view at once and on a status change, and its output as appended text', () => {
    live.call(command('running'));
    live.call(command('running'), 'ab');
    clock.advance(60);
    live.call(command('running'), 'cd');
    clock.advance(60);
    live.call(command('done'));
    expect(
      frames.map((f) => [f.offset, f.callPatch?.view?.status ?? null, f.callPatch?.output ?? null]),
    ).toEqual([
      [0, 'running', null],
      [0, null, 'ab'],
      [2, null, 'cd'],
      [4, 'done', null],
    ]);
  });

  it('sends no pending frame for an item that finished, and forgets it', () => {
    live.text('m1', 'agent_message', 0, 'Hel');
    expect(live.finish('m1')).toEqual({
      itemId: live.itemIdOf('m1'),
      kind: 'agent_message',
      text: 'Hel',
    });
    clock.advance(60);
    expect(frames).toEqual([]);
    expect(live.snapshot()).toEqual([]);
  });

  it('keeps a 4,096-character tail of a megabyte of output, and where it starts', () => {
    live.call(command('running'));
    live.call(command('running'), 'x'.repeat(1_000_000));
    const [call] = live.snapshot();
    expect(call?.kind === 'tool_call' && [call.output.length, call.outputOffset]).toEqual([
      4_096, 995_904,
    ]);
  });

  it('answers the same item id for the same adapter id', () => {
    const id = live.itemIdOf('a');
    expect(id.startsWith('cvi_')).toBe(true);
    expect(live.itemIdOf('a')).toBe(id);
    expect(live.itemIdOf('b')).not.toBe(id);
  });
});
