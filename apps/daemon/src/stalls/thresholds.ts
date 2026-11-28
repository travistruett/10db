import { QueueWaitKind } from '@10db/contracts';

const MINUTE = 60_000;

export const STALL_MINUTE_MS = MINUTE;

/** How often the stall sweep looks, and how long each kind of work may sit still before it is stuck. */
export const STALL = {
  sweepMs: MINUTE,
  /** A queued run whose wait counts. */
  queuedMs: 15 * MINUTE,
  /** A STARTING, RUNNING or VERIFYING run with no activity. */
  activeIdleMs: 20 * MINUTE,
  /** A batch in SHIPPING or CUTTING. */
  batchMovingMs: 60 * MINUTE,
} as const;

/**
 * The queued waits that never count toward a Stuck card by time: each already has its own card or
 * status line, or is the builder's own choice. A claim or a dependency is a run waiting its turn behind
 * live work, which the Board's Waiting line already shows; a holder that stops moving is caught by the
 * active-idle rule on the holder itself. A wait that can never end counts at once, whatever its kind.
 */
export const UNCOUNTED_WAITS: ReadonlySet<QueueWaitKind> = new Set([
  QueueWaitKind.Lane,
  QueueWaitKind.Account,
  QueueWaitKind.Machine,
  QueueWaitKind.Checkout,
  QueueWaitKind.Pass,
  QueueWaitKind.Parked,
  QueueWaitKind.Copy,
  QueueWaitKind.Claim,
  QueueWaitKind.Dependency,
]);
