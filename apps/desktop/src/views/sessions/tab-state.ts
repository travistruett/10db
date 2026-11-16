import type { ConversationState } from '@10db/contracts';

/**
 * What one tab shows (sessions UI spec §5.3): the first that holds. The states that come with tasks and
 * the terminal are added where those are built.
 */
export const TabState = {
  NeedsYou: 'needs_you',
  /** A pass of one's page ended a turn and waits for the builder to look. */
  Ready: 'ready',
  Error: 'error',
  Paused: 'paused',
  Working: 'working',
  InTerminal: 'in_terminal',
  InReview: 'in_review',
  SignedOff: 'signed_off',
  Done: 'done',
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

/** The states the Sessions badge and ⌘J count: a card to answer, a page to look at, or a stop by an error. */
export function needsYou(state: TabState): boolean {
  return state === TabState.NeedsYou || state === TabState.Ready || state === TabState.Error;
}

export interface TabWords {
  readonly spoken: string;
  readonly mark:
    | 'dot_blue'
    | 'dot_yellow'
    | 'alert_red'
    | 'pause_orange'
    | 'terminal_dim'
    | 'review_dim'
    | 'check_dim'
    | 'check_green'
    | null;
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
    case TabState.Ready:
      return {
        spoken: 'ready: look at the changes',
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
    case TabState.InReview:
      return { spoken: 'in review', mark: 'review_dim', ring: null, bold: false, dim: false };
    case TabState.SignedOff:
      return {
        spoken: 'signed off: close the pass to land it',
        mark: 'check_dim',
        ring: null,
        bold: false,
        dim: false,
      };
    case TabState.Done:
      return { spoken: 'done', mark: 'check_green', ring: null, bold: false, dim: false };
    case TabState.NewReply:
      return { spoken: 'new reply', mark: null, ring: null, bold: true, dim: false };
    case TabState.Idle:
      return { spoken: '', mark: null, ring: null, bold: false, dim: false };
  }
}

/** The widest a tab grows, and the narrowest the other tabs shrink to. */
export const TAB_MAX = 220;
export const TAB_MIN = 96;

/**
 * Each tab's width: its natural width up to 220. When they do not fit, the other tabs shrink first,
 * evenly, down to 96, and the selected one last; when even that does not fit, every other tab sits at 96,
 * the selected one keeps its natural width, and the strip scrolls.
 */
export function tabWidths(
  natural: readonly number[],
  selected: number,
  available: number,
): readonly number[] {
  const wanted = natural.map((w) => Math.min(w, TAB_MAX));
  if (wanted.reduce((sum, w) => sum + w, 0) <= available) return wanted;
  const keep = wanted[selected] ?? 0;
  const others = wanted.flatMap((w, i) => (i === selected ? [] : [w]));
  // The others give up the same width each, the narrowest keeping their own, and none go under 96.
  let room = available - keep;
  let left = others.length;
  let share = left === 0 ? 0 : room / left;
  for (const w of [...others].sort((a, b) => a - b)) {
    if (w > share) break;
    room -= w;
    left -= 1;
    share = left === 0 ? 0 : room / left;
  }
  const level = Math.max(TAB_MIN, Math.floor(share));
  return wanted.map((w, i) => (i === selected ? w : Math.min(w, level)));
}
