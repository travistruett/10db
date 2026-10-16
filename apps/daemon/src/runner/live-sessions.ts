import type { SessionId } from '@10db/contracts';
import type { WaitObserver } from '../inbox';

export interface LiveSession {
  readonly signal: AbortSignal;
  readonly observer: WaitObserver;
}

/** Sessions with a running adapter handle; MCP tools look up their wait observer and abort signal here. */
export interface LiveSessions {
  register(id: SessionId, session: LiveSession): void;
  unregister(id: SessionId): void;
  get(id: SessionId): LiveSession | undefined;
}

export function createLiveSessions(): LiveSessions {
  const sessions = new Map<SessionId, LiveSession>();
  return {
    register: (id, session) => {
      sessions.set(id, session);
    },
    unregister: (id) => {
      sessions.delete(id);
    },
    get: (id) => sessions.get(id),
  };
}
