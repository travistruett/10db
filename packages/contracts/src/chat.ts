import { z } from 'zod';
import { ConversationDto } from './conversation-dto';
import { BRIEF_LIST_MAX } from './chat-tools';
import { PassWhenBusy } from './folder-hold';
import { ChatId, ConversationId, PassId, ProjectId, TaskId } from './ids';
import { TASK_MESSAGE_MAX_CHARS } from './task-thread';
import { Title } from './entities';
import { ShapeModelOption } from './shape-view';
import { Effort } from './states';
import { ChatWork } from './chat-work';
import { TerminalApp, TerminalAppSchema } from './takeover';

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
  /** Where the session works; null while it is only reading. */
  work: ChatWork.nullable(),
});
export type ChatDto = z.infer<typeof ChatDto>;

/** A new chat; the daemon titles it from its first message. */
export const ChatCreateInput = z.strictObject({
  projectId: ProjectId,
  model: z.string().min(1).nullable(),
  effort: z.enum(Effort).nullable().optional(),
  tabPosition: z.int().nonnegative(),
});
export type ChatCreateInput = z.infer<typeof ChatCreateInput>;

export const ChatPatchInput = z
  .strictObject({
    title: z.string().trim().min(1).max(CHAT_RENAME_MAX).optional(),
    tabPosition: z.int().nonnegative().nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    effort: z.enum(Effort).nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' });
export type ChatPatchInput = z.infer<typeof ChatPatchInput>;

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
export const SessionsSettingsDto = z.object({
  notifyReplies: z.boolean(),
  /** A value that is not one of the three choices reads as Terminal. */
  terminalApp: TerminalAppSchema.catch(TerminalApp.Terminal),
});
export type SessionsSettingsDto = z.infer<typeof SessionsSettingsDto>;

/** Settings › Sessions as a change: only the fields given are set. */
export const SessionsSettingsPatch = z.strictObject({
  notifyReplies: z.boolean().optional(),
  terminalApp: TerminalAppSchema.optional(),
});
export type SessionsSettingsPatch = z.infer<typeof SessionsSettingsPatch>;

// Sessions spec §7.3 (Do it): the sheet's request, its preview, and the brief.

/** Where Do It puts the work: a task in its own copy, or a pass of one in Your folder. */
export const DoItPlace = { Worktree: 'worktree', Here: 'here' } as const;
export type DoItPlace = ValueOf<typeof DoItPlace>;

/** `POST /chats/:chatId/do-it`. */
export const DoItRequest = z.strictObject({
  place: z.enum(DoItPlace),
  title: Title,
  brief: z.string().trim().min(1).max(TASK_MESSAGE_MAX_CHARS),
  areas: z.array(z.string().min(1).max(100)).max(BRIEF_LIST_MAX).optional(),
  acceptanceCriteria: z.array(z.string().min(1).max(1000)).max(BRIEF_LIST_MAX).optional(),
  /** Only for `here`, when chats' turns are the only holders: stop them, or open once they end. */
  whenBusy: z.enum(PassWhenBusy).optional(),
});
export type DoItRequest = z.infer<typeof DoItRequest>;

/** What Do It made. `pending` is an open waiting for chats' turns to end; it has no task yet. */
export const DoItResult = z.union([
  z.object({ taskId: TaskId, place: z.enum(DoItPlace) }),
  z.object({ pending: z.literal(true) }),
]);
export type DoItResult = z.infer<typeof DoItResult>;

/** `POST /chats/:chatId/brief`: asks the agent for a brief, with what the builder wants in it. */
export const BriefRequest = z.strictObject({ draft: z.string().max(2000).optional() });
export type BriefRequest = z.infer<typeof BriefRequest>;

/** Where the brief came from: the chat's agent, or the chat read back by 10db. */
export const BriefSource = { Agent: 'agent', Chat: 'chat' } as const;
export type BriefSource = ValueOf<typeof BriefSource>;

/** Why the brief is the chat read back rather than the agent's. */
export const BriefReason = { MidTurn: 'mid_turn', Paused: 'paused', Timeout: 'timeout' } as const;
export type BriefReason = ValueOf<typeof BriefReason>;

export const DoItBriefDto = z.object({
  title: z.string(),
  text: z.string(),
  areas: z.array(z.string()),
  criteria: z.array(z.string()),
  source: z.enum(BriefSource).nullable(),
  reason: z.enum(BriefReason).nullable(),
  /** The agent is still writing it. */
  writing: z.boolean(),
});
export type DoItBriefDto = z.infer<typeof DoItBriefDto>;

/** The most uncommitted files the sheet lists. */
export const DO_IT_CHANGED_MAX = 200;

export const ChangedEntryStatus = {
  Modified: 'M',
  Added: 'A',
  Deleted: 'D',
  Renamed: 'R',
  Untracked: '?',
} as const;
export type ChangedEntryStatus = ValueOf<typeof ChangedEntryStatus>;

export const ChangedEntryDto = z.object({
  path: z.string(),
  status: z.enum(ChangedEntryStatus),
});
export type ChangedEntryDto = z.infer<typeof ChangedEntryDto>;

/** Why a place is not offered, and where the builder goes about it. */
export const DoItRefusalDto = z.object({
  code: z.string(),
  message: z.string(),
  link: z.string().nullable(),
});
export type DoItRefusalDto = z.infer<typeof DoItRefusalDto>;

export const DoItOfferDto = z.object({
  offered: z.boolean(),
  refusal: DoItRefusalDto.nullable(),
  /** Offered when every keeping-out holder is a chat's turn. */
  whenBusy: z.boolean(),
});
export type DoItOfferDto = z.infer<typeof DoItOfferDto>;

/** `GET /chats/:chatId/do-it`: everything the sheet shows before Do It. */
export const DoItPreviewDto = z.object({
  brief: DoItBriefDto,
  changed: z.array(ChangedEntryDto).max(DO_IT_CHANGED_MAX),
  more: z.int().nonnegative(),
  worktree: DoItOfferDto,
  here: DoItOfferDto,
  runningTurn: z.boolean(),
  /** The closed pass a pass of one would stack on. */
  stacksOn: z.string().nullable(),
  /** The branch a separate copy starts from. */
  base: z.string().nullable(),
  /** The commits HEAD has that the base lacks, which stay out of a copy. */
  leftOut: z.object({ branch: z.string(), count: z.int().nonnegative() }).nullable(),
});
export type DoItPreviewDto = z.infer<typeof DoItPreviewDto>;
