import {
  mintId,
  OUTPUT_TAIL_CHARS,
  type ConversationDeltaFrame,
  type ConversationId,
  type ConversationItemId,
  type ConversationLiveDto,
  type LiveItemDto,
  type ToolCallView,
} from '@10db/contracts';
import type { Clock, Timer } from '../clock';

// Sessions spec §6.5. What a conversation streams, held in memory and never stored: each in-flight
// item's text, or a call's view and output tail, sent to the UI as frames at absolute offsets. A text
// coalesces into at most one frame per `frameMs`, from the lowest offset changed since its last frame.

/** The time a frame of an item waits for more deltas. */
export const FRAME_MS = 50;

export interface LiveBuffers {
  /** The item id an adapter item or call is shown and stored under, minted at its first sight. */
  itemIdOf(adapterId: string): ConversationItemId;
  text(adapterId: string, kind: 'agent_message' | 'reasoning', offset: number, delta: string): void;
  call(view: ToolCallView, appended?: string): void;
  /** Removes a finished item, drops its pending frame, and answers what it held. */
  finish(adapterId: string): LiveItemDto | null;
  snapshot(): ConversationLiveDto['items'];
  /** Every in-flight item, for partial capture. */
  inFlight(): readonly LiveItemDto[];
  dispose(): void;
}

interface TextBuffer {
  readonly kind: 'agent_message' | 'reasoning';
  readonly itemId: ConversationItemId;
  text: string;
  /** The lowest offset changed since the last frame; null when nothing waits. */
  dirtyFrom: number | null;
  timer: Timer | null;
}

interface CallBuffer {
  readonly kind: 'tool_call';
  readonly itemId: ConversationItemId;
  view: ToolCallView;
  /** The output's last characters, and every character it has had. */
  tail: string;
  length: number;
  /** The output appended since the last frame, from offset `pendingFrom`. */
  pending: string;
  pendingFrom: number;
  timer: Timer | null;
}

export function createLiveBuffers(deps: {
  readonly conversationId: ConversationId;
  readonly clock: Clock;
  readonly send: (frame: ConversationDeltaFrame) => void;
  readonly frameMs?: number;
}): LiveBuffers {
  const frameMs = deps.frameMs ?? FRAME_MS;
  const ids = new Map<string, ConversationItemId>();
  const buffers = new Map<string, TextBuffer | CallBuffer>();
  const itemIdOf = (adapterId: string): ConversationItemId => {
    const known = ids.get(adapterId);
    if (known !== undefined) return known;
    const id = mintId('ConversationItem');
    ids.set(adapterId, id);
    return id;
  };
  const frame = (buffer: TextBuffer | CallBuffer, offset: number) => ({
    live: true as const,
    type: 'conversation.delta' as const,
    conversationId: deps.conversationId,
    itemId: buffer.itemId,
    kind: buffer.kind,
    offset,
  });
  const flush = (buffer: TextBuffer | CallBuffer): void => {
    buffer.timer?.cancel();
    buffer.timer = null;
    if (buffer.kind === 'tool_call') {
      if (buffer.pending === '') return;
      deps.send({ ...frame(buffer, buffer.pendingFrom), callPatch: { output: buffer.pending } });
      buffer.pending = '';
      buffer.pendingFrom = buffer.length;
      return;
    }
    if (buffer.dirtyFrom === null) return;
    deps.send({ ...frame(buffer, buffer.dirtyFrom), text: buffer.text.slice(buffer.dirtyFrom) });
    buffer.dirtyFrom = null;
  };
  const schedule = (buffer: TextBuffer | CallBuffer): void => {
    buffer.timer ??= deps.clock.setTimeout(() => {
      buffer.timer = null;
      flush(buffer);
    }, frameMs);
  };
  const dto = (buffer: TextBuffer | CallBuffer): LiveItemDto =>
    buffer.kind === 'tool_call'
      ? {
          itemId: buffer.itemId,
          kind: 'tool_call',
          call: buffer.view,
          output: buffer.tail,
          outputOffset: buffer.length - buffer.tail.length,
        }
      : { itemId: buffer.itemId, kind: buffer.kind, text: buffer.text };
  return {
    itemIdOf,
    text(adapterId, kind, offset, delta) {
      const found = buffers.get(adapterId);
      const buffer: TextBuffer =
        found !== undefined && found.kind !== 'tool_call'
          ? found
          : { kind, itemId: itemIdOf(adapterId), text: '', dirtyFrom: null, timer: null };
      buffers.set(adapterId, buffer);
      // A delta past what is held is written at the end, so the offsets never leave a hole.
      const at = Math.min(offset, buffer.text.length);
      const next = buffer.text.slice(0, at) + delta + buffer.text.slice(at + delta.length);
      if (next === buffer.text) return;
      // The first UTF-16 unit the delta changed: a repeat of what is held changes nothing before it.
      let from = at;
      while (from - at < delta.length && delta[from - at] === buffer.text[from]) from += 1;
      buffer.text = next;
      buffer.dirtyFrom = buffer.dirtyFrom === null ? from : Math.min(buffer.dirtyFrom, from);
      schedule(buffer);
    },
    call(view, appended) {
      const found = buffers.get(view.id);
      const known = found?.kind === 'tool_call' ? found : null;
      const buffer: CallBuffer = known ?? {
        kind: 'tool_call',
        itemId: itemIdOf(view.id),
        view,
        tail: '',
        length: 0,
        pending: '',
        pendingFrom: 0,
        timer: null,
      };
      buffers.set(view.id, buffer);
      const statusChanged = known?.view.status !== view.status;
      buffer.view = view;
      if (statusChanged) {
        flush(buffer);
        deps.send({ ...frame(buffer, buffer.length), callPatch: { view } });
      }
      if (appended === undefined || appended === '') return;
      buffer.pending += appended;
      buffer.length += appended.length;
      buffer.tail = (buffer.tail + appended).slice(-OUTPUT_TAIL_CHARS);
      schedule(buffer);
    },
    finish(adapterId) {
      const buffer = buffers.get(adapterId);
      if (buffer === undefined) return null;
      buffer.timer?.cancel();
      buffers.delete(adapterId);
      return dto(buffer);
    },
    snapshot: () => [...buffers.values()].map(dto),
    inFlight: () => [...buffers.values()].map(dto),
    dispose() {
      for (const buffer of buffers.values()) buffer.timer?.cancel();
      buffers.clear();
    },
  };
}
