import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  idOfUuid,
  idUuid,
  type TaskFileId,
  type TaskId,
  type TaskMessageId,
} from '@10db/contracts';
import {
  listTaskFileRows,
  listUndeliveredTaskMessages,
  markTaskFilesInline,
  markTaskMessagesDelivered,
  markTaskMessagesPushed,
  type TaskMessageRow,
} from '@10db/db';
import type { StateStore } from '../events';
import type { PictureLimits } from '../screens';
import type { SessionHandle, ShapeImage } from '../sessions';
import { builderMessageText } from '../thread';
import { blockPictures, threadInlineBytes } from './thread-pictures';

// Workbench spec §6.3. A builder message is pushed to a lane session under a client uuid, and is
// delivered only when a turn is seen to take it: pushing puts it in a channel in the daemon's memory,
// which a crash loses and a turn that is ending never reads. Its first push goes under the UUID of
// its row's id; any later one goes under a uuid of its own, since Claude Code runs no turn for a
// message under a uuid its transcript already holds (it acknowledges and drops it).

/** A builder message as a session takes it: its text, its pictures that go as blocks, its uuid. */
export interface OutgoingMessage {
  readonly text: string;
  readonly images: readonly ShapeImage[];
  readonly uuid: string;
  /** The pictures sent as blocks, which the live session's history now holds. */
  readonly blocks: readonly TaskFileId[];
}

/** The picture's bytes as a block, or null when they can no longer be read: it then goes as its path. */
function asBlock(file: TaskMessageRow['files'][number]): ShapeImage | null {
  try {
    return { mediaType: file.mediaType, data: readFileSync(file.storedPath).toString('base64') };
  } catch {
    return null;
  }
}

/**
 * The client uuid a push of the message goes under: its row's, the first time it is pushed anywhere,
 * else a new one, since the conversation may already hold the row's.
 */
function clientUuid(message: TaskMessageRow): string {
  return message.pushedAt === null ? idUuid(message.id) : randomUUID();
}

/**
 * The message as the session is sent it: each picture that fits as a block after `spent` bytes the
 * session already holds goes as one, and the others are named by the paths the session reads. A
 * picture the session already holds as a block (`inline_sent`, as when its message is pushed again)
 * goes by its path, so the session never holds a copy the thread's budget does not count.
 */
export function outgoingMessage(
  message: TaskMessageRow,
  spent: number,
  limits: PictureLimits,
): OutgoingMessage {
  const chosen = blockPictures(
    message.files.filter((file) => !file.inlineSent),
    spent,
    limits,
  );
  const blocks = message.files.flatMap((file) => {
    if (!chosen.has(file.id)) return [];
    const image = asBlock(file);
    return image === null ? [] : [{ id: file.id, image }];
  });
  return {
    text: builderMessageText(message, new Set(blocks.map((b) => b.id))),
    images: blocks.map((b) => b.image),
    uuid: clientUuid(message),
    blocks: blocks.map((b) => b.id),
  };
}

/**
 * The messages to push again after an interrupt, among those pushed and not delivered: one the
 * receipt names as still queued (`stillQueued`) runs as the next turn's start; one it does not name
 * may have been lost with the interrupted turn. With no receipt (null), every one is pushed again,
 * which at-least-once delivery allows: the message's id travels in its text.
 */
function pushedAgainAfter(
  undelivered: readonly TaskMessageRow[],
  stillQueued: ReadonlySet<TaskMessageId> | null,
): TaskMessageRow[] {
  if (stillQueued === null) return [...undelivered];
  return undelivered.filter((m) => !stillQueued.has(m.id));
}

export interface LaneMessages {
  /** Hands a builder message to the session, with its pictures, and marks it pushed. */
  push(message: TaskMessageRow): void;
  /** Marks delivered this task's messages among the uuids a turn took; answers those marked now. */
  consumed(uuids: readonly string[]): TaskMessageId[];
  /**
   * Interrupts the running turn, then pushes again each message the interrupt may have lost. A turn
   * may have taken one whose `consumed` event the runner has not read yet when the receipt comes:
   * that message is pushed again, which at-least-once delivery allows, since it goes under its
   * message id, which the session is told names one message, and the event marks it delivered once read.
   */
  interrupt(): Promise<void>;
}

export interface LaneMessagesDeps {
  readonly state: StateStore;
  readonly taskId: TaskId;
  readonly handle: Pick<SessionHandle, 'send' | 'interrupt'>;
  /** The picture limits of the account the session runs on. */
  readonly limits: PictureLimits;
  /** The builder message the session's prompt carried, and the uuid it went under. */
  readonly prompt?: { readonly uuid: string; readonly messageId: TaskMessageId };
}

/** One lane session's side of the task's thread. */
export function createLaneMessages(deps: LaneMessagesDeps): LaneMessages {
  const { state, taskId, handle, limits } = deps;
  /** The message each uuid this session was sent stands for. */
  const sentUnder = new Map<string, TaskMessageId>(
    deps.prompt === undefined ? [] : [[deps.prompt.uuid, deps.prompt.messageId]],
  );
  /** The messages a list of client uuids stands for; a uuid that is no message's stands for none. */
  const messagesOf = (uuids: readonly string[]): TaskMessageId[] =>
    uuids.flatMap((uuid) => {
      const id = sentUnder.get(uuid) ?? idOfUuid('TaskMessage', uuid);
      return id === null ? [] : [id];
    });
  const push = (message: TaskMessageRow): void => {
    const spent = threadInlineBytes(listTaskFileRows(state.db, taskId), limits);
    const out = outgoingMessage(message, spent, limits);
    sentUnder.set(out.uuid, message.id);
    handle.send(out.text, out.images, out.uuid);
    state.write((ctx) => {
      markTaskMessagesPushed(ctx, [message.id]);
      markTaskFilesInline(ctx, taskId, out.blocks, false);
    });
  };
  return {
    push,
    consumed(uuids) {
      const ids = messagesOf(uuids);
      if (ids.length === 0) return [];
      return state.write((ctx) => markTaskMessagesDelivered(ctx, taskId, ids));
    },
    async interrupt() {
      const receipt = await handle.interrupt();
      for (const message of pushedAgainAfter(
        listUndeliveredTaskMessages(state.db, taskId),
        receipt === null ? null : new Set(messagesOf(receipt.stillQueued)),
      ))
        push(message);
    },
  };
}
