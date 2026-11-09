import { z } from 'zod';
import { TaskFileId, TaskId, TaskMessageId } from './ids';
import { SHAPE_FILE_MAX_BYTES, ShapeFileKind } from './shape-files';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §4.3, §6.3, §11. A task's
// thread: the builder's messages with their pasted pictures, the agent's replies and the notices.

const Timestamp = z.iso.datetime();

export const TaskMessageAuthor = { Builder: 'builder', Agent: 'agent', System: 'system' } as const;
export type TaskMessageAuthor = (typeof TaskMessageAuthor)[keyof typeof TaskMessageAuthor];

/** A builder's message, the agent's reply at a turn's end, or a notice (a hand edit, a failed check). */
export const TaskMessageKind = { Message: 'message', Reply: 'reply', Notice: 'notice' } as const;
export type TaskMessageKind = (typeof TaskMessageKind)[keyof typeof TaskMessageKind];

/** The kinds a pasted picture may be, checked by their bytes as a dropped file's are. */
export const TaskPictureKind = z.enum([ShapeFileKind.Png, ShapeFileKind.Jpeg, ShapeFileKind.Webp]);
export type TaskPictureKind = z.infer<typeof TaskPictureKind>;

export const TASK_MESSAGE_MAX_CHARS = 20_000;
/** One picture is held to what one file dropped into a Plan conversation may be. */
export const TASK_PICTURE_MAX_BYTES = SHAPE_FILE_MAX_BYTES;
export const TASK_MESSAGE_PICTURES_MAX = 10;
/** What a message's pictures may weigh together: the daemon reads a message whole before it keeps it. */
export const TASK_MESSAGE_PICTURES_MAX_BYTES = 2 * TASK_PICTURE_MAX_BYTES;

/** A pasted picture. Where the daemon keeps it stays with the daemon; the UI reads it by its id. */
export const TaskFileDto = z.object({
  id: TaskFileId,
  taskId: TaskId,
  messageId: TaskMessageId,
  name: z.string(),
  mediaType: TaskPictureKind,
  size: z.int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Whether the live session's history holds it as an image block. */
  inlineSent: z.boolean(),
  createdAt: Timestamp,
});
export type TaskFileDto = z.infer<typeof TaskFileDto>;

export const TaskMessageDto = z.object({
  /** Its UUID part (after the underscore) is the uuid the message carries to the session. */
  id: TaskMessageId,
  taskId: TaskId,
  author: z.enum(TaskMessageAuthor),
  kind: z.enum(TaskMessageKind),
  body: z.string(),
  createdAt: Timestamp,
  /** When it was handed to the session; null until then. */
  pushedAt: Timestamp.nullable(),
  /** When a turn took it in; a message pushed and not delivered is sent again. */
  deliveredAt: Timestamp.nullable(),
  files: z.array(TaskFileDto),
});
export type TaskMessageDto = z.infer<typeof TaskMessageDto>;

/** A task's thread, oldest first. */
export const TaskThreadDto = z.object({ taskId: TaskId, messages: z.array(TaskMessageDto) });
export type TaskThreadDto = z.infer<typeof TaskThreadDto>;

/** The text part of a builder's message; its pictures travel beside it as `picture` parts. */
export const TaskMessageInput = z.object({ text: z.string().max(TASK_MESSAGE_MAX_CHARS) });
export type TaskMessageInput = z.infer<typeof TaskMessageInput>;
