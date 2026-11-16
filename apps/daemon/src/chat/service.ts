import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVE_STATES,
  BriefReason,
  BriefSource,
  CHAT_DEFAULT_TITLE,
  ChatTitleSource,
  ConflictError,
  ConversationItemAuthor,
  ConversationItemKind,
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  DoItPlace,
  cutTitle,
  FolderAsker,
  FolderWhileHeld,
  InvalidError,
  mintId,
  TASK_MESSAGE_MAX_CHARS,
  TaskStatus,
  TASK_MESSAGE_PICTURES_MAX,
  TASK_MESSAGE_PICTURES_MAX_BYTES,
  type ChatCreateInput,
  type ChatDto,
  type ChatId,
  type ChatModelsDto,
  type ChatPatchInput,
  type ConversationId,
  type DoItBriefDto,
  type ProjectId,
  type ShapeModelOption,
} from '@10db/contracts';
import {
  archiveChat,
  chatOfConversation,
  chatView,
  getChat,
  getTask,
  getConversation,
  getProject,
  hasItemOfKind,
  insertChat,
  insertConversation,
  insertFiles,
  insertItem,
  latestWorkstreamOf,
  listQueuedTurnStarters,
  listItems,
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
import type { Clock } from '../clock';
import { keepBuilderMessage, type ExploreEngine, type PastedFile } from '../conversation';
import type { StateStore } from '../events';
import type { FolderHold, ServeResult } from '../folder-hold';
import type { Logger } from '../log';
import type { PendingOpens } from '../pass';
import { briefFromChat, briefRequestText, briefTitle } from './brief';
import type { Briefs } from './briefs';
import { chatFolder } from './hooks';

// Sessions spec §7.1, §10: a chat's life on the daemon. It is made with its conversation on the
// project's account, named from its first message, moved in the strip, and given a model between
// turns. The engine runs its session; this keeps the chat's own row.

/** Most characters of the title a chat's first message gives it. */
const FIRST_LINE_TITLE_MAX = 40;

/** What a message to an archived chat is refused with. */
export const CHAT_ARCHIVED = 'This session is archived.';
/** What Redo, archive and a second Do It are refused with while an open has stopped the chat's turn. */
export const DO_IT_UNDER_WAY =
  'A pass is opening and has stopped this chat’s turn; try again once it has opened';
/** What a send is refused with while Do It hands the chat's work to a task in a separate copy. */
export const HANDING_OFF = 'This chat is handing its work to a task';
/** What Do It and archive are refused with while a pass waits to open for the chat. */
export const PENDING_OPEN_FOR_CHAT = 'A pass is waiting to open for this chat; Cancel it first';
/** What archive is refused with while the task a chat was handed to is unfinished. */
export const HANDED_TASK_RUNNING = 'The task this session was handed to is still running';
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
  /** Stops waiting for Your folder: the queue runs reading only. A chat that waits for nothing is left as it is. */
  stopWaiting(chatId: ChatId): void;
  /** Whether the conversation's message waits for Your folder. */
  waiting(conversationId: ConversationId): boolean;
  /** Stop, then the edited message as the next turn, with its own choice for a folder in use. */
  redo(
    conversationId: ConversationId,
    input: ChatMessageInput,
    folder?: FolderWhileHeld,
  ): Promise<ConversationItemRow>;
  /** The message stored queued and the chat touched, with no turn asked for: what a Redo posts. */
  post(conversationId: ConversationId, input: ChatMessageInput): ConversationItemRow;
  /**
   * Asks the agent for a task's brief, between turns only: a reading-only turn that never takes the folder.
   * Mid-turn, waiting for the folder or paused, nothing is sent and the sheet takes the chat read back.
   */
  askBrief(chatId: ChatId, draft?: string): void;
  /** Cancels the request for a brief, stopping its turn when it is still the brief's. */
  cancelBrief(chatId: ChatId): Promise<void>;
  /** The brief the sheet shows now. */
  briefOf(chatId: ChatId): DoItBriefDto;
  /**
   * Stops the chat's turn so a pass can open under it, keeping its queued messages parked: its starts stay
   * held, its Stop answers at once and changes nothing, and Redo and archive are refused until the returned
   * `release` runs, which lets what is queued run. Refused when the chat is already stopped for one.
   */
  stopForOpen(chatId: ChatId, place?: DoItPlace): Promise<() => void>;
  /** Whether an open has stopped the chat's turn and not yet given its starts back. */
  underWay(chatId: ChatId): boolean;
  /** Seals the chat once Do It has handed its work to a task: its session ends and its brief is forgotten. */
  seal(chatId: ChatId): Promise<void>;
}

export interface ChatServiceDeps {
  readonly state: StateStore;
  readonly engine: ExploreEngine;
  readonly folderHold: FolderHold;
  /** A pass waiting to open names the chat that asked, and the chat can't be archived meanwhile. */
  readonly pendingOpens: Pick<PendingOpens, 'get'>;
  readonly briefs: Briefs;
  readonly clock: Pick<Clock, 'now'>;
  readonly dataDir: string;
  readonly log: Logger;
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

  // Chats a pass's open has stopped, until it is done: Stop must not give back the starts it holds.
  const stoppedForOpen = new Map<ChatId, DoItPlace>();
  // Chats whose last request for a brief was sent as a turn of its own, until that turn ends.
  const briefTurns = new Set<ChatId>();
  const refuseWhileDoing = (chatId: ChatId): void => {
    if (stoppedForOpen.has(chatId)) throw new ConflictError(DO_IT_UNDER_WAY);
  };

  // A chat sealed into a task of its own has nothing left to archive until that task ends: the tab it
  // closed is the builder's only link to it.
  const refuseWhileHandedTaskRuns = (chat: ChatRow): void => {
    if (chat.taskId === null || chat.passId !== null) return;
    // A task the builder removed or finished is over, whatever its last run reads.
    if (getTask(state.db, chat.taskId).status !== TaskStatus.Open) return;
    const run = latestWorkstreamOf(state.db, chat.taskId);
    if (run === undefined || ACTIVE_STATES.includes(run.state))
      throw new ConflictError(HANDED_TASK_RUNNING);
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
      refuseWhileDoing(id);
      refuseWhileHandedTaskRuns(chat);
      if (deps.pendingOpens.get(chat.projectId)?.chatId === id)
        throw new ConflictError(PENDING_OPEN_FOR_CHAT);
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

    send(conversationId, input, folder) {
      // A chat handing its work to a task is sealed in a moment: nothing is left parked in it.
      const doing = chatOfConversation(state.db, conversationId);
      if (doing !== null && stoppedForOpen.get(doing.id) === DoItPlace.Worktree)
        throw new ConflictError(HANDING_OFF);
      const item = post(conversationId, input);
      const chat = requireChat(conversationId);
      // A message from the builder replaces a brief request. A brief turn still running reads only, so it is
      // stopped first and the message runs as its own turn, taking the folder like any other.
      deps.briefs.endAsk(chat.id);
      if (briefTurnRunning(chat)) {
        briefTurns.delete(chat.id);
        engine.holdStarts(conversationId);
        void stopHeld(conversationId, () => dispatch(chat, conversationId, folder));
        return item;
      }
      dispatch(chat, conversationId, folder);
      return item;
    },

    async stop(conversationId) {
      const chat = requireChat(conversationId);
      // The turn is already stopping, and the open's hold on its starts is not Stop's to undo.
      if (stoppedForOpen.has(chat.id)) return;
      briefTurns.delete(chat.id);
      // The parked start is dropped by the stop; the hold on new starts goes with the wait.
      deps.folderHold.cancelWait(chat.id);
      await engine.stop(conversationId);
      engine.releaseStarts(conversationId);
    },

    sendNow(conversationId) {
      const chat = requireChat(conversationId);
      briefTurns.delete(chat.id);
      if (deps.folderHold.waiting(chat.id)) {
        stopWaiting(chat);
        return;
      }
      engine.sendNow(conversationId);
    },

    waiting: (conversationId) => deps.folderHold.waiting(requireChat(conversationId).id),

    stopWaiting: (chatId) => {
      const chat = getChat(state.db, chatId);
      // The wait may have ended since the builder saw it: there is then nothing to run or to refuse.
      if (deps.folderHold.waiting(chat.id)) stopWaiting(chat);
    },

    async redo(conversationId, input, folder) {
      const chat = requireChat(conversationId);
      refuseWhileDoing(chat.id);
      briefTurns.delete(chat.id);
      deps.folderHold.cancelWait(chat.id);
      await engine.stop(conversationId);
      engine.releaseStarts(conversationId);
      if (folder === FolderWhileHeld.ReadOnly) deps.folderHold.chooseReadOnly(chat.id);
      const wait = folder === FolderWhileHeld.Wait && mustWait(chat);
      if (wait) engine.holdStarts(conversationId);
      const edit = await engine.redo(conversationId, () => post(conversationId, input));
      if (wait) watchFolder(chat);
      return edit;
    },

    post: (conversationId, input) => post(conversationId, input),

    async seal(chatId) {
      const chat = getChat(state.db, chatId);
      await engine.seal(chat.conversationId);
      deps.briefs.forget(chatId);
      briefTurns.delete(chatId);
    },

    underWay: (chatId) => stoppedForOpen.has(chatId),

    async stopForOpen(chatId, place = DoItPlace.Here) {
      const chat = getChat(state.db, chatId);
      refuseWhileDoing(chatId);
      stoppedForOpen.set(chatId, place);
      // Starts are held first, so a chained or queued message parks instead of beginning a turn.
      engine.holdStarts(chat.conversationId);
      try {
        deps.folderHold.cancelWait(chatId);
        await engine.stop(chat.conversationId);
        await engine.settled(chat.conversationId);
      } catch (error) {
        stoppedForOpen.delete(chatId);
        engine.releaseStarts(chat.conversationId);
        throw error;
      }
      return () => {
        if (!stoppedForOpen.delete(chatId)) return;
        engine.releaseStarts(chat.conversationId);
      };
    },

    askBrief(chatId, draft) {
      const chat = getChat(state.db, chatId);
      refuseWhileDoing(chatId);
      if (!briefAskable(chat)) return;
      // A brief already written is kept for the sheet, and a request still waiting is not asked twice.
      if (deps.briefs.written(chat.id) !== null) return;
      if (deps.briefs.asked(chat.id) !== null && !deps.briefs.expired(chat.id)) return;
      // Posted first: a chat that can't take a message is never marked as asked.
      post(
        chat.conversationId,
        { text: briefRequestText(draft), mentions: [], pictures: [] },
        'brief',
      );
      deps.briefs.ask(chat.id);
      briefTurns.add(chat.id);
      // The turn reads only, so it never runs on a writable hold, and a brief is never chained.
      deps.folderHold.chooseReadOnly(chat.id);
      engine.queued(chat.conversationId);
    },

    async cancelBrief(chatId) {
      const chat = getChat(state.db, chatId);
      deps.briefs.endAsk(chat.id);
      // Only the brief's own turn is stopped: a turn the builder began since is theirs.
      if (!briefTurnRunning(chat)) return;
      briefTurns.delete(chat.id);
      await engine.stop(chat.conversationId);
    },

    briefOf(chatId) {
      const chat = getChat(state.db, chatId);
      const written = deps.briefs.written(chat.id);
      if (written !== null)
        return {
          title: written.title,
          text: written.brief,
          areas: written.areas ?? [],
          criteria: written.acceptanceCriteria ?? [],
          source: BriefSource.Agent,
          reason: null,
          writing: false,
        };
      const askedAt = deps.briefs.asked(chat.id);
      const expired = deps.briefs.expired(chat.id);
      const at = engine.view(chat.conversationId).state;
      const items = listItems(state.db, chat.conversationId);
      const fromChat = {
        title: briefTitle(chatView(state.db, chat.id).title),
        text: briefFromChat(items),
        areas: [],
        criteria: [],
        source: BriefSource.Chat,
        writing: false,
      };
      if (askedAt !== null && !expired)
        return { ...fromChat, title: '', text: '', source: null, reason: null, writing: true };
      if (askedAt !== null) return { ...fromChat, reason: BriefReason.Timeout };
      if (at === ConversationState.PausedAccount)
        return { ...fromChat, reason: BriefReason.Paused };
      return { ...fromChat, reason: briefAskable(chat) ? null : BriefReason.MidTurn };
    },
  };

  /**
   * Whether the agent can be asked for a brief now: between turns, with nothing waiting for the folder, no
   * start held and no message of the builder's not yet delivered, so the request never shares a turn with it.
   */
  function briefAskable(chat: ChatRow): boolean {
    const between: readonly ConversationState[] = [
      ConversationState.IdleCold,
      ConversationState.IdleWarm,
      ConversationState.EndedError,
    ];
    return (
      between.includes(engine.view(chat.conversationId).state) &&
      !deps.folderHold.waiting(chat.id) &&
      !engine.parked(chat.conversationId) &&
      listQueuedTurnStarters(state.db, chat.conversationId).length === 0
    );
  }

  /**
   * Stops the turn with starts held, runs `next` (the queue's half of the send, so its folder choice is made
   * before anything starts, and whether it parked the message), then lets the starts go unless an open holds
   * them or the message waits for the folder.
   */
  async function stopHeld(conversationId: ConversationId, next: () => boolean): Promise<void> {
    const chat = chatOfConversation(state.db, conversationId);
    try {
      await engine.stop(conversationId);
      await engine.settled(conversationId);
    } catch {
      // A stop that fails leaves the turn as it was; the message still runs after it.
    }
    let parked = false;
    try {
      parked = next();
    } catch (error) {
      deps.log.warn(
        { conversationId, err: error instanceof Error ? error.message : String(error) },
        'a message sent during a brief turn could not be queued',
      );
    } finally {
      // The starts of a chat an open stopped are held for the open, which gives them back itself.
      // A message that waits for the folder keeps its starts held; the wait releases them.
      if (!parked && (chat === null || !stoppedForOpen.has(chat.id)))
        engine.releaseStarts(conversationId);
    }
  }

  /** Whether the turn running now is the one that was asked for a brief; forgets the mark once it ended. */
  function briefTurnRunning(chat: ChatRow): boolean {
    if (!briefTurns.has(chat.id)) return false;
    if (BUSY.has(engine.view(chat.conversationId).state)) return true;
    briefTurns.delete(chat.id);
    return false;
  }

  /** The queue's half of a send: the folder choice, the wait for the folder, and the turn asked for. */
  function dispatch(
    chat: ChatRow,
    conversationId: ConversationId,
    folder: FolderWhileHeld | undefined,
  ): boolean {
    const waiting = deps.folderHold.waiting(chat.id);
    const parks = folder === FolderWhileHeld.Wait && (waiting || mustWait(chat));
    // A read-only send applies to everything queued, and to the turn that runs it even if the folder frees.
    if (!parks && waiting) deps.folderHold.cancelWait(chat.id);
    // A running turn's chained successor inherits its profile and starts without asking the folder, so a
    // choice made then would wait for some later turn.
    if (folder === FolderWhileHeld.ReadOnly && !BUSY.has(engine.view(conversationId).state))
      deps.folderHold.chooseReadOnly(chat.id);
    // Starts are held before the queue is asked, so the message parks.
    if (parks) engine.holdStarts(conversationId);
    engine.queued(conversationId);
    if (parks) watchFolder(chat);
    else if (waiting) engine.releaseStarts(conversationId);
    return parks;
  }

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

  function post(
    conversationId: ConversationId,
    input: ChatMessageInput,
    purpose?: 'brief',
  ): ConversationItemRow {
    const chat = chatOfConversation(state.db, conversationId);
    if (chat === null) throw new ConflictError('This conversation is no chat’s');
    if (chat.archivedAt !== null) throw new ConflictError(CHAT_ARCHIVED);
    // A sealed chat runs no turn again: a message kept in it would wait for ever.
    if (getConversation(state.db, conversationId).state === ConversationState.Sealed)
      throw new ConflictError(HANDING_OFF);
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
            body: {
              text: body,
              ...(input.mentions.length === 0 ? {} : { mentions: [...input.mentions] }),
              ...(purpose === undefined ? {} : { purpose }),
            },
          });
          insertFiles(ctx, conversationId, row.id, files);
          if (first && purpose === undefined)
            setChatTitle(ctx, chat.id, firstMessageTitle(body), ChatTitleSource.Agent);
          touchChat(ctx, chat.id, ctx.now);
          return row;
        }),
    });
  }
}
