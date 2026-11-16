import type { ConversationId, ConversationLiveDto } from '@10db/contracts';
import type { LiveBuffers } from './live-buffers';

// Sessions spec §6.5: what a conversation whose live session the runner owns (a task's) streams now,
// for `GET /conversations/:id/live`. The explore engine serves its own conversations.

export interface LiveRegistry {
  /** Serves `buffers` as the conversation's items in flight until the answer is called. */
  serve(conversationId: ConversationId, buffers: LiveBuffers): () => void;
  /** What the conversation streams now; nothing when no session streams into it. */
  live(conversationId: ConversationId): ConversationLiveDto;
}

export function createLiveRegistry(): LiveRegistry {
  const served = new Map<ConversationId, LiveBuffers>();
  return {
    serve(conversationId, buffers) {
      served.set(conversationId, buffers);
      return () => {
        // A later session of the same conversation may already serve its own.
        if (served.get(conversationId) === buffers) served.delete(conversationId);
      };
    },
    live: (conversationId) => ({
      conversationId,
      items: served.get(conversationId)?.snapshot() ?? [],
      waitingForFolder: false,
    }),
  };
}
