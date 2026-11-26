import { z } from 'zod';
import type { InboxItemDto } from './entities';
import { InboxItemId } from './ids';
import { InboxKind, InboxState } from './states';
import { PassCheckDetail } from './passes';
import { shouldNotifyOpened } from './worth-notifying';

/**
 * The push services a subscription may name. The daemon POSTs to the endpoint a device gives it, so a device
 * that is paired but not trusted with the Mac's network must not be able to point it at an address behind the
 * firewall (SSRF): only the hosts the browsers' own push services use, over https.
 */
export const PUSH_SERVICE_HOSTS = {
  /** Chrome and Android (FCM), and Firefox. */
  exact: ['fcm.googleapis.com', 'updates.push.services.mozilla.com'],
  /** Safari (Apple) and Edge (Windows) name a host under these. */
  suffixes: ['.push.apple.com', '.notify.windows.com'],
} as const;

/** Whether an endpoint is an https URL, on port 443, at a known push service and with no credentials in it. */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) return false;
  if (url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  return (
    PUSH_SERVICE_HOSTS.exact.some((name) => name === host) ||
    PUSH_SERVICE_HOSTS.suffixes.some((suffix) => host.endsWith(suffix))
  );
}

/** What a phone's browser hands over when it subscribes to push (`PushSubscription.toJSON()`'s keys). */
export const PushSubscriptionInput = z.object({
  endpoint: z.url().max(2048).refine(isPushServiceEndpoint, 'Not a known push service'),
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
