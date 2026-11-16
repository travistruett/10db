import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHAT_DEFAULT_TITLE,
  ChatTitleSource,
  ConflictError,
  ConversationItemAuthor,
  ConversationItemKind,
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  cutTitle,
  FolderAsker,
  FolderWhileHeld,
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
  type ChatRow,
  type ConversationItemRow,
} from '@10db/db';
import { keepBuilderMessage, type ExploreEngine, type PastedFile } from '../conversation';
import type { StateStore } from '../events';
import type { FolderHold, ServeResult } from '../folder-hold';
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
  /**
   * The chat branch of the message route: the message stored queued, the chat touched, a turn asked for.
   * With `wait`, a turn Your folder keeps out waits for it to free, ahead of any task that hasn't started;
   * the latest send's choice applies to everything queued.
   */
  send(
    conversationId: ConversationId,
    input: ChatMessageInput,
    folder?: FolderWhileHeld,
  ): ConversationItemRow;
  /** Stops the turn, or drops what waits for Your folder. */
  stop(conversationId: ConversationId): Promise<void>;
  /** Runs what waits for Your folder now, reading only. Refused with the engine's words when nothing waits. */
  sendNow(conversationId: ConversationId): void;
  /** Stops waiting for Your folder: the queue runs reading only. */
  stopWaiting(chatId: ChatId): void;
  /** Stop, then the edited message as the next turn, with its own choice for a folder in use. */
  redo(
    conversationId: ConversationId,
    input: ChatMessageInput,
    folder?: FolderWhileHeld,
  ): Promise<ConversationItemRow>;
  /** The message stored queued and the chat touched, with no turn asked for: what a Redo posts. */
  post(conversationId: ConversationId, input: ChatMessageInput): ConversationItemRow;
}

export interface ChatServiceDeps {
  readonly state: StateStore;
  readonly engine: ExploreEngine;
  readonly folderHold: FolderHold;
  readonly dataDir: string;
  readonly now: () => Date;
  /** The models a project's account offers for a conversation, and its default. */
  modelsOf(projectId: ProjectId): { default: string | null; offered: readonly ShapeModelOption[] };
  /** Whether the agent of the project's account searches the web (`capabilities.webSearch`). */
  webSearchOf(projectId: ProjectId): boolean;
}

export function createChatService(deps: ChatServiceDeps): ChatService {
  const { state, engine } = deps;
  const dtoOf = (id: ChatId): ChatDto => {
    const view = chatView(state.db, id);
    return { ...view, conversation: engine.view(view.conversationId) };
  };

  const offered = (projectId: ProjectId, model: string): void => {
    if (!deps.modelsOf(projectId).offered.some((m) => m.model === model))
      throw new InvalidError(MODEL_NOT_OFFERED);
  };

  return {
    create(input) {
      getProject(state.db, input.projectId);
      if (input.model !== null) offered(input.projectId, input.model);
      const id = state.write((ctx) => {
        const chatId = mintId('Chat');
        const conv = insertConversation(ctx, {
          projectId: input.projectId,
          owner: { kind: ConversationOwnerKind.Chat, id: chatId },
          profile: ConversationProfile.Explore,
          state: ConversationState.IdleCold,
        });
        const effort = input.effort ?? null;
        if (input.model !== null || effort !== null)
          patchConversation(ctx, conv.id, { model: input.model, effort });
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
      if (input.model !== undefined || input.effort !== undefined) {
        const conv = getConversation(state.db, chat.conversationId);
        if (conv.state !== null && BUSY.has(conv.state))
          throw new ConflictError(CHANGE_MODEL_BETWEEN_TURNS);
        if (input.model !== undefined && input.model !== null) offered(chat.projectId, input.model);
        const model = input.model === undefined ? conv.model : input.model;
        const effort = input.effort === undefined ? conv.effort : input.effort;
        if (model !== conv.model || effort !== conv.effort) {
          // The effort is stored first, so the engine's launch for the next turn reads it; a switch
          // the engine refuses puts the old effort back with the old model.
          if (effort !== conv.effort)
            state.write((ctx) => {
              patchConversation(ctx, chat.conversationId, { effort });
            });
          try {
            await engine.modelChanged(chat.conversationId, model);
          } catch (error) {
            state.write((ctx) => {
              patchConversation(ctx, chat.conversationId, { effort: conv.effort });
            });
            throw error;
          }
        }
      }
      state.write((ctx) => {
        if (input.title !== undefined) setChatTitle(ctx, id, input.title, ChatTitleSource.Builder);
        if (input.tabPosition !== undefined) moveChatTab(ctx, id, input.tabPosition);
      });
      return dtoOf(id);
    },

    models(projectId) {
      const models = deps.modelsOf(projectId);
      return {
        default: models.default,
        offered: [...models.offered],
        webSearch: deps.webSearchOf(projectId),
      };
    },

    async archive(id) {
      const chat = getChat(state.db, id);
      if (chat.archivedAt !== null) return dtoOf(id);
      // The session ends first (a start cancelled, a turn stopped, a card withdrawn), so nothing it
      // does lands after the chat is archived; then the folder made only from its id goes.
      deps.folderHold.cancelWait(id);
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

    send(conversationId, input, folder = FolderWhileHeld.ReadOnly) {
      const item = post(conversationId, input);
      const chat = requireChat(conversationId);
      const waiting = deps.folderHold.waiting(chat.id);
      const parks = folder === FolderWhileHeld.Wait && (waiting || mustWait(chat));
      // Starts are held before the queue is asked, so the message parks.
      if (parks) engine.holdStarts(conversationId);
      engine.queued(conversationId);
      if (parks) watchFolder(chat);
      else if (waiting) {
        // A read-only send applies to everything queued.
        deps.folderHold.cancelWait(chat.id);
        engine.releaseStarts(conversationId);
      }
      return item;
    },

    async stop(conversationId) {
      const chat = requireChat(conversationId);
      // The parked start is dropped by the stop; the hold on new starts goes with the wait.
      deps.folderHold.cancelWait(chat.id);
      await engine.stop(conversationId);
      engine.releaseStarts(conversationId);
    },

    sendNow(conversationId) {
      const chat = requireChat(conversationId);
      if (deps.folderHold.waiting(chat.id)) {
        stopWaiting(chat);
        return;
      }
      engine.sendNow(conversationId);
    },

    stopWaiting: (chatId) => {
      stopWaiting(getChat(state.db, chatId));
    },

    async redo(conversationId, input, folder = FolderWhileHeld.ReadOnly) {
      const chat = requireChat(conversationId);
      deps.folderHold.cancelWait(chat.id);
      await engine.stop(conversationId);
      engine.releaseStarts(conversationId);
      const wait = folder === FolderWhileHeld.Wait && mustWait(chat);
      if (wait) engine.holdStarts(conversationId);
      const edit = await engine.redo(conversationId, () => post(conversationId, input));
      if (wait) watchFolder(chat);
      return edit;
    },

    post: (conversationId, input) => post(conversationId, input),
  };

  function requireChat(conversationId: ConversationId): ChatRow {
    const chat = chatOfConversation(state.db, conversationId);
    if (chat === null) throw new ConflictError('This conversation is no chat’s');
    return chat;
  }

  /** Whether a turn of this chat can't take Your folder now: something other than an attended chat holds it. */
  function mustWait(chat: ChatRow): boolean {
    return (
      !deps.folderHold.holdsTurn(chat.id) &&
      deps.folderHold.blockers(chat.projectId, { kind: FolderAsker.ChatTurn, chatId: chat.id })
        .length > 0
    );
  }

  /** Registers the wait: each time the folder can be this chat's, its parked starters run. */
  function watchFolder(chat: ChatRow): void {
    const serve = (): ServeResult => {
      if (getChat(state.db, chat.id).archivedAt !== null) {
        engine.releaseStarts(chat.conversationId);
        return 'dropped';
      }
      if (engine.releaseStarts(chat.conversationId)) return 'began';
      if (!engine.parked(chat.conversationId)) return 'dropped';
      // Nothing could start (the update hold is on): keep waiting, and keep the starters parked.
      engine.holdStarts(chat.conversationId);
      return 'kept';
    };
    deps.folderHold.wait(chat.projectId, chat.id, serve);
  }

  function stopWaiting(chat: ChatRow): void {
    deps.folderHold.cancelWait(chat.id);
    if (!engine.releaseStarts(chat.conversationId)) engine.sendNow(chat.conversationId);
  }

  function post(conversationId: ConversationId, input: ChatMessageInput): ConversationItemRow {
    const chat = chatOfConversation(state.db, conversationId);
    if (chat === null) throw new ConflictError('This conversation is no chat’s');
    if (chat.archivedAt !== null) throw new ConflictError(CHAT_ARCHIVED);
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
