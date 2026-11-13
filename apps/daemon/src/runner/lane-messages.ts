import { randomUUID } from 'node:crypto';
import {
  TaskMessageAuthor,
  TaskMessageKind,
  type TaskId,
  type TaskMessageId,
} from '@10db/contracts';
import {
  listTaskThreadRows,
  taskConversationOf,
  type DbReader,
  type TaskMessageRow,
} from '@10db/db';
import {
  createDelivery,
  outgoingMessage as deliveryOutgoing,
  type OutgoingMessage as DeliveryOutgoingMessage,
  type PictureLimits,
} from '../conversation';
import type { StateStore } from '../events';
import type { SessionHandle } from '../sessions';
import { builderMessageText } from '../thread';

// Workbench spec §6.3. A builder message is pushed to a lane session under a client uuid, and is
// delivered only when a turn is seen to take it: pushing puts it in a channel in the daemon's memory,
// which a crash loses and a turn that is ending never reads. Its first push goes under the UUID of
// its row's id; any later one goes under a uuid of its own, since Claude Code runs no turn for a
// message under a uuid its transcript already holds (it acknowledges and drops it).

/**
 * The task's builder messages no turn has taken, pushed to a session or not, oldest first: while there
 * is one, the builder is waiting for the agent.
 */
export function untakenMessages(reader: DbReader, taskId: TaskId): TaskMessageId[] {
  return listTaskThreadRows(reader, taskId)
    .filter(
      (m) =>
        m.author === TaskMessageAuthor.Builder &&
        m.kind === TaskMessageKind.Message &&
        m.deliveredAt === null,
    )
    .map((m) => m.id);
}

/** A builder message as a session takes it: its text, its pictures that go as blocks, its uuid. */
export type OutgoingMessage = DeliveryOutgoingMessage;

/**
 * The message as the session is sent it, in the thread's words: each picture that fits as a block
 * after `spent` bytes the session already holds goes as one, and the others are named by their paths
 * (the conversation library's `outgoingMessage`).
 */
export function outgoingMessage(
  message: TaskMessageRow,
  spent: number,
  limits: PictureLimits,
  readsPictureFiles = false,
): OutgoingMessage {
  return deliveryOutgoing(
    message,
    spent,
    limits,
    readsPictureFiles,
    builderMessageText,
    randomUUID,
  );
}

export interface LaneMessages {
  /**
   * Hands a builder message to the session, with its pictures, and marks it pushed; `lead` goes
   * ahead of the message's text, as a note on the builder's hand edits does.
   */
  push(message: TaskMessageRow, lead?: string | null): void;
  /**
   * Hands the session, oldest first, every builder message of the task no turn has taken that it
   * was not handed yet; `lead` goes ahead of the first.
   */
  pushUntaken(lead?: string | null): void;
  /** Marks delivered this task's messages among the uuids a turn took; answers those marked now. */
  consumed(uuids: readonly string[]): TaskMessageId[];
  /**
   * Interrupts the running turn, then pushes again each message the interrupt may have lost. A turn
   * may have taken one whose `consumed` event the runner has not read yet when the receipt comes:
   * that message is pushed again, which at-least-once delivery allows, since it goes under its
   * message id, which the session is told names one message, and the event marks it delivered once read.
   */
  interrupt(): Promise<void>;
  /** The builder messages this session was handed that no turn has taken, oldest first. */
  untaken(): TaskMessageId[];
  /**
   * Hands back to 10db's queue the messages among the uuids the session dropped without a turn
   * taking them: they are no longer pushed, keep their uuids, and the session is no longer counted
   * as holding them. Answers those handed back.
   */
  handBack(uuids: readonly string[]): TaskMessageId[];
}

export interface LaneMessagesDeps {
  readonly state: StateStore;
  readonly taskId: TaskId;
  readonly handle: Pick<SessionHandle, 'send' | 'interrupt'>;
  /** The picture limits of the account the session runs on. */
  readonly limits: PictureLimits;
  /** The builder message the session's prompt carried, and the uuid it went under. */
  readonly prompt?: { readonly uuid: string; readonly messageId: TaskMessageId };
  /**
   * The agent reads each picture from its stored file (Codex), and its lane can open none by its
   * path, so every push sends every picture of the message so, whatever the budget or an earlier send.
   */
  readonly readsPictureFiles?: boolean;
}

/** One lane session's side of the task's thread: the conversation library over its thread. */
export function createLaneMessages(deps: LaneMessagesDeps): LaneMessages {
  const { state, taskId } = deps;
  return createDelivery({
    state,
    conversation: () => taskConversationOf(state.db, taskId)?.id ?? null,
    handle: deps.handle,
    limits: deps.limits,
    ...(deps.prompt === undefined ? {} : { prompt: deps.prompt }),
    ...(deps.readsPictureFiles === undefined ? {} : { readsPictureFiles: deps.readsPictureFiles }),
    messageText: builderMessageText,
  });
}
