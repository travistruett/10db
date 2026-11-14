import type { ConversationDeltaFrame, DaemonEvent } from '@10db/contracts';
import type { ApiServices } from './services';

const PAGE = 500;

/**
 * Sends every event with seq > `after` exactly once and in seq order: subscribe first (buffering),
 * replay from the store, flush the buffer past the last replayed seq, then go live. A live event
 * that arrives ahead of an earlier one (a listener that writes while handling an event publishes
 * the later event first) is held back until the store has supplied the earlier ones.
 * Live frames (sessions spec §6.5) go to `sendLive` only once the replay is live; they take no seq,
 * so they never touch the replay cursor, and a reconnect replays none.
 * Returns an unsubscribe function.
 */
export function streamEvents(
  after: number,
  services: Pick<ApiServices, 'eventsAfter' | 'subscribe' | 'subscribeLive'>,
  send: (event: DaemonEvent) => void,
  sendLive: (frame: ConversationDeltaFrame) => void,
): () => void {
  let lastSent = after;
  let live = false;
  const buffered: DaemonEvent[] = [];
  const emit = (event: DaemonEvent): void => {
    if (event.seq <= lastSent) return;
    send(event);
    lastSent = event.seq;
  };
  const replayBefore = (seq: number): void => {
    for (;;) {
      const page = services.eventsAfter(lastSent, PAGE);
      const earlier = page.filter((event) => event.seq < seq);
      for (const event of earlier) emit(event);
      if (earlier.length < PAGE) break;
    }
  };
  const deliver = (event: DaemonEvent): void => {
    if (event.seq > lastSent + 1) replayBefore(event.seq);
    emit(event);
  };
  const unsubscribe = services.subscribe((event) => {
    if (live) deliver(event);
    else buffered.push(event);
  });
  for (;;) {
    const page = services.eventsAfter(lastSent, PAGE);
    for (const event of page) emit(event);
    if (page.length < PAGE) break;
  }
  for (const event of buffered.sort((a, b) => a.seq - b.seq)) deliver(event);
  live = true;
  const unsubscribeLive = services.subscribeLive(sendLive);
  return () => {
    unsubscribeLive();
    unsubscribe();
  };
}
