import { createChannel } from './channel';
import {
  AccountLoginError,
  AccountProbeError,
  CompletionError,
  ConversationUnreadError,
  type AgentAdapter,
  type SessionEvent,
} from './types';

/**
 * Ends every session at once with a clear message; used until a real adapter is configured. It still
 * reports what its agent can do, from the harness's `capabilities`.
 */
export function createUnavailableAdapter(
  message: string,
  capabilities: AgentAdapter['capabilities'],
): AgentAdapter {
  const ended = () => {
    const channel = createChannel<SessionEvent>();
    channel.push({ type: 'ended', reason: 'error', message });
    channel.end();
    return channel;
  };
  return {
    capabilities: (account, model) => capabilities(account, model),
    probeAccount: () => Promise.reject(new AccountProbeError(message)),
    startLogin: () => Promise.reject(new AccountLoginError(message)),
    complete: () => Promise.reject(new CompletionError(message)),
    readClientUuids: () => Promise.reject(new ConversationUnreadError(message)),
    open() {
      return {
        events: ended(),
        send: () => undefined,
        interrupt: () => Promise.resolve(null),
        stop: () => Promise.resolve(),
      };
    },
  };
}
