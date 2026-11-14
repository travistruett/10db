import type { OutboundHit, SendMode } from '@10db/contracts';

export interface HoldRecipient {
  readonly sendMode: SendMode;
  readonly dailyLimit: number | null;
  /** Something was sent to this person before; the first message to anyone is always reviewed. */
  readonly everSent: boolean;
  /** New threads sent to this person in the last 24 hours. */
  readonly newThreads: number;
}

export interface HoldInput {
  readonly hits: readonly OutboundHit[];
  readonly recipients: readonly HoldRecipient[];
  /** The open conversation this question would join, if there is one. */
  readonly thread: { readonly reviewed: boolean } | null;
}

export type Held = 'review' | 'first_send' | 'limit' | 'scan';

/**
 * Why a drafted question waits for the builder, or null when it may go at once. First match wins: scan,
 * first send, limit, review. A follow-up in a thread that already had a reviewed send skips every
 * reason but a hold; a follow-up in any thread is not a new thread, so the limit never stops it.
 */
export function holdFor(input: HoldInput): Held | null {
  if (input.hits.some((h) => h.severity === 'hold')) return 'scan';
  if (input.thread?.reviewed === true) return null;
  if (input.recipients.some((r) => !r.everSent)) return 'first_send';
  if (
    input.thread === null &&
    input.recipients.some((r) => r.dailyLimit !== null && r.newThreads >= r.dailyLimit)
  )
    return 'limit';
  if (input.recipients.some((r) => r.sendMode === 'review')) return 'review';
  return null;
}
