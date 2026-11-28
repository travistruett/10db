import type { WebSocket, WebSocketServer } from 'ws';
import type { Clock, Timer } from '../clock';
import type { Logger } from '../log';

/** How often every socket is pinged; one that has not answered the previous ping is dropped. */
const PING_INTERVAL_MS = 30_000;
/**
 * The most a socket may have queued and unsent at a ping. A client that reads slower than events
 * arrive is dropped instead of growing the daemon's memory; it reconnects from its cursor.
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/**
 * Pings each socket of `wss` every 30 s and terminates one that missed the last ping (a phone that
 * slept or left the tailnet says nothing until TCP gives up) or holds more than 8 MiB unsent. Browsers
 * answer pings by themselves. Stops when `wss` closes.
 */
export function keepSocketsAlive(wss: WebSocketServer, clock: Clock, logger: Logger): void {
  const answered = new WeakSet<WebSocket>();
  wss.on('connection', (ws) => {
    answered.add(ws);
    ws.on('pong', () => {
      answered.add(ws);
    });
  });
  let timer: Timer | null = null;
  const tick = (): void => {
    for (const ws of wss.clients) {
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        logger.warn(
          { bufferedBytes: ws.bufferedAmount },
          'dropped an event socket that fell behind',
        );
        ws.terminate();
      } else if (!answered.has(ws)) {
        logger.info({}, 'dropped an event socket that stopped answering pings');
        ws.terminate();
      } else {
        answered.delete(ws);
        ws.ping();
      }
    }
    timer = clock.setTimeout(tick, PING_INTERVAL_MS);
  };
  timer = clock.setTimeout(tick, PING_INTERVAL_MS);
  wss.once('close', () => {
    timer?.cancel();
  });
}
