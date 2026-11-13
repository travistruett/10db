import type { SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SessionEvent } from './types';

// Sessions spec §5.4: Claude Code's partial messages as text and reasoning deltas, and each text
// block's message once it stops. Claude gives text no item id of its own, so a block's is
// `<message id>:<block index>`.

interface StreamBlock {
  readonly kind: 'text' | 'thinking';
  readonly itemId: string;
  text: string;
}

export interface ClaudeStreamState {
  /** The message the frames are streaming now. */
  messageId: string | null;
  readonly blocks: Map<number, StreamBlock>;
  /** The messages that streamed, whose finished frame then brings no second message. */
  readonly streamed: Set<string>;
  /** For a message that didn't stream: how many of its text frames came, which numbers the next. */
  readonly textFrames: Map<string, number>;
}

/** The streamed messages a session remembers, oldest first; a finished frame follows its stream at once. */
const STREAMED_KEPT = 256;

export function createClaudeStreamState(): ClaudeStreamState {
  return { messageId: null, blocks: new Map(), streamed: new Set(), textFrames: new Map() };
}

// The Messages API's streaming events, checked loosely: only the fields 10db reads.
const Index = z.int().nonnegative();
const StreamEvent = z.union([
  z.looseObject({
    type: z.literal('message_start'),
    message: z.looseObject({ id: z.string().min(1) }),
  }),
  z.looseObject({
    type: z.literal('content_block_start'),
    index: Index,
    content_block: z.looseObject({ type: z.string() }),
  }),
  z.looseObject({
    type: z.literal('content_block_delta'),
    index: Index,
    delta: z.union([
      z.looseObject({ type: z.literal('text_delta'), text: z.string() }),
      z.looseObject({ type: z.literal('thinking_delta'), thinking: z.string() }),
      z.looseObject({ type: z.string() }),
    ]),
  }),
  z.looseObject({ type: z.literal('content_block_stop'), index: Index }),
]);

/** One partial-message frame as session events; a subagent's frames, and every other event, give none. */
export function mapClaudeStreamEvent(
  msg: SDKPartialAssistantMessage,
  state: ClaudeStreamState,
): SessionEvent[] {
  if (msg.parent_tool_use_id !== null) return [];
  const parsed = StreamEvent.safeParse(msg.event);
  if (!parsed.success) return [];
  const event = parsed.data;
  switch (event.type) {
    case 'message_start': {
      state.messageId = event.message.id;
      state.blocks.clear();
      state.streamed.add(event.message.id);
      if (state.streamed.size > STREAMED_KEPT) {
        const oldest = state.streamed.values().next();
        if (oldest.done !== true) state.streamed.delete(oldest.value);
      }
      return [];
    }
    case 'content_block_start': {
      const kind = event.content_block.type;
      if (state.messageId === null || (kind !== 'text' && kind !== 'thinking')) return [];
      state.blocks.set(event.index, {
        kind,
        itemId: `${state.messageId}:${String(event.index)}`,
        text: '',
      });
      return [];
    }
    case 'content_block_delta': {
      const block = state.blocks.get(event.index);
      if (block === undefined) return [];
      const delta = event.delta;
      const piece =
        block.kind === 'text' && delta.type === 'text_delta' && 'text' in delta
          ? delta.text
          : block.kind === 'thinking' && delta.type === 'thinking_delta' && 'thinking' in delta
            ? delta.thinking
            : null;
      if (typeof piece !== 'string' || piece === '') return [];
      const offset = block.text.length;
      block.text += piece;
      return [
        {
          type: block.kind === 'text' ? 'text_delta' : 'reasoning_delta',
          itemId: block.itemId,
          offset,
          text: piece,
        },
      ];
    }
    case 'content_block_stop': {
      const block = state.blocks.get(event.index);
      state.blocks.delete(event.index);
      if (block?.kind !== 'text') return [];
      return [{ type: 'message', itemId: block.itemId, text: block.text }];
    }
  }
}

/**
 * The item id of a finished frame's text when its message didn't stream: `<message id>:a<n>`, `n`
 * counting that message's text frames; null when it streamed, whose deltas already gave its message.
 */
export function unstreamedTextId(state: ClaudeStreamState, messageId: string): string | null {
  if (state.streamed.has(messageId)) return null;
  const n = state.textFrames.get(messageId) ?? 0;
  state.textFrames.set(messageId, n + 1);
  if (state.textFrames.size > STREAMED_KEPT) {
    const oldest = state.textFrames.keys().next();
    if (oldest.done !== true) state.textFrames.delete(oldest.value);
  }
  return `${messageId}:a${String(n)}`;
}
