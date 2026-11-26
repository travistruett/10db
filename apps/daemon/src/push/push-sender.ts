import {
  EventType,
  InboxItemId,
  isPushServiceEndpoint,
  pushPayloadOf,
  triagedToBuilder,
  type DaemonEvent,
} from '@10db/contracts';
import {
  deletePushSubscriptionByEndpoint,
  getInboxItem,
  listPushSubscriptions,
  type PushSubscriptionRow,
} from '@10db/db';
import { sendNotification, WebPushError } from 'web-push';
import type { EventBus, StateStore } from '../events';
import type { Logger } from '../log';
import type { VapidKeyStore } from './vapid-keys';

/** Sends one encrypted payload to one subscription; rejects with the push service's status on a refusal. */
export type PushSend = (
  subscription: PushSubscriptionRow,
  payload: string,
  vapid: { readonly publicKey: string; readonly privateKey: string },
) => Promise<void>;

/** The claim a push service may use to reach whoever runs this host; it names no person. */
const VAPID_SUBJECT = 'mailto:noreply@10db.invalid';
/** Push services keep an undelivered message at most this long; a card that old is stale anyway. */
const TTL_SECONDS = 60 * 60;

export const sendWebPush: PushSend = async (subscription, payload, vapid) => {
  await sendNotification(
    {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
    payload,
    {
      vapidDetails: { subject: VAPID_SUBJECT, ...vapid },
      TTL: TTL_SECONDS,
      urgency: 'high',
    },
  );
};

/** A push service answers 404 or 410 for a subscription that is gone for good. */
const GONE = new Set([404, 410]);

/**
 * Pushes each ask that opens for the builder to every subscribed phone: the daemon's own Inbox events, the
 * rule `pushPayloadOf` shares with the desktop's notification. A subscription the push service reports gone is
 * deleted; any other failure is logged without the endpoint and the next card tries again.
 */
export function startPushSender(deps: {
  readonly bus: Pick<EventBus, 'subscribe'>;
  readonly state: StateStore;
  readonly keys: VapidKeyStore;
  readonly log: Logger;
  readonly send?: PushSend;
}): () => void {
  const send = deps.send ?? sendWebPush;

  async function push(id: InboxItemId): Promise<void> {
    const subscriptions = listPushSubscriptions(deps.state.db);
    if (subscriptions.length === 0) return;
    const payload = pushPayloadOf(getInboxItem(deps.state.db, id));
    if (payload === null) return;
    const vapid = await deps.keys.read();
    if (vapid === null) return;
    const body = JSON.stringify(payload);
    await Promise.all(
      subscriptions.map(async (subscription) => {
        // The endpoint was checked when it was stored; a row put there another way never goes out.
        if (!isPushServiceEndpoint(subscription.endpoint)) {
          deps.state.write((ctx) => {
            deletePushSubscriptionByEndpoint(ctx, subscription.endpoint);
          });
          return;
        }
        try {
          await send(subscription, body, vapid);
        } catch (error) {
          if (error instanceof WebPushError && GONE.has(error.statusCode)) {
            deps.state.write((ctx) => {
              deletePushSubscriptionByEndpoint(ctx, subscription.endpoint);
            });
            return;
          }
          deps.log.warn(
            { status: error instanceof WebPushError ? error.statusCode : null },
            'a push was not delivered',
          );
        }
      }),
    );
  }

  return deps.bus.subscribe((event: DaemonEvent) => {
    const opened = event.type === EventType.InboxOpened;
    const triaged = event.type === EventType.InboxTriaged && triagedToBuilder(event.data);
    if (!opened && !triaged) return;
    const id = InboxItemId.safeParse(event.entityId);
    if (!id.success) return;
    push(id.data).catch((error: unknown) => {
      deps.log.warn({ err: error }, 'the push sender failed');
    });
  });
}
