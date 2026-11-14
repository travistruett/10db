import { z } from 'zod';
import { ConversationDto } from './conversation-dto';
import { ChatId, ConversationId, PassId, ProjectId, TaskId } from './ids';
import { ShapeModelOption } from './shape-view';

// Sessions spec §7.1, §10, §11: a chat (a tab of its own over an attended conversation), what the
// Sessions screen reads about it, and the routes that serve its `@` files and its Start from lines.

type ValueOf<T> = T[keyof T];

const Timestamp = z.iso.datetime();

/** Who named a chat: the agent (its first line, or `set_title`), or the builder, whose name always wins. */
export const ChatTitleSource = { Agent: 'agent', Builder: 'builder' } as const;
export type ChatTitleSource = ValueOf<typeof ChatTitleSource>;

/** Whether a chat reads the checkout (explore) or works in it (hands on, from Do It). */
export const ChatMode = { Explore: 'explore', HandsOn: 'hands_on' } as const;
export type ChatMode = ValueOf<typeof ChatMode>;

/** The name of a chat before the agent or the builder gives it one. */
export const CHAT_DEFAULT_TITLE = 'New session';

/** Most characters of a builder's name for a chat. */
export const CHAT_RENAME_MAX = 120;

export const ChatDto = z.object({
  id: ChatId,
  projectId: ProjectId,
  conversationId: ConversationId,
  /** The conversation as the engine reads it; a tab's state is `conversation.state`. */
  conversation: ConversationDto,
  title: z.string(),
  titleSource: z.enum(ChatTitleSource),
  mode: z.enum(ChatMode),
  /** The task and pass Do It made; null until then. */
  taskId: TaskId.nullable(),
  passId: PassId.nullable(),
  /** The tab's place in the strip; null when it is closed. */
  tabPosition: z.int().nonnegative().nullable(),
  createdAt: Timestamp,
  /** When the builder last sent or the agent last finished a turn; null before the first message. */
  lastActivityAt: Timestamp.nullable(),
  archivedAt: Timestamp.nullable(),
  /** When the agent's latest reply was stored. */
  lastReplyAt: Timestamp.nullable(),
  /** The tasks this chat filed that are not cancelled. */
  tasksFiled: z.int().nonnegative(),
});
export type ChatDto = z.infer<typeof ChatDto>;

/** A new chat; the daemon titles it from its first message. */
export const ChatCreateInput = z.strictObject({
  projectId: ProjectId,
  model: z.string().min(1).nullable(),
  tabPosition: z.int().nonnegative(),
});
export type ChatCreateInput = z.infer<typeof ChatCreateInput>;

export const ChatPatchInput = z
  .strictObject({
    title: z.string().trim().min(1).max(CHAT_RENAME_MAX).optional(),
    tabPosition: z.int().nonnegative().nullable().optional(),
    model: z.string().min(1).nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' });
export type ChatPatchInput = z.infer<typeof ChatPatchInput>;

/**
 * What a Codex session says while its web search stays off: `cached` waits on a live check that it fetches no
 * page the agent names. A lane's thread says it once; a chat's fresh tab says it in place of the web.
 */
export const CODEX_WEB_WAITS =
  'Web search on ChatGPT comes after a live check, so this session searches nothing.';

/** What a chat may run on: the account's models and its default. */
export const ChatModelsDto = z.object({
  default: z.string().nullable(),
  offered: z.array(ShapeModelOption),
  /** Whether the project's agent searches the web (`capabilities.webSearch`), for the fresh tab's words. */
  webSearch: z.boolean(),
});
export type ChatModelsDto = z.infer<typeof ChatModelsDto>;

/** The most file matches one `@` query answers. */
export const PROJECT_FILES_MAX = 50;
/** Most characters of an `@` query. */
export const FILE_QUERY_MAX = 200;

/** A tracked file an `@` query matched, with the index ranges of `path` the query's characters hit. */
export const ProjectFileMatchDto = z.object({
  path: z.string(),
  matches: z.array(z.tuple([z.int().nonnegative(), z.int().nonnegative()])),
});
export type ProjectFileMatchDto = z.infer<typeof ProjectFileMatchDto>;

/** `GET /conversations/:id/files`: the query only; the client never names a folder. */
export const ConversationFilesQuery = z.strictObject({
  q: z.string().max(FILE_QUERY_MAX).default(''),
});
export type ConversationFilesQuery = z.infer<typeof ConversationFilesQuery>;

/** Where a Start from line comes from: a failed task, commits on the base, or the area last changed. */
export const SessionStartKind = {
  FailedTask: 'failed_task',
  BaseCommits: 'base_commits',
  RecentArea: 'recent_area',
} as const;
export type SessionStartKind = ValueOf<typeof SessionStartKind>;

export const SessionStartDto = z.object({ kind: z.enum(SessionStartKind), text: z.string() });
export type SessionStartDto = z.infer<typeof SessionStartDto>;

/** Settings › Sessions. */
export const SessionsSettingsDto = z.object({ notifyReplies: z.boolean() });
export type SessionsSettingsDto = z.infer<typeof SessionsSettingsDto>;
