import type { ConversationState } from '@10db/contracts';

/**
 * What one tab shows (sessions UI spec §5.3): the first that holds.
 */
export const TabState = {
  NeedsYou: 'needs_you',
  Error: 'error',
  Paused: 'paused',
  Working: 'working',
  InTerminal: 'in_terminal',
  NewReply: 'new_reply',
  Idle: 'idle',
} as const;
export type TabState = (typeof TabState)[keyof typeof TabState];

export interface TabStateInput {
  readonly state: ConversationState;
  /** Open Inbox cards that name this conversation. */
  readonly openCards: number;
  readonly lastReplyAt: string | null;
  /** When the builder last looked at the tab; null when never. */
  readonly seenAt: string | null;
}

const WORKING: ReadonlySet<ConversationState> = new Set([
  'starting',
  'running',
  'stopping',
  'waiting_card',
]);

export function tabState({ state, openCards, lastReplyAt, seenAt }: TabStateInput): TabState {
  if (openCards > 0) return TabState.NeedsYou;
  if (state === 'ended_error') return TabState.Error;
  if (state === 'paused_account') return TabState.Paused;
  if (WORKING.has(state)) return TabState.Working;
  if (state === 'taken_over') return TabState.InTerminal;
  if (lastReplyAt !== null && (seenAt === null || lastReplyAt > seenAt)) return TabState.NewReply;
  return TabState.Idle;
}

/** The states the Sessions badge and ⌘J count: a card to answer or a stop by an error. */
export function needsYou(state: TabState): boolean {
  return state === TabState.NeedsYou || state === TabState.Error;
}

export interface TabWords {
  readonly spoken: string;
  readonly mark: 'dot_blue' | 'dot_yellow' | 'alert_red' | 'pause_orange' | 'terminal_dim' | null;
  readonly ring: 'yellow' | 'red' | null;
  readonly bold: boolean;
  /** The title is dimmed. */
  readonly dim: boolean;
}

export interface TabDetail {
  /** The title of the card the session waits on. */
  readonly cardTitle?: string;
  /** When a paused session resumes, as the builder reads it. */
  readonly resumes?: string;
}

/** How a state looks and what it says: no state is told by color alone. */
export function tabWords(state: TabState, detail: TabDetail = {}): TabWords {
  switch (state) {
    case TabState.NeedsYou:
      return {
        spoken: detail.cardTitle === undefined ? 'needs you' : `needs you: ${detail.cardTitle}`,
        mark: 'dot_yellow',
        ring: 'yellow',
        bold: false,
        dim: false,
      };
    case TabState.Error:
      return {
        spoken: 'needs you: stopped by an error',
        mark: 'alert_red',
        ring: 'red',
        bold: false,
        dim: false,
      };
    case TabState.Paused:
      return {
        spoken:
          detail.resumes === undefined
            ? 'paused: usage limit'
            : `paused: usage limit, resumes ${detail.resumes}`,
        mark: 'pause_orange',
        ring: null,
        bold: false,
        dim: false,
      };
    case TabState.Working:
      return { spoken: 'working', mark: 'dot_blue', ring: null, bold: false, dim: false };
    case TabState.InTerminal:
      return {
        spoken: 'in your terminal',
        mark: 'terminal_dim',
        ring: null,
        bold: false,
        dim: true,
      };
    case TabState.NewReply:
      return { spoken: 'new reply', mark: null, ring: null, bold: true, dim: false };
    case TabState.Idle:
      return { spoken: '', mark: null, ring: null, bold: false, dim: false };
  }
}
