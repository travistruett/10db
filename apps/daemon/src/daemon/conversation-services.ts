import {
  CONVERSATION_PAGE_ITEMS,
  ConflictError,
  ConversationOwnerKind,
  NotFoundError,
  ShapeId,
  type ConversationId,
  type ConversationItemDto,
  type ConversationItemId,
  type ProjectFileMatchDto,
} from '@10db/contracts';
import { getConversation, getItem, listItems } from '@10db/db';
import { itemDtoOf, itemsWithFull, readFullOutput, type ExploreEngine } from '../conversation';
import type { ApiServices } from '../api';
import type { StateStore } from '../events';
import type { ChatService } from '../chat';
import type { ShapeService } from '../shape';

// Sessions spec §10: the conversation routes, one set for every explore owner. A message is taken
// by its owner (a Plan conversation's by `shape.send`, a chat's by `chat.send`); a task's thread
// keeps its own routes (M4c).

export type ConversationApiServices = Pick<
  ApiServices,
  | 'conversationOwnerKind'
  | 'getConversation'
  | 'conversationItems'
  | 'conversationLive'
  | 'postConversationMessage'
  | 'sendConversationNow'
  | 'stopConversation'
  | 'redoConversation'
  | 'conversationFull'
  | 'conversationFiles'
>;

const TASK_THREAD =
  "A task's thread takes the builder's messages on its own routes, so a lane's runner delivers them.";

export function createConversationServices(deps: {
  readonly state: StateStore;
  readonly engine: ExploreEngine;
  readonly shape: Pick<ShapeService, 'send' | 'redo' | 'sendNow'>;
  readonly chat: Pick<ChatService, 'send' | 'post'>;
  /** The tracked files of the conversation's checkout an `@` query matches. */
  readonly files: (id: ConversationId, q: string) => Promise<ProjectFileMatchDto[]>;
  readonly dataDir: string;
}): ConversationApiServices {
  const { state, engine } = deps;
  /** The conversation, or NotFoundError; read first by every route. */
  const known = (id: ConversationId) => getConversation(state.db, id);
  const dtoOf = (id: ConversationId, itemId: ConversationItemId): ConversationItemDto =>
    itemDtoOf(getItem(state.db, itemId), itemsWithFull(deps.dataDir, id).has(itemId));
  /** Who takes a message here: a Plan, by its id, or a chat; a task's thread takes none here. */
  const ownerOf = (id: ConversationId): { kind: 'shape'; shapeId: ShapeId } | { kind: 'chat' } => {
    const conv = known(id);
    switch (conv.ownerKind) {
      case ConversationOwnerKind.Shape:
        return { kind: 'shape', shapeId: ShapeId.parse(conv.ownerId) };
      case ConversationOwnerKind.Task:
        throw new ConflictError(TASK_THREAD);
      case ConversationOwnerKind.Chat:
        return { kind: 'chat' };
    }
  };
  return {
    conversationOwnerKind: (id) => known(id).ownerKind,
    getConversation(id) {
      known(id);
      return engine.view(id);
    },
    conversationItems(id, afterSeq) {
      known(id);
      // One more than a page says whether another follows.
      const rows = listItems(state.db, id, {
        ...(afterSeq === null ? {} : { afterSeq }),
        limit: CONVERSATION_PAGE_ITEMS + 1,
      });
      const page = rows.slice(0, CONVERSATION_PAGE_ITEMS);
      const full = itemsWithFull(deps.dataDir, id);
      return {
        items: page.map((row) => itemDtoOf(row, full.has(row.id))),
        nextAfterSeq: rows.length > CONVERSATION_PAGE_ITEMS ? (page.at(-1)?.seq ?? null) : null,
      };
    },
    conversationLive(id) {
      known(id);
      return engine.live(id);
    },
    postConversationMessage(id, message) {
      const owner = ownerOf(id);
      const posted =
        owner.kind === 'shape'
          ? deps.shape.send(owner.shapeId, message.text)
          : deps.chat.send(id, message);
      return dtoOf(id, posted.id);
    },
    sendConversationNow(id) {
      const owner = ownerOf(id);
      if (owner.kind === 'shape') deps.shape.sendNow(owner.shapeId);
      else engine.sendNow(id);
      return engine.view(id);
    },
    async stopConversation(id) {
      known(id);
      await engine.stop(id);
      return engine.view(id);
    },
    async redoConversation(id, text) {
      const owner = ownerOf(id);
      const edit =
        owner.kind === 'shape'
          ? await deps.shape.redo(owner.shapeId, text)
          : await engine.redo(id, () => deps.chat.post(id, { text, mentions: [], pictures: [] }));
      return dtoOf(id, edit.id);
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
