import {
  ConflictError,
  PassState,
  TakeOutStep,
  TASK_MESSAGE_MAX_CHARS,
  TASK_MESSAGE_PICTURES_MAX,
  TASK_MESSAGE_PICTURES_MAX_BYTES,
  type TaskId,
  type TaskMessageDto,
  type TaskMessageId,
  type TaskDto,
} from '@10db/contracts';
import {
  clearPassTurnAnswered,
  deleteUnsentBuilderMessage,
  getTask,
  insertBuilderMessage,
  lastTakeOut,
  latestPassTurn,
  markPassTurnAnswered,
  passHoldingTask,
  type DbReader,
} from '@10db/db';
import type { StateStore } from '../events';
import { keepBuilderMessage, removeKeptFiles, type PastedFile } from './intake';
import { taskFilesDir } from './task-files';

// Workbench spec §4.3, §11, §12, sessions spec §6.1. The builder's side of a task's conversation: the
// library's intake keeps a message and its pictures; the pass's refusals and the Ready-turn mark are
// the task's, and the runner, injected, hands the message to the page's session.

/** How a message reaches a task's page in a Workbench pass: the runner's, injected. */
export interface PageMessages {
  /** Hands the message to the page's session, or queues the page to start a turn with it. */
  deliver(
    taskId: TaskId,
    messageId: TaskMessageId,
    opts: { readonly redo: boolean },
  ): Promise<void>;
}

/** How the builder writes to a task's conversation, named as the HTTP API's services name it. */
export interface TaskThread {
  /**
   * Keeps the builder's message and its pictures. Throws NotFoundError for an unknown task and
   * InvalidError, naming what is refused, for a message with neither words nor a picture or for a
   * file that is no PNG, JPEG or WebP by its bytes; nothing is kept then. A message to a page of a
   * Workbench pass goes to its agent at once; it is refused (ConflictError) while the pass is not
   * open or the page is being taken out. `redo` stops the page's running turn first, and is refused
   * for a task in no pass.
   */
  postTaskMessage(
    taskId: TaskId,
    input: { readonly text: string; readonly pictures: readonly PastedFile[] },
    opts?: { readonly redo?: boolean },
  ): Promise<TaskMessageDto>;
}

/**
 * Refuses (ConflictError) a message to a page of a pass while the pass is not open or the page is
 * being taken out of it.
 */
function refusedByPass(db: DbReader, task: TaskDto): void {
  const pass = passHoldingTask(db, getTask(db, task.id));
  if (!pass) throw new ConflictError(`${task.title} is no longer in a UI Workbench pass`);
  if (pass.state !== PassState.Open)
    throw new ConflictError(
      `UI Workbench pass "${pass.name}" is ${pass.state.toLowerCase()}; its pages take no message`,
    );
  const takeOut = lastTakeOut(db, task.id);
  if (takeOut?.passId === pass.id && takeOut.step < TakeOutStep.Done)
    throw new ConflictError(`${task.title} is being taken out of its pass`);
}

export function createTaskThread(deps: {
  readonly state: StateStore;
  /** The daemon's data directory; a task's pictures go under `tasks/<task id>/files/` in it. */
  readonly dataDir: string;
  readonly pages: PageMessages;
}): TaskThread {
  const { state } = deps;
  return {
    async postTaskMessage(taskId, input, opts = {}) {
      const task = getTask(state.db, taskId);
      const redo = opts.redo === true;
      // A page of a pass takes the message into its turns (Workbench spec §6.3), while the pass is
      // open and the page is not being taken out; nothing is kept for one refused.
      const pass = passHoldingTask(state.db, task);
      if (pass) refusedByPass(state.db, task);
      else if (redo) throw new ConflictError(`${task.title} is in no UI Workbench pass to redo`);
      const { message, answered } = keepBuilderMessage(input, {
        limits: {
          maxChars: TASK_MESSAGE_MAX_CHARS,
          maxPictures: TASK_MESSAGE_PICTURES_MAX,
          maxPicturesBytes: TASK_MESSAGE_PICTURES_MAX_BYTES,
        },
        filesDir: taskFilesDir(deps.dataDir, taskId),
        write: (body, files) =>
          state.write((ctx) => {
            // Read again where the message is written, so a take-out or an Abandon that began
            // meanwhile refuses it too.
            if (pass) refusedByPass(ctx.tx, task);
            // The builder's first word after a Ready page is when the page was answered.
            const latest = pass ? latestPassTurn(ctx.tx, taskId) : undefined;
            const answers =
              latest !== undefined && latest.readyAt !== null && latest.answeredAt === null;
            if (answers) markPassTurnAnswered(ctx, latest.id);
            return {
              message: insertBuilderMessage(ctx, taskId, { body, files }),
              answered: answers ? latest.id : null,
            };
          }),
      });
      if (!pass) return message;
      try {
        await deps.pages.deliver(taskId, message.id, { redo });
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        // The page left its pass, or began leaving it, as the message went in: it keeps nothing of
        // it, as for one refused up front, so a retry is one message. One a session was handed
        // already reached the page.
        const removed = state.write((ctx) => {
          const paths = deleteUnsentBuilderMessage(ctx, taskId, message.id);
          // Nor did it answer the page.
          if (paths !== null && answered !== null) clearPassTurnAnswered(ctx, answered);
          return paths;
        });
        if (removed === null) return message;
        removeKeptFiles(removed);
        throw error;
      }
      return message;
    },
  };
}
