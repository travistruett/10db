import type { AccountId, Notice, PassId, WorkstreamId } from '@10db/contracts';

// Workbench spec §5.2, §6.3: a pass task's session stays open between turns and keeps its lane. When
// work that could start has no room, the warm session idle longest that frees the room it needs
// closes first; its page resumes on the builder's next message.

/** A pass task's session open between turns, holding a lane. */
export interface WarmLane {
  readonly id: WorkstreamId;
  readonly passId: PassId;
  readonly accountId: AccountId;
  /** When its last turn ended. */
  readonly idleSince: string;
}

/** Work that could start but has no room, and which of its limits are full. */
export interface RoomAsk {
  readonly accountId: AccountId;
  /** The pass the waiting task is in; null for ordinary work. */
  readonly passId: PassId | null;
  readonly full: {
    readonly global: boolean;
    readonly account: boolean;
    readonly pass: boolean;
  };
}

/**
 * The warm lane whose close makes room, or null: one idle longest among those that count against
 * every limit that is full. A full project limit is never freed this way, since a pass's lanes are
 * not counted in it.
 */
export function laneToYield(warm: readonly WarmLane[], ask: RoomAsk): WorkstreamId | null {
  const { full } = ask;
  if (!full.global && !full.account && !full.pass) return null;
  const frees = warm.filter(
    (w) =>
      (!full.account || w.accountId === ask.accountId) &&
      (!full.pass || (ask.passId !== null && w.passId === ask.passId)),
  );
  return frees.toSorted((a, b) => a.idleSince.localeCompare(b.idleSince))[0]?.id ?? null;
}

/** The notice key of a page waiting for a session to free up. */
export const FREE_SESSION_WAIT_KEY = 'pass-free-session';

/** What a page that has to wait for a session shows. */
export function freeSessionWait(working: number): Notice {
  return {
    key: FREE_SESSION_WAIT_KEY,
    tone: 'info',
    line: `Waiting for a free session: ${String(working)} ${working === 1 ? 'is' : 'are'} working`,
    body: 'Every session this page could use is busy with a turn. It starts as soon as one is free.',
  };
}
