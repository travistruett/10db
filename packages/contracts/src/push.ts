import { z } from 'zod';
import type { InboxItemDto } from './entities';
import { InboxItemId } from './ids';
import { InboxKind, InboxState } from './states';
import { PassCheckDetail } from './passes';
import { shouldNotifyOpened } from './worth-notifying';

/** What a phone's browser hands over when it subscribes to push (`PushSubscription.toJSON()`'s keys). */
export const PushSubscriptionInput = z.object({
  endpoint: z.url().max(2048),
  p256dh: z.string().min(1).max(256),
  auth: z.string().min(1).max(64),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;

/** The host's VAPID public key, base64url, for `pushManager.subscribe`. */
export const PushKeyDto = z.object({ key: z.string().min(1) });
export type PushKeyDto = z.infer<typeof PushKeyDto>;

export const PUSH_HEADLINE_MAX = 120;

/**
 * Everything a push carries. A lock screen is public, so it is the card's kind and its headline and the id the
 * tap opens, and nothing else: no body, no options, no project, no path.
 */
export const PushPayload = z.strictObject({
  kind: z.enum(InboxKind),
  headline: z.string().max(PUSH_HEADLINE_MAX),
  inboxItemId: InboxItemId,
});
export type PushPayload = z.infer<typeof PushPayload>;

/**
 * The push for a card that just opened for the builder, or null when it is not an ask worth a buzz: not open,
 * placed elsewhere (the desktop's rule), or a Workbench page-ready card, which is a notice and never pushes.
 */
export function pushPayloadOf(item: InboxItemDto): PushPayload | null {
  if (item.state !== InboxState.Open || !shouldNotifyOpened(item)) return null;
  if (item.kind === InboxKind.Check && PassCheckDetail.safeParse(item.detail).success) return null;
  return {
    kind: item.kind,
    headline: item.title.slice(0, PUSH_HEADLINE_MAX),
    inboxItemId: item.id,
  };
}
