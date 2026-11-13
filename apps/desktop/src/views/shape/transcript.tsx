import type { ShapeMessageDto } from '@10db/contracts';
import { ConversationList } from '../../conversation';
import { planEntries } from './plan-entries';

export interface TranscriptProps {
  readonly messages: readonly ShapeMessageDto[];
  /** The messages a row's Why? points at; a new `nonce` scrolls to them again. */
  readonly why: { readonly ids: readonly string[]; readonly nonce: number } | null;
}

/**
 * Plan's conversation, drawn by the conversation kit. Its speaker heading reads "Agent": no Plan
 * message says which agent it came from, and no label names a provider.
 */
export function Transcript({ messages, why }: TranscriptProps) {
  return <ConversationList entries={planEntries(messages)} highlight={why} agentLabel="Agent" />;
}
