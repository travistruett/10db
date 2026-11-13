import type { ConversationDeltaFrame } from '@10db/contracts';

/**
 * The live channel (sessions spec §6.5): frames of what a conversation is streaming, sent to the
 * event socket's clients and never stored, so they take no replay seq. A frame's text is the agent's,
 * so it is never logged.
 */
export interface LiveFrames {
  publish(frame: ConversationDeltaFrame): void;
  subscribe(listener: (frame: ConversationDeltaFrame) => void): () => void;
}

/** Delivers each frame to every listener; a throwing listener is reported and does not stop the rest. */
export function createLiveFrames(
  onListenerError: (error: unknown) => void = () => undefined,
): LiveFrames {
  const listeners = new Set<(frame: ConversationDeltaFrame) => void>();
  return {
    publish(frame) {
      for (const listener of listeners) {
        try {
          listener(frame);
        } catch (error) {
          onListenerError(error);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
