import { readFileSync, rmSync } from 'node:fs';
import {
  InvalidError,
  NotFoundError,
  TASK_MESSAGE_MAX_CHARS,
  TASK_MESSAGE_PICTURES_MAX,
  TASK_MESSAGE_PICTURES_MAX_BYTES,
  type TaskFileId,
  type TaskId,
  type TaskMessageDto,
  type TaskPictureKind,
  type TaskThreadDto,
} from '@10db/contracts';
import {
  getTask,
  getTaskFile,
  insertBuilderMessage,
  listTaskThread,
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

/** The thread's routes, named as the HTTP API's services name them. */
export interface ThreadService {
  /** A task's thread, oldest first; throws NotFoundError for an unknown task. */
  taskThread(taskId: TaskId): TaskThreadDto;
  /**
   * Keeps the builder's message and its pictures. Throws NotFoundError for an unknown task and
   * InvalidError, naming what is refused, for a message with neither words nor a picture or for a
   * file that is no PNG, JPEG or WebP by its bytes; nothing is kept then.
   */
  postTaskMessage(
    taskId: TaskId,
    input: { readonly text: string; readonly pictures: readonly PastedFile[] },
  ): TaskMessageDto;
  /** A pasted picture's bytes; throws NotFoundError for one that is not this task's. */
  taskPicture(
    taskId: TaskId,
    fileId: TaskFileId,
  ): { readonly bytes: Uint8Array; readonly mediaType: TaskPictureKind };
}

export function createThreadService(deps: {
  readonly state: StateStore;
  /** The daemon's data directory; a task's pictures go under `tasks/<task id>/files/` in it. */
  readonly dataDir: string;
}): ThreadService {
  const { state } = deps;
  return {
    taskThread(taskId) {
      getTask(state.db, taskId);
      return { taskId, messages: listTaskThread(state.db, taskId) };
    },

    postTaskMessage(taskId, input) {
      getTask(state.db, taskId);
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
        return state.write((ctx) => insertBuilderMessage(ctx, taskId, { body, files }));
      } catch (error) {
        // No row names what this call wrote; a picture kept before for the task stays.
        for (const picture of kept)
          if (picture.written) rmSync(picture.storedPath, { force: true });
        throw error;
      }
    },

    taskPicture(taskId, fileId) {
      const row = getTaskFile(state.db, fileId);
      if (row.taskId !== taskId) throw new NotFoundError('task file', fileId);
      return { bytes: readFileSync(row.storedPath), mediaType: row.mediaType };
    },
  };
}
