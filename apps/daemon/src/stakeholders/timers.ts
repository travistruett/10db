import type { StakeholderTimersDto } from '@10db/contracts';

export interface TimedSend {
  /** When the wait began: the send, or the builder's last Keep Waiting. */
  readonly waitStartedAt: string;
  readonly remindedAt: string | null;
  readonly returnedAt: string | null;
  /** A lone reply is waiting for its quiet tick, and since when. */
  readonly loneReplyPendingSince: string | null;
  /** An approval was seen and waits to be confirmed on the next tick, and since when. */
  readonly approvalSeenAt?: string | null;
}

export type DueTimer = 'none' | 'remind' | 'return';

const HOUR_MS = 3_600_000;
/** How long past its due time a timer waits for a reply that was already on its way: two ticks. */
const HOLD_MS = 2 * 60_000;

/**
 * What the wall clock says is owed on a send. The return wins when both are due (a Mac that slept through
 * both), a send already returned owes nothing, and a reply or approval that was already waiting before a
 * timer came due holds it for a tick or two, so the reply answers the card instead.
 */
export function dueTimers(send: TimedSend, timers: StakeholderTimersDto, now: Date): DueTimer {
  if (send.returnedAt !== null) return 'none';
  const start = Date.parse(send.waitStartedAt);
  const held = (dueAt: number): boolean => {
    if (now.getTime() >= dueAt + HOLD_MS) return false;
    const before = (iso: string | null | undefined): boolean =>
      iso !== null && iso !== undefined && Date.parse(iso) < dueAt;
    return before(send.loneReplyPendingSince) || before(send.approvalSeenAt);
  };
  const returnAt = start + timers.returnAfterHours * HOUR_MS;
  if (now.getTime() >= returnAt) return held(returnAt) ? 'none' : 'return';
  if (timers.remindAfterHours !== null && send.remindedAt === null) {
    const remindAt = start + timers.remindAfterHours * HOUR_MS;
    if (now.getTime() >= remindAt) return held(remindAt) ? 'none' : 'remind';
  }
  return 'none';
}
