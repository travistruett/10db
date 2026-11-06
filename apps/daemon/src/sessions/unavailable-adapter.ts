import { createChannel } from './channel';
import {
  AccountProbeError,
  CompletionError,
  type SessionAdapter,
  type SessionEvent,
} from './types';

/** Ends every session at once with a clear message; used until a real adapter is configured. */
export function createUnavailableAdapter(message: string): SessionAdapter {
  const ended = () => {
    const channel = createChannel<SessionEvent>();
    channel.push({ type: 'ended', reason: 'error', message });
    channel.end();
    return channel;
  };
  return {
    probeAccount: () => Promise.reject(new AccountProbeError(message)),
    complete: () => Promise.reject(new CompletionError(message)),
    start() {
      return { events: ended(), send: () => undefined, stop: () => Promise.resolve() };
    },
    startShape() {
      return {
        events: ended(),
        send: () => undefined,
        interrupt: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      };
    },
  };
}
