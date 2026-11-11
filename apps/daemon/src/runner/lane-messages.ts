import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  idOfUuid,
  idUuid,
  TaskMessageAuthor,
  TaskMessageKind,
  type TaskFileId,
  type TaskId,
  type TaskMessageId,
} from '@10db/contracts';
import {
  getTaskMessageRow,
  listTaskFileRows,
  listTaskThreadRows,
  listUndeliveredTaskMessages,
  markTaskFilesInline,
  markTaskMessagePushedUnder,
  markTaskMessagesDelivered,
  markTaskMessagesHandedBack,
  type DbReader,
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
export interface OutgoingMessage {
  readonly text: string;
  readonly images: readonly ShapeImage[];
  readonly uuid: string;
  /** The pictures sent as blocks, which the live session's history now holds. */
  readonly blocks: readonly TaskFileId[];
}

/**
 * The picture as a block, its bytes with the file they were read from, or null when they can no
 * longer be read: it then goes as its path.
 */
function asBlock(file: TaskMessageRow['files'][number]): ShapeImage | null {
  try {
    return {
      mediaType: file.mediaType,
      data: readFileSync(file.storedPath).toString('base64'),
      path: file.storedPath,
    };
  } catch {
    return null;
  }
}

/**
 * The client uuid a push of the message goes under: its row's, the first time it is pushed anywhere,
 * else a new one, since the conversation may already hold the row's (a message handed back is no
 * longer pushed, but went under it).
 */
function clientUuid(message: TaskMessageRow): string {
  return message.pushedAt === null && message.pushUuids.length === 0
    ? idUuid(message.id)
    : randomUUID();
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
  const push = (message: TaskMessageRow, lead?: string | null): void => {
    const spent = threadInlineBytes(listTaskFileRows(state.db, taskId), limits);
    const out = outgoingMessage(message, spent, limits);
    sentUnder.set(out.uuid, message.id);
    // Kept before the session is handed it: a restart then finds every uuid a turn could hold.
    state.write((ctx) => {
      markTaskMessagePushedUnder(ctx, message.id, out.uuid);
      markTaskFilesInline(ctx, taskId, out.blocks, false);
    });
    handle.send(lead ? `${lead}\n\n${out.text}` : out.text, out.images, out.uuid);
  };
  return {
    push,
    pushUntaken(lead) {
      const handed = new Set(sentUnder.values());
      let first = true;
      for (const id of untakenMessages(state.db, taskId)) {
        if (handed.has(id)) continue;
        push(getTaskMessageRow(state.db, id), first ? lead : null);
        first = false;
      }
    },
    consumed(uuids) {
      const ids = messagesOf(uuids);
      if (ids.length === 0) return [];
      return state.write((ctx) => markTaskMessagesDelivered(ctx, taskId, ids));
    },
    handBack(uuids) {
      const ids = messagesOf(uuids);
      const handed = state.write((ctx) => markTaskMessagesHandedBack(ctx, taskId, ids));
      for (const [uuid, id] of [...sentUnder]) if (handed.includes(id)) sentUnder.delete(uuid);
      return handed;
    },
    untaken() {
      const handed = new Set(sentUnder.values());
      return listUndeliveredTaskMessages(state.db, taskId)
        .filter((m) => handed.has(m.id))
        .map((m) => m.id);
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
