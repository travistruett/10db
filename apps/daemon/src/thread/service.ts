import { readFileSync, rmSync } from 'node:fs';
import {
  ConflictError,
  InvalidError,
  NotFoundError,
  PassState,
  TakeOutStep,
  TASK_MESSAGE_MAX_CHARS,
  TASK_MESSAGE_PICTURES_MAX,
  TASK_MESSAGE_PICTURES_MAX_BYTES,
  type TaskFileId,
  type TaskId,
  type TaskMessageDto,
  type TaskMessageId,
  type TaskPictureKind,
  type PassTurnId,
  type TaskDto,
  type TaskThreadDto,
} from '@10db/contracts';
import {
  clearPassTurnAnswered,
  deleteUnsentBuilderMessage,
  getTask,
  getTaskFile,
  insertBuilderMessage,
  lastTakeOut,
  latestPassTurn,
  listTaskThread,
  markPassTurnAnswered,
  passHoldingTask,
  type DbReader,
  type StoredPicture,
} from '@10db/db';
import type { StateStore } from '../events';
import { checkPicture, keepPicture, taskFilesDir, type KeptPicture } from './pictures';

// Workbench spec §4.3, §11, §12. The builder's side of a task's thread: what a message may carry, and
// the order its parts are kept in: every picture on disk first, then the rows in one write.

const MIB = 1024 * 1024;

/** A file as the builder pasted it: the name and bytes the request carried. */
export interface PastedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** How a message reaches a task's page in a Workbench pass: the runner's, injected. */
export interface PageMessages {
  /** Hands the message to the page's session, or queues the page to start a turn with it. */
  deliver(
    taskId: TaskId,
    messageId: TaskMessageId,
    opts: { readonly redo: boolean },
  ): Promise<void>;
}

/** The thread's routes, named as the HTTP API's services name them. */
export interface ThreadService {
  /** A task's thread, oldest first; throws NotFoundError for an unknown task. */
  taskThread(taskId: TaskId): TaskThreadDto;
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
  /** A pasted picture's bytes; throws NotFoundError for one that is not this task's. */
  taskPicture(
    taskId: TaskId,
    fileId: TaskFileId,
  ): { readonly bytes: Uint8Array<ArrayBuffer>; readonly mediaType: TaskPictureKind };
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

const isMissingFile = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export function createThreadService(deps: {
  readonly state: StateStore;
  /** The daemon's data directory; a task's pictures go under `tasks/<task id>/files/` in it. */
  readonly dataDir: string;
  readonly pages: PageMessages;
}): ThreadService {
  const { state } = deps;
  return {
    taskThread(taskId) {
      getTask(state.db, taskId);
      return { taskId, messages: listTaskThread(state.db, taskId) };
    },

    async postTaskMessage(taskId, input, opts = {}) {
      const task = getTask(state.db, taskId);
      const redo = opts.redo === true;
      // A page of a pass takes the message into its turns (Workbench spec §6.3), while the pass is
      // open and the page is not being taken out; nothing is kept for one refused.
      const pass = passHoldingTask(state.db, task);
      if (pass) refusedByPass(state.db, task);
      else if (redo) throw new ConflictError(`${task.title} is in no UI Workbench pass to redo`);
      const body = input.text.trim();
      if (body === '' && input.pictures.length === 0)
        throw new InvalidError('A message needs words or a picture');
      if (body.length > TASK_MESSAGE_MAX_CHARS)
        throw new InvalidError(`A message is at most ${String(TASK_MESSAGE_MAX_CHARS)} characters`);
      if (input.pictures.length > TASK_MESSAGE_PICTURES_MAX)
        throw new InvalidError(
          `A message carries at most ${String(TASK_MESSAGE_PICTURES_MAX)} pictures`,
        );
      if (
        input.pictures.reduce((sum, p) => sum + p.bytes.length, 0) > TASK_MESSAGE_PICTURES_MAX_BYTES
      )
        throw new InvalidError(
          `A message's pictures are at most ${String(TASK_MESSAGE_PICTURES_MAX_BYTES / MIB)} MB together`,
        );
      const pictures = input.pictures.map(checkPicture);
      const dir = taskFilesDir(deps.dataDir, taskId);
      const kept: KeptPicture[] = [];
      let message: TaskMessageDto;
      /** The Ready turn this message was the first answer to, if any. */
      let answered: PassTurnId | null;
      try {
        const files: StoredPicture[] = [];
        for (const picture of pictures) {
          const at = keepPicture(dir, picture);
          kept.push(at);
          files.push({
            name: picture.name,
            mediaType: picture.mediaType,
            size: picture.bytes.length,
            sha256: at.sha256,
            storedPath: at.storedPath,
          });
        }
        ({ message, answered } = state.write((ctx) => {
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
        }));
      } catch (error) {
        // No row names what this call wrote; a picture kept before for the task stays.
        for (const picture of kept)
          if (picture.written) rmSync(picture.storedPath, { force: true });
        throw error;
      }
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
        for (const path of removed) rmSync(path, { force: true });
        throw error;
      }
      return message;
    },

    taskPicture(taskId, fileId) {
      const row = getTaskFile(state.db, fileId);
      if (row.taskId !== taskId) throw new NotFoundError('task file', fileId);
      try {
        return { bytes: readFileSync(row.storedPath), mediaType: row.mediaType };
      } catch (error) {
        // A picture removed from the data directory by hand is gone, not a fault of the daemon.
        if (isMissingFile(error)) throw new NotFoundError('task file', fileId);
        throw error;
      }
    },
  };
}
