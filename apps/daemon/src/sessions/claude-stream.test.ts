import type { SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { createClaudeStreamState, mapClaudeStreamEvent } from './claude-stream';
import {
  blockStart,
  blockStop,
  inputJsonDelta,
  messageStart,
  streamEvent,
  textDelta,
  thinkingDelta,
} from './claude-test-support';
import type { SessionEvent } from './types';

const run = (frames: readonly SDKPartialAssistantMessage[]): SessionEvent[] => {
  const state = createClaudeStreamState();
  return frames.flatMap((frame) => mapClaudeStreamEvent(frame, state));
};

describe('mapClaudeStreamEvent', () => {
  it('a text block in two deltas gives offsets 0 and 3, then its message', () => {
    expect(
      run([
        streamEvent(messageStart('msg_1')),
        streamEvent(blockStart(0, 'text')),
        streamEvent(textDelta(0, 'Hel')),
        streamEvent(textDelta(0, 'lo')),
        streamEvent(blockStop(0)),
      ]),
    ).toEqual([
      { type: 'text_delta', itemId: 'msg_1:0', offset: 0, text: 'Hel' },
      { type: 'text_delta', itemId: 'msg_1:0', offset: 3, text: 'lo' },
      { type: 'message', itemId: 'msg_1:0', text: 'Hello' },
    ]);
  });

  it('offsets count JS length past characters outside ASCII', () => {
    expect(
      run([
        streamEvent(messageStart('msg_1')),
        streamEvent(blockStart(0, 'text')),
        streamEvent(textDelta(0, 'é😀')),
        streamEvent(textDelta(0, 'x')),
        streamEvent(blockStop(0)),
      ]),
    ).toEqual([
      { type: 'text_delta', itemId: 'msg_1:0', offset: 0, text: 'é😀' },
      { type: 'text_delta', itemId: 'msg_1:0', offset: 3, text: 'x' },
      { type: 'message', itemId: 'msg_1:0', text: 'é😀x' },
    ]);
  });

  it('a thinking block gives reasoning deltas and no message', () => {
    expect(
      run([
        streamEvent(messageStart('msg_1')),
        streamEvent(blockStart(0, 'thinking')),
        streamEvent(thinkingDelta(0, 'hmm')),
        streamEvent(blockStop(0)),
      ]),
    ).toEqual([{ type: 'reasoning_delta', itemId: 'msg_1:0', offset: 0, text: 'hmm' }]);
  });

  it('two text blocks are two items, named by their index', () => {
    const out = run([
      streamEvent(messageStart('msg_1')),
      streamEvent(blockStart(0, 'text')),
      streamEvent(textDelta(0, 'a')),
      streamEvent(blockStop(0)),
      streamEvent(blockStart(1, 'tool_use')),
      streamEvent(blockStop(1)),
      streamEvent(blockStart(2, 'text')),
      streamEvent(textDelta(2, 'b')),
      streamEvent(blockStop(2)),
    ]);
    expect(out.filter((e) => e.type === 'message')).toEqual([
      { type: 'message', itemId: 'msg_1:0', text: 'a' },
      { type: 'message', itemId: 'msg_1:2', text: 'b' },
    ]);
  });

  it("a subagent's frames give nothing", () => {
    expect(
      run([
        streamEvent(messageStart('msg_2'), 'toolu_9'),
        streamEvent(blockStart(0, 'text'), 'toolu_9'),
        streamEvent(textDelta(0, 'inner'), 'toolu_9'),
        streamEvent(blockStop(0), 'toolu_9'),
      ]),
    ).toEqual([]);
  });

  it('a tool_use block and its input deltas give nothing', () => {
    expect(
      run([
        streamEvent(messageStart('msg_1')),
        streamEvent(blockStart(0, 'tool_use')),
        streamEvent(inputJsonDelta(0, '{"command":')),
        streamEvent(blockStop(0)),
      ]),
    ).toEqual([]);
  });

  it('marks the message as streamed', () => {
    const state = createClaudeStreamState();
    mapClaudeStreamEvent(streamEvent(messageStart('msg_7')), state);
    expect(state.streamed.has('msg_7')).toBe(true);
  });
});
