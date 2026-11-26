import { rmdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ACTIVE_STATES,
  CHAT_DEFAULT_TITLE,
  ChatTitleSource,
  ConflictError,
  ConversationItemAuthor,
  ConversationItemKind,
  ConversationOwnerKind,
  ConversationProfile,
  ConversationState,
  ShapeOrigin,
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
  type ChatSearchPage,
  type ChatSearchQuery,
  type ChatDto,
  type ChatId,
  type ChatModelsDto,
  type ArchivePreviewDto,
  type ArchiveRequest,
  type ChatPatchInput,
  type FullAccessPreviewDto,
  type ConversationId,
  type ConversationItemId,
  type ProjectId,
  type ShapeModelOption,
  WorkPlace,
} from '@10db/contracts';
import {
  archiveChat,
  chatOfConversation,
  deleteAppSetting,
  findOpenByFoldKey,
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
  insertPlanSession,
  latestWorkstreamOf,
  moveChatTab,
  listActiveProjects,
  openChats,
  patchConversation,
  recentChats,
  searchChats,
  ensurePlanOfChat,
  setChatFullAccess,
  setChatTitle,
  setChatWork,
  touchChat,
  unarchiveChat,
  type ChatRow,
  type ConversationItemRow,
  planIdOfChat,
  planOfChat,
  planWaitingOfChat,
} from '@10db/db';
import type { Clock } from '../clock';
import { keepBuilderMessage, type ExploreEngine, type PastedFile } from '../conversation';
import type { StateStore } from '../events';
import { chatWorktreePinKey } from '../git';
import { withdrawCard } from '../inbox';
import { refuseArchived } from '../projects';
import type { FolderHold, ServeResult } from '../folder-hold';
import type { Logger } from '../log';
import type { PendingOpens } from '../pass';
import { chatFolder } from './hooks';
import type { ChatWorkService } from './work-service';
import { chatWorkCardKey } from './work-card';

// Sessions spec §7.1, §10: a chat's life on the daemon. It is made with its conversation on the
// project's account, named from its first message, moved in the strip, and given a model between
// turns. The engine runs its session; this keeps the chat's own row.

/** Most characters of the title a chat's first message gives it. */
const FIRST_LINE_TITLE_MAX = 40;

/** What Archive reads and removes of a session's worktree: git's side, which the daemon supplies. */
export interface ChatWorktrees {
  /** The files removing the worktree at `path` would lose: uncommitted changes, and ignored files 10db did not seed. */
  losses(chat: ChatRow): Promise<{ readonly uncommitted: string[]; readonly ignored: string[] }>;
  /** Removes the worktree and its git entry; one already gone is fine. */
  remove(chat: ChatRow): Promise<void>;
}

/** Archive found more files at risk than the builder was warned about; `preview` is the fresh list. */
export class ChatArchiveWarning extends ConflictError {
  readonly preview: ArchivePreviewDto;
  constructor(preview: ArchivePreviewDto) {
    super('More files changed since Archive warned you. Check the list and archive again.');
    this.preview = preview;
  }
}

/** What a message to an archived chat is refused with. */
export const CHAT_ARCHIVED = 'This session is archived.';
/** What Redo and archive are refused with while a pass's open has stopped the chat's turn. */
export const PASS_OPENING =
  'A pass is opening and has stopped this chat’s turn; try again once it has opened';
/** What a send is refused with while Do It hands the chat's work to a task in a separate copy. */
export const HANDING_OFF = 'This chat is handing its work to a task';
/** What Show Plan is refused with on a chat whose work moved to a task. */
export const SEALED_NO_PLAN = 'This session’s work moved to a task, so it has no Plan.';
/** What Do It and archive are refused with while a pass waits to open for the chat. */
export const PENDING_OPEN_FOR_CHAT = 'A pass is waiting to open for this chat; Cancel it first';
/** What archive is refused with while the task a chat was handed to is unfinished. */
export const HANDED_TASK_RUNNING = 'The task this session was handed to is still running';
/** What a model change while a turn runs is refused with. */
export const CHANGE_MODEL_BETWEEN_TURNS = 'Change the model between turns.';
/** What a Full access change while a turn runs is refused with. */
export const CHANGE_FULL_ACCESS_BETWEEN_TURNS = 'Waits for the turn to end.';
/** What a model the account doesn't offer is refused with. */
export const MODEL_NOT_OFFERED = 'Not available on this account';

/**
 * Removes a folder only while it is empty; one that is missing or holds files stays as it is. Any other
 * failure is logged, not thrown: the folder is housekeeping and the archive it follows has committed.
 */
function removeEmptyFolder(path: string, log: Logger): void {
  try {
    rmdirSync(path);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : null;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY')
      log.warn({ err: error, path }, 'an archived chat’s empty plan folder could not be removed');
  }
}

/** Matches a panel search returns at a time. */
const CHAT_SEARCH_PAGE = 30;

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
  search(query: ChatSearchQuery): ChatSearchPage;
  patch(id: ChatId, input: ChatPatchInput): Promise<ChatDto>;
  /** The setup lines of the Full access confirmation: where this chat's settings, plugins and servers come from. */
  fullAccessPreview(id: ChatId): FullAccessPreviewDto;
  models(projectId: ProjectId): ChatModelsDto;
  /**
   * Archives the chat. On a branch with a worktree the request carries the files the builder was warned Archive
   * would lose; a later list that holds more is a `ChatArchiveWarning` with the fresh preview, and nothing changes.
   */
  archive(id: ChatId, request?: ArchiveRequest): Promise<ChatDto>;
  unarchive(id: ChatId): ChatDto;
  /** Makes the chat's Plan when it has none (nothing is run), and answers the chat with its `planId`. */
  showPlan(id: ChatId): ChatDto;
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
  /**
   * A turn that needs Your folder found it taken as it began: its starters park, and run once the folder can be
   * the chat's, as a blocked Here send's do.
   */
  parkForFolder(chatId: ChatId): void;
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
  /**
   * The line that resumes a session after the builder chose where it works, as a system line in the thread, and
   * the turn it asks for: held behind the checkout when this session works there and a Board task has it.
   */
  carryOn(chatId: ChatId, text: string): void;
  /** The message stored queued and the chat touched, with no turn asked for: what a Redo posts. */
  post(conversationId: ConversationId, input: ChatMessageInput): ConversationItemRow;
  /**
   * Stops the chat's turn so a pass can open under it, keeping its queued messages parked: its starts stay
   * held, its Stop answers at once and changes nothing, and Redo and archive are refused until the returned
   * `release` runs, which lets what is queued run. Refused when the chat is already stopped for one.
   */
  stopForOpen(chatId: ChatId): Promise<() => void>;
  /** Whether an open has stopped the chat's turn and not yet given its starts back. */
  underWay(chatId: ChatId): boolean;
  /** Seals a chat a daemon stop left half-handed to a task: its session ends. */
  seal(chatId: ChatId): Promise<void>;
  /**
   * Waits for Your folder on the chat's behalf: each time it can be the chat's, its parked starters run. What
   * Hand Back does for the messages held while the chat was in the builder's terminal.
   */
  watchFolder(conversationId: ConversationId): void;
}

/** What a takeover does to a chat's archive: runs it in order with the takeover's own calls, and ends the takeover. */
export interface ArchiveTakeover {
  /** Runs `job` after the chat's earlier takeover calls, before its later ones. */
  serialized<T>(chatId: ChatId, job: () => Promise<T>): Promise<T>;
  /** The chat is archived: its hold is released, waiters served and its files removed. */
  ended(chatId: ChatId): Promise<void>;
}

export interface ChatServiceDeps {
  readonly state: StateStore;
  readonly engine: ExploreEngine;
  readonly folderHold: FolderHold;
  /** A pass waiting to open names the chat that asked, and the chat can't be archived meanwhile. */
  readonly pendingOpens: Pick<PendingOpens, 'get'>;
  readonly clock: Pick<Clock, 'now'>;
  readonly dataDir: string;
  /** Where each plan's folder lives, `<shapesDir>/<plan>`. */
  readonly shapesDir: string;
  readonly log: Logger;
  readonly now: () => Date;
  /** The models a project's account offers for a conversation, and its default. */
  modelsOf(projectId: ProjectId): { default: string | null; offered: readonly ShapeModelOption[] };
  /** Whether the agent of the project's account searches the web (`capabilities.webSearch`). */
  webSearchOf(projectId: ProjectId): boolean;
  /** The takeover service, read when a chat is archived (it is made after this service). */
  readonly takeover?: () => ArchiveTakeover | null;
  /** The worktrees of sessions on their own branch; absent where nothing makes one. */
  readonly worktrees?: ChatWorktrees;
  /** Records a reading or choosing session as Here, read when Full access is turned on (made after this service). */
  readonly work?: () => Pick<ChatWorkService, 'enterHere'>;
  /** What the confirmation says of a project's account: how its agent gets the builder's setup under Full access. */
  readonly fullAccessNotes: (projectId: ProjectId) => string[];
  /** Remakes the worktree of a branch session that has none, once it is open again. */
  readonly reopenBranch?: (chatId: ChatId) => Promise<void>;
  /** Told of each builder message a chat takes, for what listens to a plan's talk (Jev's shadow); it never throws. */
  readonly planHeard?: (conversationId: ConversationId, itemId: ConversationItemId) => void;
}

export function createChatService(deps: ChatServiceDeps): ChatService {
  const { state, engine } = deps;
  const dtoOf = (id: ChatId): ChatDto => {
    const view = chatView(state.db, id);
    return {
      ...view,
      conversation: engine.view(view.conversationId),
      planId: planOfChat(state.db, id),
      planWaiting: planWaitingOfChat(state.db, id),
    };
  };

  const offered = (projectId: ProjectId, model: string): void => {
    if (!deps.modelsOf(projectId).offered.some((m) => m.model === model))
      throw new InvalidError(MODEL_NOT_OFFERED);
  };

  // Chats a pass's open has stopped, until it is done: Stop must not give back the starts it holds.
  const stoppedForOpen = new Set<ChatId>();
  // The words a refused action gives while a session is moving to its branch.
  const MOVING_WORDS = 'Wait for the move to finish.';
  // Whether the chat has a worktree of its own that Archive removes: a branch session that still has one.
  const ownsWorktree = (chat: ChatRow): boolean =>
    chat.workPlace === WorkPlace.Branch &&
    chat.worktreePath !== null &&
    deps.worktrees !== undefined;
  const previewOf = async (chat: ChatRow): Promise<ArchivePreviewDto> => {
    if (!ownsWorktree(chat) || deps.worktrees === undefined)
      return { worktree: null, branch: chat.branch, uncommitted: [], ignored: [] };
    const losses = await deps.worktrees.losses(chat);
    return { worktree: chat.worktreePath, branch: chat.branch, ...losses };
  };
  const refuseUnwarned = async (
    chat: ChatRow,
    request: ArchiveRequest | undefined,
  ): Promise<void> => {
    if (!ownsWorktree(chat)) return;
    const preview = await previewOf(chat);
    const told = {
      uncommitted: new Set(request?.uncommitted ?? []),
      ignored: new Set(request?.ignored ?? []),
    };
    if (
      preview.uncommitted.some((path) => !told.uncommitted.has(path)) ||
      preview.ignored.some((path) => !told.ignored.has(path))
    )
      throw new ChatArchiveWarning(preview);
  };
  const reopen = (chatId: ChatId): void => {
    deps.reopenBranch?.(chatId).catch((error: unknown) => {
      deps.log.warn({ err: error, chatId }, 'a reopened session’s worktree could not be remade');
    });
  };
  // Full access applies from the next turn: stored, then the warm session closes so the next start reads it.
  // Turning it on while the session only reads records Here first, as Open in Terminal does.
  const refuseFullAccessChange = (chat: ReturnType<typeof getChat>, on: boolean): void => {
    const conv = getConversation(state.db, chat.conversationId);
    if (conv.state !== null && BUSY.has(conv.state))
      throw new ConflictError(CHANGE_FULL_ACCESS_BETWEEN_TURNS);
    if (chat.workPlace === WorkPlace.Moving) throw new ConflictError(MOVING_WORDS);
    if (
      on &&
      (conv.state === ConversationState.TakenOver || conv.state === ConversationState.Sealed)
    )
      throw new ConflictError(
        'Full access isn’t available while the session is in your terminal or handed off.',
      );
  };
  const changeFullAccess = async (chat: ReturnType<typeof getChat>, on: boolean): Promise<void> => {
    if (on) deps.work?.().enterHere(chat.id);
    state.write((ctx) => {
      setChatFullAccess(ctx, chat.id, on);
    });
    await engine.relocate(chat.conversationId);
  };

  const refuseWhileDoing = (chatId: ChatId): void => {
    if (stoppedForOpen.has(chatId)) throw new ConflictError(PASS_OPENING);
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
      if (input.plan === true) {
        const planned = state.write(
          (ctx) =>
            insertPlanSession(ctx, {
              projectId: input.projectId,
              title: null,
              origin: ShapeOrigin.App,
              tabPosition: input.tabPosition,
              model: input.model,
              effort: input.effort ?? null,
            }).chat.id,
        );
        return dtoOf(planned);
      }
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

    open: () => {
      const live = new Set(listActiveProjects(state.db).map((p) => p.id));
      return openChats(state.db)
        .filter((row) => live.has(row.projectId))
        .map((row) => dtoOf(row.id));
    },

    search(query) {
      const page = searchChats(state.db, {
        text: query.q,
        after: query.after ?? null,
        limit: CHAT_SEARCH_PAGE,
      });
      return { rows: page.rows.map((row) => dtoOf(row.id)), next: page.next };
    },

    recent: (projectId, limit = 6) =>
      recentChats(state.db, projectId, limit).map((row) => dtoOf(row.id)),

    async patch(id, input) {
      const chat = getChat(state.db, id);
      // Refused before anything is applied, so a patch that carries a model and Full access never half-applies.
      const fullAccess =
        input.fullAccess !== undefined && input.fullAccess !== chat.fullAccess
          ? input.fullAccess
          : undefined;
      if (fullAccess !== undefined) refuseFullAccessChange(chat, fullAccess);
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
      if (fullAccess !== undefined) await changeFullAccess(chat, fullAccess);
      const wasClosed = getChat(state.db, id).tabPosition === null;
      state.write((ctx) => {
        if (input.title !== undefined) setChatTitle(ctx, id, input.title, ChatTitleSource.Builder);
        if (input.tabPosition !== undefined) moveChatTab(ctx, id, input.tabPosition);
      });
      // Reopened from Recently closed: a branch session with no worktree gets it back. A tab that only moves
      // is already open, and its worktree was tried when it opened.
      if (wasClosed && input.tabPosition !== undefined && input.tabPosition !== null) reopen(id);
      return dtoOf(id);
    },

    fullAccessPreview(id) {
      return { notes: deps.fullAccessNotes(getChat(state.db, id).projectId) };
    },

    models(projectId) {
      const models = deps.modelsOf(projectId);
      return {
        default: models.default,
        offered: [...models.offered],
        webSearch: deps.webSearchOf(projectId),
      };
    },

    async archive(id, request) {
      const takeover = deps.takeover?.() ?? null;
      const archive = async (): Promise<ChatDto> => {
        const chat = getChat(state.db, id);
        if (chat.archivedAt !== null) return dtoOf(id);
        refuseWhileDoing(id);
        if (chat.workPlace === WorkPlace.Moving) throw new ConflictError(MOVING_WORDS);
        refuseWhileHandedTaskRuns(chat);
        if (deps.pendingOpens.get(chat.projectId)?.chatId === id)
          throw new ConflictError(PENDING_OPEN_FOR_CHAT);
        // Refused before anything is stopped when more is at risk than the builder was told.
        await refuseUnwarned(chat, request);
        // The session ends first (a start cancelled, a turn stopped, a card withdrawn), so nothing it
        // does lands after the chat is archived; then the folder made only from its id goes.
        deps.folderHold.cancelWait(id);
        await engine.retire(chat.conversationId);
        const worktree = ownsWorktree(chat);
        if (worktree) {
          // The turn has ended: this is the final list, and a file written since the first check refuses too.
          try {
            await refuseUnwarned(chat, request);
            await deps.worktrees?.remove(chat);
          } catch (error) {
            // Nothing was archived, so the session must take messages again.
            engine.unretire(chat.conversationId);
            throw error;
          }
        }
        state.write((ctx) => {
          if (chat.workPlace === WorkPlace.Choosing) {
            const card = findOpenByFoldKey(ctx.tx, chat.projectId, chatWorkCardKey(id));
            if (card !== undefined) withdrawCard(ctx, card.id);
          }
          // The pin and the row's path go with the worktree, together; the branch stays.
          if (worktree) {
            deleteAppSetting(ctx, chatWorktreePinKey(id));
            setChatWork(ctx, id, chat.workPlace, { place: chat.workPlace, worktreePath: null });
          }
          archiveChat(ctx, id, ctx.now);
        });
        // A chat in the builder's terminal gives the folder back and its files go.
        await takeover?.ended(id);
        await rm(chatFolder(deps.dataDir, chat.conversationId), { recursive: true, force: true });
        // A chat with no plan has nothing in its derived plan folder (uploads and screens need a plan), so it is
        // empty; the next session of a reopened chat makes it again.
        if (planOfChat(state.db, id) === null)
          removeEmptyFolder(join(deps.shapesDir, planIdOfChat(id)), deps.log);
        return dtoOf(id);
      };
      return takeover === null ? archive() : takeover.serialized(id, archive);
    },

    unarchive(id) {
      state.write((ctx) => {
        unarchiveChat(ctx, id);
      });
      engine.unretire(getChat(state.db, id).conversationId);
      reopen(id);
      return dtoOf(id);
    },

    showPlan(id) {
      const chat = getChat(state.db, id);
      if (chat.archivedAt !== null) throw new ConflictError(CHAT_ARCHIVED);
      if (getConversation(state.db, chat.conversationId).state === ConversationState.Sealed)
        throw new ConflictError(SEALED_NO_PLAN);
      state.write((ctx) => ensurePlanOfChat(ctx, id, ShapeOrigin.App));
      return dtoOf(id);
    },

    send(conversationId, input, folder) {
      const chat = requireChat(conversationId);
      refuseArchived(state.db, chat.projectId);
      const item = post(conversationId, input);
      dispatch(chat, conversationId, folder);
      deps.planHeard?.(conversationId, item.id);
      return item;
    },

    async stop(conversationId) {
      const chat = requireChat(conversationId);
      // The turn is already stopping, and the open's hold on its starts is not Stop's to undo; a move holds
      // them too, and finishes on its own.
      if (stoppedForOpen.has(chat.id) || chat.workPlace === WorkPlace.Moving) return;
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

    waiting: (conversationId) => deps.folderHold.waiting(requireChat(conversationId).id),

    stopWaiting: (chatId) => {
      const chat = getChat(state.db, chatId);
      // The wait may have ended since the builder saw it: there is then nothing to run or to refuse.
      if (deps.folderHold.waiting(chat.id)) stopWaiting(chat);
    },

    async redo(conversationId, input, folder) {
      const chat = requireChat(conversationId);
      refuseArchived(state.db, chat.projectId);
      refuseWhileDoing(chat.id);
      if (chat.workPlace === WorkPlace.Moving) throw new ConflictError(MOVING_WORDS);
      deps.folderHold.cancelWait(chat.id);
      await engine.stop(conversationId);
      engine.releaseStarts(conversationId);
      const wait =
        (folder !== undefined || getChat(state.db, chat.id).fullAccess) && mustWait(chat);
      if (wait) engine.holdStarts(conversationId);
      const edit = await engine.redo(conversationId, () => post(conversationId, input));
      if (wait) watchFolder(chat);
      deps.planHeard?.(conversationId, edit.id);
      return edit;
    },

    post: (conversationId, input) => post(conversationId, input),

    carryOn(chatId, text) {
      const chat = getChat(state.db, chatId);
      post(chat.conversationId, { text, mentions: [], pictures: [] }, 'carry_on');
      dispatch(getChat(state.db, chatId), chat.conversationId, FolderWhileHeld.Wait);
    },

    async seal(chatId) {
      const chat = getChat(state.db, chatId);
      await engine.seal(chat.conversationId);
    },

    underWay: (chatId) => stoppedForOpen.has(chatId),

    async stopForOpen(chatId) {
      const chat = getChat(state.db, chatId);
      refuseWhileDoing(chatId);
      stoppedForOpen.add(chatId);
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

    parkForFolder(chatId) {
      const chat = getChat(state.db, chatId);
      engine.holdStarts(chat.conversationId);
      watchFolder(chat);
    },

    watchFolder: (conversationId) => {
      watchFolder(requireChat(conversationId));
    },
  };

  /** The queue's half of a send: the folder choice, the wait for the folder, and the turn asked for. */
  function dispatch(
    chat: ChatRow,
    conversationId: ConversationId,
    folder: FolderWhileHeld | undefined,
  ): boolean {
    const waiting = deps.folderHold.waiting(chat.id);
    // A request to read only (an old client's) is read as wait, and a Full access chat never runs read-only.
    const choice =
      folder ?? (getChat(state.db, chat.id).fullAccess ? FolderWhileHeld.Wait : undefined);
    const parks = choice !== undefined && (waiting || mustWait(chat));
    if (!parks && waiting) deps.folderHold.cancelWait(chat.id);
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
    // Only a session working in the checkout takes the hold; one that reads, or has its own branch, never waits.
    // A Full access chat takes it wherever it works, so it waits wherever it works.
    const row = getChat(state.db, chat.id);
    if (row.workPlace !== WorkPlace.Here && !(row.fullAccess && row.workPlace !== WorkPlace.Moving))
      return false;
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
    purpose?: 'carry_on',
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
