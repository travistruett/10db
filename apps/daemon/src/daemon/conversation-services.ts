import {
  CONVERSATION_PAGE_ITEMS,
  ConflictError,
  ConversationItemKind,
  ConversationOwnerKind,
  NotFoundError,
  TaskId,
  type ConversationFileDto,
  type ConversationId,
  type ConversationItemDto,
  type ConversationItemId,
  type NoticeOffer,
  type ProjectFileMatchDto,
} from '@10db/contracts';
import {
  getConversation,
  getItem,
  isAllowThisOffer,
  listItemFiles,
  listItems,
  offeredText,
  planOfConversation,
  type ConversationItemRow,
  type DbReader,
} from '@10db/db';
import {
  itemDtoOf,
  itemsWithFull,
  readConversationPicture,
  readFullOutput,
  type ExploreEngine,
  type LiveRegistry,
  type TaskThread,
} from '../conversation';
import type { ApiServices } from '../api';
import type { StateStore } from '../events';
import type { ChatService } from '../chat';

// Sessions spec §10: the conversation routes, one set for every owner. A message is taken by its
// owner (a chat's by `chat.send`, a plan's chat included, a task's by its thread, which
// the runner delivers). A task conversation's state is the runner's (spec §6.7): the engine's routes
// for state, Stop and Send now refuse it, and its page's own routes stop it.

export type ConversationApiServices = Pick<
  ApiServices,
  | 'conversationHasPlan'
  | 'getConversation'
  | 'conversationItems'
  | 'conversationLive'
  | 'postConversationMessage'
  | 'sendConversationNow'
  | 'stopConversation'
  | 'redoConversation'
  | 'conversationFull'
  | 'conversationFiles'
  | 'conversationPicture'
>;

const TASK_STATE =
  "A task's conversation runs in its lane: its page's Stop and its runner's queue are where it is driven.";

/** The pictures each message of a page of items carries. */
function filesOf(
  db: DbReader,
  rows: readonly ConversationItemRow[],
): ReadonlyMap<ConversationItemId, ConversationFileDto[]> {
  const files = new Map<ConversationItemId, ConversationFileDto[]>();
  const messages = rows.filter((r) => r.kind === ConversationItemKind.Message).map((r) => r.id);
  for (const file of listItemFiles(db, messages)) {
    if (file.itemId === null) continue;
    const held = files.get(file.itemId) ?? [];
    held.push({ id: file.id, name: file.name, mediaType: file.mediaType, size: file.size });
    files.set(file.itemId, held);
  }
  return files;
}

/** What a task's notice offers the builder to send. */
function offerOf(db: DbReader, row: ConversationItemRow): NoticeOffer | null {
  if (row.kind !== ConversationItemKind.Notice || offeredText(db, row.id) === null) return null;
  return isAllowThisOffer(db, row.id) ? 'allow_this' : 'send_to_agent';
}

export function createConversationServices(deps: {
  readonly state: StateStore;
  readonly engine: ExploreEngine;
  readonly chat: Pick<ChatService, 'send' | 'post' | 'sendNow' | 'stop' | 'redo' | 'waiting'>;
  /** The tracked files of the conversation's checkout an `@` query matches. */
  readonly files: (id: ConversationId, q: string) => Promise<ProjectFileMatchDto[]>;
  readonly dataDir: string;
  /** What a task conversation's session streams now; the runner serves it. */
  readonly laneLive: LiveRegistry;
  /** How the builder writes to a task's conversation: the task's thread, which the runner delivers. */
  readonly task: { readonly post: TaskThread['postTaskMessage'] };
}): ConversationApiServices {
  const { state, engine } = deps;
  /** The conversation, or NotFoundError; read first by every route. */
  const known = (id: ConversationId) => getConversation(state.db, id);
  /** The items as the UI reads them, each message with its pictures and each notice its offer. */
  const dtosOf = (id: ConversationId, rows: readonly ConversationItemRow[]) => {
    const full = itemsWithFull(deps.dataDir, id);
    const files = filesOf(state.db, rows);
    return rows.map((row) =>
      itemDtoOf(row, full.has(row.id), {
        files: files.get(row.id) ?? [],
        offer: offerOf(state.db, row),
      }),
    );
  };
  const dtoOf = (id: ConversationId, itemId: ConversationItemId): ConversationItemDto => {
    const [dto] = dtosOf(id, [getItem(state.db, itemId)]);
    if (dto === undefined) throw new NotFoundError('conversation item', itemId);
    return dto;
  };
  type Owner = { kind: 'chat' } | { kind: 'task'; taskId: TaskId };
  /** Who takes a message here: a Plan, by its id, a chat, or a task's thread. */
  const ownerOf = (id: ConversationId): Owner => {
    const conv = known(id);
    switch (conv.ownerKind) {
      case ConversationOwnerKind.Task:
        return { kind: 'task', taskId: TaskId.parse(conv.ownerId) };
      case ConversationOwnerKind.Chat:
        return { kind: 'chat' };
    }
  };
  /** The explore engine's conversation; ConflictError for a task's, whose state is the runner's. */
  const explore = (id: ConversationId): ConversationId => {
    if (ownerOf(id).kind === 'task') throw new ConflictError(TASK_STATE);
    return id;
  };
  return {
    conversationHasPlan(id) {
      known(id);
      return planOfConversation(state.db, id) !== null;
    },
    getConversation(id) {
      return engine.view(explore(id));
    },
    conversationItems(id, afterSeq) {
      known(id);
      // One more than a page says whether another follows.
      const rows = listItems(state.db, id, {
        ...(afterSeq === null ? {} : { afterSeq }),
        limit: CONVERSATION_PAGE_ITEMS + 1,
      });
      const page = rows.slice(0, CONVERSATION_PAGE_ITEMS);
      return {
        items: dtosOf(id, page),
        nextAfterSeq: rows.length > CONVERSATION_PAGE_ITEMS ? (page.at(-1)?.seq ?? null) : null,
      };
    },
    conversationLive(id) {
      const owner = ownerOf(id);
      if (owner.kind === 'task') return deps.laneLive.live(id);
      return {
        ...engine.live(id),
        waitingForFolder: deps.chat.waiting(id),
      };
    },
    async postConversationMessage(id, message) {
      const owner = ownerOf(id);
      switch (owner.kind) {
        case 'chat':
          return dtoOf(id, deps.chat.send(id, message, message.folder).id);
        case 'task': {
          const posted = await deps.task.post(owner.taskId, {
            text: message.text,
            pictures: message.pictures,
          });
          return dtoOf(id, posted.id);
        }
      }
    },
    sendConversationNow(id) {
      deps.chat.sendNow(explore(id));
      return engine.view(id);
    },
    async stopConversation(id) {
      if (ownerOf(explore(id)).kind === 'chat') await deps.chat.stop(id);
      else await engine.stop(id);
      return engine.view(id);
    },
    async redoConversation(id, message) {
      const owner = ownerOf(id);
      switch (owner.kind) {
        case 'chat': {
          const edit = await deps.chat.redo(
            id,
            { text: message.text, mentions: [], pictures: message.pictures },
            message.folder,
          );
          return dtoOf(id, edit.id);
        }
        // A page's Stop and Redo stops its running turn, then the message goes in (Workbench §6.3).
        case 'task': {
          const posted = await deps.task.post(
            owner.taskId,
            { text: message.text, pictures: message.pictures },
            { redo: true },
          );
          return dtoOf(id, posted.id);
        }
      }
    },
    conversationPicture(id, fileId) {
      known(id);
      return readConversationPicture(state.db, id, fileId);
    },
    conversationFiles: (id, q) => deps.files(id, q),
    conversationFull(id, itemId) {
      known(id);
      if (getItem(state.db, itemId).conversationId !== id)
        throw new NotFoundError('conversation item', itemId);
      const full = readFullOutput(deps.dataDir, id, itemId);
      if (full.output === null && full.patch === null && full.text === null)
        throw new NotFoundError('full output', itemId);
      return full;
    },
  };
}
