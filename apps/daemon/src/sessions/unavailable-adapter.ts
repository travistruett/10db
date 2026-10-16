import { Provider } from '@10db/contracts';
import { createChannel } from './channel';
import type { SessionAdapter, SessionEvent } from './types';

/** Ends every session at once with a clear message; used until a real adapter is configured. */
export function createUnavailableAdapter(message: string): SessionAdapter {
  return {
    provider: Provider.Claude,
    start() {
      const channel = createChannel<SessionEvent>();
      channel.push({ type: 'ended', reason: 'error', message });
      channel.end();
      return { events: channel, send: () => undefined, stop: () => Promise.resolve() };
    },
  };
}
