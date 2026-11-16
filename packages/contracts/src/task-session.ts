import { z } from 'zod';
import { ChatId, ConversationId, PassId, TaskId, WorkstreamId } from './ids';
import { BoardStatus } from './states';

// Sessions UI §14: what a task's tab reads of the task: where it works and what it came from.

/** Where a task works: its own copy, or the one page of a pass of one in Your folder. */
export const TaskSessionPlace = { Copy: 'copy', Pass: 'pass' } as const;
export type TaskSessionPlace = (typeof TaskSessionPlace)[keyof typeof TaskSessionPlace];

export const TaskSessionDto = z.object({
  taskId: TaskId,
  title: z.string(),
  place: z.enum(TaskSessionPlace),
  branch: z.string().nullable(),
  board: z.enum(BoardStatus),
  /** The task's thread, when it has one. */
  conversationId: ConversationId.nullable(),
  /** The title of the chat Do It made the task from, when it did. */
  fromChat: z.object({ chatId: ChatId, title: z.string() }).nullable(),
  passId: PassId.nullable(),
  workstreamId: WorkstreamId.nullable(),
  pullRequest: z.object({ url: z.string(), state: z.string().nullable() }).nullable(),
});
export type TaskSessionDto = z.infer<typeof TaskSessionDto>;
