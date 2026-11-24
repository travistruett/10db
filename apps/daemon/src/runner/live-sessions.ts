import type { SessionId } from '@10db/contracts';
import type { WaitObserver } from '../inbox';
import type { LaneBrowserSession } from '../lane-browser';
import type { ToolImages } from '../mcp';
import type { AwayLane } from '../trust';

export interface LiveSession {
  readonly signal: AbortSignal;
  readonly observer: WaitObserver;
  /** A tool's answer told the session to hand off, so a handoff it writes is one 10db asked for. */
  askedToHandOff(): void;
  /**
   * Hands the session the pictures a tool answered, as a message. Present only for an agent that drops
   * the image blocks of a tool result.
   */
  readonly showImages?: (images: ToolImages) => void;
  /** Present for a lane nobody watches: its questions are answered at once and kept. */
  readonly away?: AwayLane;
  /** A lane session's sandbox as its browser reads it; absent for a session with no lane sandbox. */
  readonly browser?: LaneBrowserSession;
}

/**
 * Sessions with a running adapter handle; MCP tools look up their wait observer and abort signal here,
 * and tell the runner when an answer asked the session to hand off.
 */
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
