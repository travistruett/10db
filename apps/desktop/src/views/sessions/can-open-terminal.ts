import { ConversationState, type ConversationDto } from '@10db/contracts';

/**
 * Whether a chat offers Open in Terminal: its agent can be taken over, and the chat is neither read-only nor
 * in a terminal already (the banner's Copy Command is the way back in). Refusals that depend on the folder or
 * a turn under way are the daemon's to say, in the popover.
 */
export function canOpenTerminal(conversation: ConversationDto): boolean {
  return (
    conversation.capabilities.takeover &&
    conversation.state !== ConversationState.Sealed &&
    conversation.state !== ConversationState.TakenOver
  );
}
