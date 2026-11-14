import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHAT_DEFAULT_TITLE,
  CHATS_UNAVAILABLE_ON_CHATGPT,
  ChatTitleSource,
  ConflictError,
  ConversationItemAuthor,
  ConversationItemKind,
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  cutTitle,
  InvalidError,
  mintId,
  TASK_MESSAGE_MAX_CHARS,
  TASK_MESSAGE_PICTURES_MAX,
  TASK_MESSAGE_PICTURES_MAX_BYTES,
  type ChatCreateInput,
  type ChatDto,
  type ChatId,
  type ChatModelsDto,
  type ChatPatchInput,
  type ConversationId,
  type ProjectId,
  type ShapeModelOption,
} from '@10db/contracts';
import {
  archiveChat,
  chatOfConversation,
  chatView,
  getChat,
  getConversation,
  getProject,
  hasItemOfKind,
  insertChat,
  insertConversation,
  insertFiles,
  insertItem,
  moveChatTab,
  openChats,
  patchConversation,
  recentChats,
  setChatTitle,
  touchChat,
  unarchiveChat,
  type ConversationItemRow,
} from '@10db/db';
import { keepBuilderMessage, type ExploreEngine, type PastedFile } from '../conversation';
import type { StateStore } from '../events';
import { chatFolder } from './hooks';

// Sessions spec §7.1, §10: a chat's life on the daemon. It is made with its conversation on the
// project's account, named from its first message, moved in the strip, and given a model between
// turns. The engine runs its session; this keeps the chat's own row.

/** Most characters of the title a chat's first message gives it. */
const FIRST_LINE_TITLE_MAX = 40;

/** What a message to an archived chat is refused with. */
export const CHAT_ARCHIVED = 'This session is archived.';
/** What a model change while a turn runs is refused with. */
export const CHANGE_MODEL_BETWEEN_TURNS = 'Change the model between turns.';
/** What a model the account doesn't offer is refused with. */
export const MODEL_NOT_OFFERED = 'Not available on this account';

const BUSY: ReadonlySet<ConversationState> = new Set([
  ConversationState.Starting,
  ConversationState.Running,
  ConversationState.WaitingCard,
  ConversationState.Stopping,
]);

/** The title a chat's first message gives it: its first line cut at a word, or the default for a picture alone. */
export function firstMessageTitle(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  const title = cutTitle(line, FIRST_LINE_TITLE_MAX);
  return title === '' ? CHAT_DEFAULT_TITLE : title;
}

export interface ChatMessageInput {
  readonly text: string;
  readonly mentions: readonly string[];
  readonly pictures: readonly PastedFile[];
}

export interface ChatService {
  create(input: ChatCreateInput): ChatDto;
  get(id: ChatId): ChatDto;
  open(): ChatDto[];
  recent(projectId: ProjectId, limit?: number): ChatDto[];
  patch(id: ChatId, input: ChatPatchInput): Promise<ChatDto>;
  models(projectId: ProjectId): ChatModelsDto;
  archive(id: ChatId): Promise<ChatDto>;
  unarchive(id: ChatId): ChatDto;
  /** The chat branch of the message route: the message stored queued, the chat touched, a turn asked for. */
  send(conversationId: ConversationId, input: ChatMessageInput): ConversationItemRow;
  /** The message stored queued and the chat touched, with no turn asked for: what a Redo posts. */
  post(conversationId: ConversationId, input: ChatMessageInput): ConversationItemRow;
}

export interface ChatServiceDeps {
  readonly state: StateStore;
  readonly engine: ExploreEngine;
  readonly dataDir: string;
  readonly now: () => Date;
  /** The models a project's account offers for a conversation, and its default. */
  modelsOf(projectId: ProjectId): { default: string | null; offered: readonly ShapeModelOption[] };
  /** Why the project's account runs no chat yet, or null when it runs them. */
  unavailable(projectId: ProjectId): string | null;
}

/** Why a project whose account is a ChatGPT plan runs no chat yet, from its provider. */
export function chatsUnavailable(onCodex: boolean): string | null {
  return onCodex ? CHATS_UNAVAILABLE_ON_CHATGPT : null;
}

export function createChatService(deps: ChatServiceDeps): ChatService {
  const { state, engine } = deps;
  const dtoOf = (id: ChatId): ChatDto => {
    const view = chatView(state.db, id);
    return { ...view, conversation: engine.view(view.conversationId) };
  };

  const refuseUnavailable = (projectId: ProjectId): void => {
    const why = deps.unavailable(projectId);
    if (why !== null) throw new ConflictError(why);
  };

  const offered = (projectId: ProjectId, model: string): void => {
    if (!deps.modelsOf(projectId).offered.some((m) => m.model === model))
      throw new InvalidError(MODEL_NOT_OFFERED);
  };

  return {
    create(input) {
      getProject(state.db, input.projectId);
      refuseUnavailable(input.projectId);
      if (input.model !== null) offered(input.projectId, input.model);
      const id = state.write((ctx) => {
        const chatId = mintId('Chat');
        const conv = insertConversation(ctx, {
          projectId: input.projectId,
          owner: { kind: ConversationOwnerKind.Chat, id: chatId },
          profile: ConversationProfile.Explore,
          state: ConversationState.IdleCold,
        });
        if (input.model !== null) patchConversation(ctx, conv.id, { model: input.model });
        return insertChat(ctx, {
          id: chatId,
          projectId: input.projectId,
          conversationId: conv.id,
          title: CHAT_DEFAULT_TITLE,
          tabPosition: input.tabPosition,
        }).id;
      });
      return dtoOf(id);
    },

    get: dtoOf,

    open: () => openChats(state.db).map((row) => dtoOf(row.id)),

    recent: (projectId, limit = 6) =>
      recentChats(state.db, projectId, limit).map((row) => dtoOf(row.id)),

    async patch(id, input) {
      const chat = getChat(state.db, id);
      if (input.model !== undefined) {
        const conv = getConversation(state.db, chat.conversationId);
        if (conv.state !== null && BUSY.has(conv.state))
          throw new ConflictError(CHANGE_MODEL_BETWEEN_TURNS);
        if (input.model !== null) offered(chat.projectId, input.model);
        if (input.model !== conv.model) await engine.modelChanged(chat.conversationId, input.model);
      }
      state.write((ctx) => {
        if (input.title !== undefined) setChatTitle(ctx, id, input.title, ChatTitleSource.Builder);
        if (input.tabPosition !== undefined) moveChatTab(ctx, id, input.tabPosition);
      });
      return dtoOf(id);
    },

    models(projectId) {
      const why = deps.unavailable(projectId);
      if (why !== null) return { default: null, offered: [], unavailable: why };
      const models = deps.modelsOf(projectId);
      return { default: models.default, offered: [...models.offered], unavailable: null };
    },

    async archive(id) {
      const chat = getChat(state.db, id);
      if (chat.archivedAt !== null) return dtoOf(id);
      // The session ends first (a start cancelled, a turn stopped, a card withdrawn), so nothing it
      // does lands after the chat is archived; then the folder made only from its id goes.
      await engine.retire(chat.conversationId);
      state.write((ctx) => {
        archiveChat(ctx, id, ctx.now);
      });
      rmSync(chatFolder(deps.dataDir, chat.conversationId), { recursive: true, force: true });
      return dtoOf(id);
    },

    unarchive(id) {
      state.write((ctx) => {
        unarchiveChat(ctx, id);
      });
      engine.unretire(getChat(state.db, id).conversationId);
      return dtoOf(id);
    },

    send(conversationId, input) {
      const item = post(conversationId, input);
      engine.queued(conversationId);
      return item;
    },

    post: (conversationId, input) => post(conversationId, input),
  };

  function post(conversationId: ConversationId, input: ChatMessageInput): ConversationItemRow {
    const conv = getConversation(state.db, conversationId);
    const chat = chatOfConversation(state.db, conversationId);
    if (chat === null) throw new ConflictError('This conversation is no chat’s');
    if (chat.archivedAt !== null) throw new ConflictError(CHAT_ARCHIVED);
    refuseUnavailable(conv.projectId);
    return keepBuilderMessage(input, {
      limits: {
        maxChars: TASK_MESSAGE_MAX_CHARS,
        maxPictures: TASK_MESSAGE_PICTURES_MAX,
        maxPicturesBytes: TASK_MESSAGE_PICTURES_MAX_BYTES,
      },
      filesDir: join(chatFolder(deps.dataDir, conversationId), 'pictures'),
      write: (body, files) =>
        state.write((ctx) => {
          const first = !hasItemOfKind(ctx.tx, conversationId, ConversationItemKind.Message);
          const row = insertItem(ctx, conversationId, {
            author: ConversationItemAuthor.Builder,
            kind: ConversationItemKind.Message,
            body:
              input.mentions.length === 0
                ? { text: body }
                : { text: body, mentions: [...input.mentions] },
          });
          insertFiles(ctx, conversationId, row.id, files);
          if (first) setChatTitle(ctx, chat.id, firstMessageTitle(body), ChatTitleSource.Agent);
          touchChat(ctx, chat.id, ctx.now);
          return row;
        }),
    });
  }
}
