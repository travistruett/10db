import { createChannel } from './channel';
import { TakeoverRefusedError } from './takeover-command';
import {
  AccountLoginError,
  AccountProbeError,
  CompletionError,
  ConversationUnreadError,
  McpSignInError,
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
  notes: AgentAdapter['takeoverNotes'] = () => [],
): AgentAdapter {
  const ended = () => {
    const channel = createChannel<SessionEvent>();
    channel.push({ type: 'ended', reason: 'error', message });
    channel.end();
    return channel;
  };
  return {
    capabilities: (account, model) => capabilities(account, model),
    takeoverCommand: () => {
      throw new TakeoverRefusedError(message);
    },
    takeoverNotes: (account) => notes(account),
    probeAccount: () => Promise.reject(new AccountProbeError(message)),
    startLogin: () => Promise.reject(new AccountLoginError(message)),
    startMcpSignIn: () => Promise.reject(new McpSignInError(message)),
    mcpAuthStatus: () => Promise.reject(new McpSignInError(message)),
    complete: () => Promise.reject(new CompletionError(message)),
    readClientUuids: () => Promise.reject(new ConversationUnreadError(message)),
    open() {
      return {
        events: ended(),
        send: () => undefined,
        interrupt: () => Promise.resolve(null),
        stop: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
      };
    },
  };
}
