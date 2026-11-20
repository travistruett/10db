import type { ConversationDto, ConversationItemDto, ShapeId, ToolCallView } from '@10db/contracts';
import { ConversationList } from '../../conversation';
import type { LiveItems } from '../../conversation/live-items';
import { useToolCallFull } from '../../daemon/conversation-queries';
import { planItemEntries } from '../sessions/plan/plan-entries';

export interface TranscriptProps {
  readonly shapeId: ShapeId | null;
  readonly conversation: ConversationDto | undefined;
  readonly items: readonly ConversationItemDto[];
  readonly live: LiveItems;
  /** The messages a row's Why? points at; a new `nonce` scrolls to them again. */
  readonly why: { readonly ids: readonly string[]; readonly nonce: number } | null;
  readonly onSendNow: () => void;
  /** Sends the builder's go-ahead for a call the judge held back softly. */
  readonly onAllow: (call: ToolCallView) => void;
  /** A reply streams. */
  readonly busy: boolean;
}

/**
 * Plan's conversation, drawn by the conversation kit from its stored items and what streams now. Its
 * speaker heading is the agent's capabilities' label, never a provider's name.
 */
export function Transcript({
  shapeId,
  conversation,
  items,
  live,
  why,
  onSendNow,
  onAllow,
  busy,
}: TranscriptProps) {
  const loadFull = useToolCallFull(conversation?.id ?? null, items);
  const entries = shapeId === null ? [] : planItemEntries(items, live, onSendNow, shapeId);
  return (
    <ConversationList
      entries={entries}
      highlight={why}
      loadFull={loadFull}
      onAllow={onAllow}
      agentLabel={conversation?.capabilities.label ?? 'Agent'}
      busy={busy}
    />
  );
}
