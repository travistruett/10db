import {
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  type ConversationId,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import { conversationOf, insertConversation } from '@10db/db';
import type { StateStore } from '../events';

/** A task's reporter conversation, made on first use: one per task, a new session for each run. */
export function reporterConversations(state: StateStore): {
  reporterOf(taskId: TaskId, projectId: ProjectId): ConversationId;
} {
  return {
    reporterOf(taskId, projectId) {
      const owner = { kind: ConversationOwnerKind.Reporter, id: taskId };
      const existing = conversationOf(state.db, owner);
      if (existing !== null) return existing.id;
      return state.write(
        (ctx) =>
          insertConversation(ctx, {
            projectId,
            owner,
            profile: ConversationProfile.Explore,
            state: ConversationState.IdleCold,
          }).id,
      );
    },
  };
}
