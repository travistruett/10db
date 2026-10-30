import { z } from 'zod';
import { BatchId, TaskId } from './ids';

/**
 * The `detail` key of a flag that reports a failed action. It says what makes the card stale, so 10db
 * can close it when the action succeeds later.
 */
export const CARD_RESOLVES_WHEN = 'resolvesWhen';

export const CardResolvesWhen = z.discriminatedUnion('event', [
  /** A refused start: stale once every one of these tasks has started. */
  z.object({ event: z.literal('tasks_started'), taskIds: z.array(TaskId).min(1) }),
  /** A batch that did not ship: stale once the batch ships. */
  z.object({ event: z.literal('batch_shipped'), batchId: BatchId }),
  /** A refusal that offers to trust a checkout: stale once the checkout is trusted. */
  z.object({ event: z.literal('checkout_trusted'), repo: z.string().startsWith('/') }),
]);
export type CardResolvesWhen = z.infer<typeof CardResolvesWhen>;

/** The `detail` key 10db writes on a card it closed because its cause was gone. */
export const CARD_RESOLUTION = 'resolution';

export const CardResolution = z.object({
  by: z.literal('10db'),
  reason: z.string().min(1),
});
export type CardResolution = z.infer<typeof CardResolution>;
