import { RoutedBy, SendState, type InboxItemDto } from '@10db/contracts';
import { z } from 'zod';

/**
 * Whether a card that just opened is worth a notification: not one triage is still placing, and not one
 * that went straight out to someone, since neither needs the builder.
 */
export function shouldNotifyOpened(item: InboxItemDto): boolean {
  if (item.routedBy === RoutedBy.TriagePending) return false;
  return item.send?.state !== SendState.Sent && item.send?.state !== SendState.Sending;
}

const TriagedData = z.object({ toBuilder: z.boolean() });

/** Whether triage left a card with the builder, which is when it becomes worth a notification. */
export function triagedToBuilder(data: unknown): boolean {
  const parsed = TriagedData.safeParse(data);
  return parsed.success && parsed.data.toBuilder;
}
