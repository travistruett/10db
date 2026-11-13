import { randomUUID } from 'node:crypto';
import type { ConversationId, ConversationItemId } from '@10db/contracts';
import {
  findItemByPushUuid,
  getMessageRow,
  listFiles,
  listUndeliveredMessages,
  listUntakenMessageIds,
  markFilesInline,
  markItemPushedUnder,
  markItemsDelivered,
  markItemsHandedBack,
} from '@10db/db';
import type { StateStore } from '../events';
import type { SessionHandle } from '../sessions';
import { heldInlineBytes } from './block-pictures';
import {
  outgoingMessage,
  pushedAgainAfter,
  type DeliverableMessage,
  type MessageText,
} from './delivery-rules';
import type { PictureLimits } from './picture-limits';

// Sessions spec §6.2: one live session's side of a conversation's builder messages, by the delivery
// rules, over the conversation tables. Pushing puts a message in a channel in the daemon's memory,
// which a crash loses and a turn that is ending never reads, so a message is delivered only when a
// turn is seen to take it.

export interface Delivery {
  /** Hands the session a builder message and marks it pushed; `lead` goes ahead of its text. */
  push(message: DeliverableMessage, lead?: string | null): void;
  /**
   * Hands the session, in order, every builder message of the conversation no turn has taken that it
   * was not handed yet; `lead` goes ahead of the first.
   */
  pushUntaken(lead?: string | null): void;
  /** Marks delivered the messages among the uuids a turn took; answers those marked now. */
  consumed(uuids: readonly string[]): ConversationItemId[];
  /** Interrupts the running turn, then pushes again each message the interrupt may have lost. */
  interrupt(): Promise<void>;
  /** The builder messages this session was handed that no turn has taken, in order. */
  untaken(): ConversationItemId[];
  /**
   * Hands back to 10db's queue the messages among the uuids the session dropped without a turn taking
   * them: they are no longer pushed, keep their uuids, and the session no longer holds them.
   */
  handBack(uuids: readonly string[]): ConversationItemId[];
}

export interface DeliveryDeps {
  readonly state: StateStore;
  /** The conversation, read at each call: a lane can start before its task has one. */
  readonly conversation: () => ConversationId | null;
  readonly handle: Pick<SessionHandle, 'send' | 'interrupt'>;
  /** The picture limits of the account the session runs on. */
  readonly limits: PictureLimits;
  /** The builder message the session's prompt carried, and the uuid it went under. */
  readonly prompt?: { readonly uuid: string; readonly messageId: ConversationItemId };
  /** The agent reads each picture from its stored file (Codex), so every picture goes so. */
  readonly readsPictureFiles?: boolean;
  /** The owner's words for a message. */
  readonly messageText: MessageText;
}

export function createDelivery(deps: DeliveryDeps): Delivery {
  const { state, handle, limits } = deps;
  /** The message each uuid this session was sent stands for. */
  const sentUnder = new Map<string, ConversationItemId>(
    deps.prompt === undefined ? [] : [[deps.prompt.uuid, deps.prompt.messageId]],
  );
  /** The messages a list of client uuids stands for; a uuid that is no message's stands for none. */
  const messagesOf = (conversation: ConversationId, uuids: readonly string[]) =>
    uuids.flatMap((uuid) => {
      const id = sentUnder.get(uuid) ?? findItemByPushUuid(state.db, conversation, uuid);
      return id === null ? [] : [id];
    });
  const push = (message: DeliverableMessage, lead?: string | null): void => {
    const conversation = deps.conversation();
    const spent =
      conversation === null ? 0 : heldInlineBytes(listFiles(state.db, conversation), limits);
    const out = outgoingMessage(
      message,
      spent,
      limits,
      deps.readsPictureFiles === true,
      deps.messageText,
      randomUUID,
    );
    sentUnder.set(out.uuid, message.id);
    // Kept before the session is handed it: a restart then finds every uuid a turn could hold.
    state.write((ctx) => {
      markItemPushedUnder(ctx, message.id, out.uuid);
      if (conversation !== null) markFilesInline(ctx, conversation, out.blocks, false);
    });
    handle.send(lead ? `${lead}\n\n${out.text}` : out.text, out.images, out.uuid);
  };
  return {
    push,
    pushUntaken(lead) {
      const conversation = deps.conversation();
      if (conversation === null) return;
      const handed = new Set(sentUnder.values());
      let first = true;
      for (const id of listUntakenMessageIds(state.db, conversation)) {
        if (handed.has(id)) continue;
        push(getMessageRow(state.db, id), first ? lead : null);
        first = false;
      }
    },
    consumed(uuids) {
      const conversation = deps.conversation();
      if (conversation === null) return [];
      const ids = messagesOf(conversation, uuids);
      if (ids.length === 0) return [];
      return state.write((ctx) => markItemsDelivered(ctx, conversation, ids));
    },
    handBack(uuids) {
      const conversation = deps.conversation();
      if (conversation === null) return [];
      const ids = messagesOf(conversation, uuids);
      const handed = state.write((ctx) => markItemsHandedBack(ctx, conversation, ids));
      for (const [uuid, id] of [...sentUnder]) if (handed.includes(id)) sentUnder.delete(uuid);
      return handed;
    },
    untaken() {
      const conversation = deps.conversation();
      if (conversation === null) return [];
      const handed = new Set(sentUnder.values());
      return listUndeliveredMessages(state.db, conversation)
        .filter((m) => handed.has(m.id))
        .map((m) => m.id);
    },
    async interrupt() {
      const receipt = await handle.interrupt();
      const conversation = deps.conversation();
      if (conversation === null) return;
      for (const message of pushedAgainAfter(
        listUndeliveredMessages(state.db, conversation),
        receipt === null ? null : new Set(messagesOf(conversation, receipt.stillQueued)),
      ))
        push(message);
    },
  };
}
