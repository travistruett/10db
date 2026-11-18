import { ConversationState, type TaskId } from '@10db/contracts';
import { getTask, latestWorkstreamOf, chatsHandedToCopies, storeHandedTo } from '@10db/db';
import type { ExploreEngine } from '../conversation';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import type { ChatService } from './service';

export interface FinishSealsDeps {
  readonly state: StateStore;
  readonly engine: Pick<ExploreEngine, 'view'>;
  readonly chat: Pick<ChatService, 'seal'>;
  readonly tasks: { readonly start: (taskId: TaskId) => unknown };
  readonly logger: Logger;
}

/**
 * After recovery: a chat Do It linked to a task in a separate copy but did not finish with (the daemon stopped
 * between its steps) is sealed, its task started when it has no run, and its notice and closed tab stored. A start
 * that is refused shows as the task's Board state; the chat is sealed either way.
 */
export async function finishSeals(deps: FinishSealsDeps): Promise<void> {
  for (const chat of chatsHandedToCopies(deps.state.db)) {
    if (chat.taskId === null) continue;
    const taskId = chat.taskId;
    try {
      const sealed = deps.engine.view(chat.conversationId).state === ConversationState.Sealed;
      // A Do It that finished (sealed, tab closed, task run) has nothing left to do at start-up.
      if (
        sealed &&
        chat.tabPosition === null &&
        latestWorkstreamOf(deps.state.db, taskId) !== undefined
      )
        continue;
      if (!sealed) await deps.chat.seal(chat.id);
      if (latestWorkstreamOf(deps.state.db, taskId) === undefined) {
        try {
          deps.tasks.start(taskId);
        } catch (error) {
          deps.logger.warn(
            {
              chatId: chat.id,
              taskId,
              err: error instanceof Error ? error.message : String(error),
            },
            'the task of a chat Do It handed over could not start',
          );
        }
      }
      const task = getTask(deps.state.db, taskId);
      deps.state.write((ctx) => {
        storeHandedTo(
          ctx,
          chat.id,
          { kind: 'handed_to', taskId, title: task.title, place: 'worktree' },
          true,
        );
      });
    } catch (error) {
      deps.logger.warn(
        { chatId: chat.id, err: error instanceof Error ? error.message : String(error) },
        'a chat Do It handed over could not be sealed',
      );
    }
  }
}
