/** How long a wait that found a claim deadlock waits before the later asker yields. */
export const DEADLOCK_YIELD_AFTER_MS = 2 * 60_000;

/** What a claim wait does about a deadlock it found, as the later asker. */
export const DeadlockMove = {
  /** Younger than 2 minutes, or nothing to give up. */
  Wait: 'wait',
  /** The rule is set to ask. */
  Card: 'card',
  Yield: 'yield',
  YieldAndQueue: 'yield_and_queue',
  YieldQueueAndReport: 'yield_queue_and_report',
} as const;
export type DeadlockMove = (typeof DeadlockMove)[keyof typeof DeadlockMove];

/**
 * The move for a deadlock; the first check that matches wins. A rule set to ask comes first, at any age, so the
 * builder who asked for the card gets today's card as before. Then a wait under 2 minutes, or one with nothing
 * to give up, keeps waiting: the cycle may clear by itself, and a yield that frees nothing breaks nothing. Past
 * that, the count of earlier breaks between the pair chooses: the first yields, the second also queues the
 * yielder, and every later one also reports.
 */
export function deadlockMove(input: {
  readonly asking: boolean;
  readonly ageMs: number;
  readonly breaks: number;
  readonly gives: number;
}): DeadlockMove {
  if (input.asking) return DeadlockMove.Card;
  if (input.ageMs < DEADLOCK_YIELD_AFTER_MS || input.gives === 0) return DeadlockMove.Wait;
  if (input.breaks === 0) return DeadlockMove.Yield;
  if (input.breaks === 1) return DeadlockMove.YieldAndQueue;
  return DeadlockMove.YieldQueueAndReport;
}
