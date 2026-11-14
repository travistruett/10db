import {
  CONVERSATION_PAGE_ITEMS,
  ConflictError,
  ConversationOwnerKind,
  NotFoundError,
  ShapeId,
  ShapeMessageAuthor,
  ShapeMessageKind,
  type ConversationId,
  type ConversationItemDto,
  type ConversationItemId,
} from '@10db/contracts';
import { getConversation, getItem, insertShapeMessage, listItems } from '@10db/db';
import { itemDtoOf, itemsWithFull, readFullOutput, type ExploreEngine } from '../conversation';
import type { ApiServices } from '../api';
import type { StateStore } from '../events';
import type { ShapeService } from '../shape';

// Sessions spec §10: the conversation routes, one set for every explore owner. A message is taken
// by its owner (a Plan conversation's by `shape.send`); a task's thread keeps its own routes (M4c).

export type ConversationApiServices = Pick<
  ApiServices,
  | 'getConversation'
  | 'conversationItems'
  | 'conversationLive'
  | 'postConversationMessage'
  | 'sendConversationNow'
  | 'stopConversation'
  | 'redoConversation'
  | 'conversationFull'
>;

const TASK_THREAD =
  "A task's thread takes the builder's messages on its own routes, so a lane's runner delivers them.";
const NO_CHATS = 'A chat takes messages once Sessions runs chats.';

export function createConversationServices(deps: {
  readonly state: StateStore;
  readonly engine: ExploreEngine;
  readonly shape: Pick<ShapeService, 'send'>;
  readonly dataDir: string;
}): ConversationApiServices {
  const { state, engine } = deps;
  /** The conversation, or NotFoundError; read first by every route. */
  const known = (id: ConversationId) => getConversation(state.db, id);
  const dtoOf = (id: ConversationId, itemId: ConversationItemId): ConversationItemDto =>
    itemDtoOf(getItem(state.db, itemId), itemsWithFull(deps.dataDir, id).has(itemId));
  /** The Plan conversation a message goes to; any other owner takes none here. */
  const shapeOf = (id: ConversationId): ShapeId => {
    const conv = known(id);
    switch (conv.ownerKind) {
      case ConversationOwnerKind.Shape:
        return ShapeId.parse(conv.ownerId);
      case ConversationOwnerKind.Task:
        throw new ConflictError(TASK_THREAD);
      case ConversationOwnerKind.Chat:
        throw new ConflictError(NO_CHATS);
    }
  };
  return {
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
    postConversationMessage(id, text) {
      const message = deps.shape.send(shapeOf(id), text);
      return dtoOf(id, message.id);
    },
    sendConversationNow(id) {
      known(id);
      engine.sendNow(id);
      return engine.view(id);
    },
    async stopConversation(id) {
      known(id);
      await engine.stop(id);
      return engine.view(id);
    },
    async redoConversation(id, text) {
      const shapeId = shapeOf(id);
      const edit = await engine.redo(id, () =>
        getItem(
          state.db,
          state.write((ctx) =>
            insertShapeMessage(ctx, shapeId, {
              author: ShapeMessageAuthor.Builder,
              kind: ShapeMessageKind.Text,
              body: text,
              queued: true,
            }),
          ).id,
        ),
      );
      return dtoOf(id, edit.id);
    },
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
