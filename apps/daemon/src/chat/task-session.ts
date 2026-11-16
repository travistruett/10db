import {
  CHAT_DEFAULT_TITLE,
  TaskSessionPlace,
  type PassId,
  type TaskId,
  type TaskSessionDto,
} from '@10db/contracts';
import {
  chatThatMadeTask,
  getBatch,
  getPass,
  getTask,
  latestWorkstreamOf,
  taskConversationOf,
  type DbReader,
} from '@10db/db';

// Sessions UI §14: what a task's tab reads of the task: where it works and what it came from.

/**
 * The task's place (the one page of a pass of one in Your folder, or its own copy), its branch, its Board state,
 * its thread, the chat Do It made it from (read from the chat's filed tasks, so a later Do It from the same chat
 * doesn't lose it), and its pull request.
 */
export function taskSession(db: DbReader, taskId: TaskId): TaskSessionDto {
  const task = getTask(db, taskId);
  const run = latestWorkstreamOf(db, taskId);
  const passId: PassId | null = task.passId ?? null;
  const pass = passId === null ? null : getPass(db, passId);
  const batchId = pass?.batchId ?? run?.batchId ?? null;
  const batch = batchId === null ? null : getBatch(db, batchId);
  const chat = chatThatMadeTask(db, taskId);
  return {
    taskId,
    title: task.title,
    place: pass === null ? TaskSessionPlace.Copy : TaskSessionPlace.Pass,
    branch: batch?.branch ?? null,
    board: task.boardStatus,
    conversationId: taskConversationOf(db, taskId)?.id ?? null,
    fromChat:
      chat === undefined ? null : { chatId: chat.id, title: chat.title ?? CHAT_DEFAULT_TITLE },
    passId,
    workstreamId: run?.id ?? null,
    pullRequest: batch?.prUrl == null ? null : { url: batch.prUrl, state: batch.pr?.state ?? null },
  };
}
