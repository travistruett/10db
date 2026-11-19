import { ConversationState } from '@10db/contracts';

// Sessions UI spec §7.8, §7.11: the buttons, placeholder and hint under a conversation's input, read
// from its state, whether anything is typed and how the agent takes a message sent mid-turn. DESIGN.md
// allows one filled primary per group: Send, once there is something to send.

export interface ComposerPhase {
  /** What Stop does: a plain Stop with nothing typed, Stop and Redo with text. */
  readonly stop: 'stop' | 'stop_and_redo' | null;
  readonly send: 'filled' | 'default' | 'hidden';
  readonly placeholder: string;
  readonly hint: string | null;
}

export interface ComposerPhaseInput {
  readonly state: ConversationState;
  readonly hasText: boolean;
  readonly steer: 'inject' | 'queue';
  readonly project: string;
  /** A fresh tab: no conversation yet, so no `/` commands. */
  readonly fresh: boolean;
  /** Under 640 px the hint goes. */
  readonly narrow: boolean;
  /** The agent lists slash commands. */
  readonly slashCommands?: boolean;
  /** The branch the session is being moved to; null when it is not moving. */
  readonly movingTo?: string | null;
}

/** A turn is under way (or paused by the account, which Stop can end too). */
const WORKING: ReadonlySet<ConversationState> = new Set([
  ConversationState.Starting,
  ConversationState.Running,
  ConversationState.WaitingCard,
]);

function placeholderOf(input: ComposerPhaseInput, working: boolean): string {
  if (input.fresh) return `Ask about ${input.project}…`;
  if (input.movingTo !== undefined && input.movingTo !== null)
    return `Moving to ${input.movingTo}…`;
  if (input.state === ConversationState.TakenOver) return 'Held until you hand back…';
  if (!working) return 'Reply…';
  return input.steer === 'inject' ? 'Add to this turn…' : 'Queue for the next turn…';
}

/** Only what the state needs said: the keys are the ones every chat uses, so the composer doesn't list them. */
function hintOf(input: ComposerPhaseInput): string | null {
  if (input.narrow) return null;
  if (input.state === ConversationState.PausedAccount) return 'Sends when the limit resets';
  return null;
}

export function composerPhase(input: ComposerPhaseInput): ComposerPhase {
  const working = WORKING.has(input.state);
  const stop = !working ? null : input.hasText ? 'stop_and_redo' : 'stop';
  const send = input.hasText ? 'filled' : working ? 'hidden' : 'default';
  return {
    stop,
    send,
    placeholder: placeholderOf(input, working),
    hint: hintOf(input),
  };
}
