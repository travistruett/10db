import type {
  ConversationDeltaFrame,
  ConversationItemId,
  ConversationLiveDto,
  ToolCallView,
} from '@10db/contracts';

// Sessions spec §6.5. What a conversation is streaming, rebuilt from live frames by absolute offset:
// a repeated frame adds nothing, an overlap applies only its new tail, and a frame past what is held
// is a gap, which reads /live again. A call keeps the last 4,096 characters of its output.

/** The most of a call's output kept while it streams, as the stored item keeps. */
const OUTPUT_KEPT = 4_096;

export interface LiveText {
  readonly kind: 'agent_message' | 'reasoning';
  readonly text: string;
}

export interface LiveCall {
  readonly kind: 'tool_call';
  readonly call: ToolCallView | null;
  /** The output held, from `outputOffset` on. */
  readonly output: string;
  readonly outputOffset: number;
}

export type LiveItems = ReadonlyMap<ConversationItemId, LiveText | LiveCall>;

export function liveItemsOf(dto: ConversationLiveDto): LiveItems {
  return new Map(
    dto.items.map((item) => [
      item.itemId,
      item.kind === 'tool_call'
        ? {
            kind: 'tool_call',
            call: item.call,
            output: item.output,
            outputOffset: item.outputOffset,
          }
        : { kind: item.kind, text: item.text },
    ]),
  );
}

/**
 * `held` with `added` written at absolute `offset`, where `held` starts at `start`; null for a gap. A
 * write wholly inside what is held changes nothing.
 */
function written(held: string, start: number, offset: number, added: string): string | null {
  const end = start + held.length;
  if (offset > end) return null;
  const from = Math.max(0, end - offset);
  return from >= added.length ? held : held + added.slice(from);
}

/**
 * Applies one frame by absolute offset; `gap` asks the caller to read `/live` again. Frames of a stored
 * item are dropped, since the stored item replaced the live one.
 */
export function applyFrame(
  items: LiveItems,
  frame: ConversationDeltaFrame,
  stored: ReadonlySet<ConversationItemId>,
): { readonly items: LiveItems; readonly gap: boolean } {
  if (stored.has(frame.itemId)) return { items, gap: false };
  const before = items.get(frame.itemId);
  const next = new Map(items);
  if (frame.kind === 'tool_call') {
    const call: LiveCall =
      before?.kind === 'tool_call'
        ? before
        : { kind: 'tool_call', call: null, output: '', outputOffset: 0 };
    const view = frame.callPatch?.view ?? call.call;
    const added = frame.callPatch?.output;
    if (added === undefined) {
      next.set(frame.itemId, { ...call, call: view });
      return { items: next, gap: false };
    }
    const output = written(call.output, call.outputOffset, frame.offset, added);
    if (output === null) return { items, gap: true };
    if (output === call.output && view === call.call) return { items, gap: false };
    const cut = Math.max(0, output.length - OUTPUT_KEPT);
    next.set(frame.itemId, {
      kind: 'tool_call',
      call: view,
      output: output.slice(cut),
      outputOffset: call.outputOffset + cut,
    });
    return { items: next, gap: false };
  }
  const held = before !== undefined && before.kind !== 'tool_call' ? before.text : '';
  const text = written(held, 0, frame.offset, frame.text ?? '');
  if (text === null) return { items, gap: true };
  if (before !== undefined && text === held) return { items, gap: false };
  next.set(frame.itemId, { kind: frame.kind, text });
  return { items: next, gap: false };
}

/** What streams last, of the items not stored yet: the reply's text, the agent's thinking, or a call. */
export function streamingOf(
  live: LiveItems,
  stored: ReadonlySet<ConversationItemId>,
): {
  readonly streaming: 'text' | 'reasoning' | 'tool' | null;
  readonly call: ToolCallView | null;
} {
  const last = [...live].filter(([id]) => !stored.has(id)).at(-1)?.[1];
  switch (last?.kind) {
    case undefined:
      return { streaming: null, call: null };
    case 'agent_message':
      return { streaming: 'text', call: null };
    case 'reasoning':
      return { streaming: 'reasoning', call: null };
    case 'tool_call':
      return last.call?.status === 'running'
        ? { streaming: 'tool', call: last.call }
        : { streaming: null, call: null };
  }
}
