import { z } from 'zod';
import type { InboxItemDto } from './entities';
import { RoutedBy, SendState } from './states';

/**
 * Whether a card that just opened is worth a notification: not one triage is still placing, and not one
 * that went straight out to someone, since neither needs the builder. The desktop's notification and the
 * phone's push both read this, so the two cannot disagree.
 */
export function shouldNotifyOpened(item: InboxItemDto): boolean {
  if (item.routedBy === RoutedBy.TriagePending) return false;
  const send = item.send;
  if (send?.state === SendState.Sent || send?.state === SendState.Sending) return false;
  // A draft nothing holds goes out by itself (Send Without Asking): it needs nothing from the builder.
  return !(send?.state === SendState.Draft && send.heldBy === null);
}

const TriagedData = z.object({ toBuilder: z.boolean() });

/** Whether triage left a card with the builder, which is when it becomes worth a notification. */
export function triagedToBuilder(data: unknown): boolean {
  const parsed = TriagedData.safeParse(data);
  return parsed.success && parsed.data.toBuilder;
}
