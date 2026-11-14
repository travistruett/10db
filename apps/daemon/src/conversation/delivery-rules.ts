import { readFileSync } from 'node:fs';
import {
  idUuid,
  TaskPictureKind,
  type ConversationFileId,
  type ConversationItemId,
} from '@10db/contracts';
import type { ShapeImage } from '../sessions';
import { blockPictures } from './block-pictures';
import type { PictureLimits } from './picture-limits';

// Sessions spec §6.2, Workbench spec §6.3. The pure delivery rules every conversation's builder
// messages follow, whoever owns the conversation. A message is pushed under a client uuid kept before
// the session is handed it, the first time under its own id's, delivered only when a turn lists that
// uuid, pushed again after an interrupt that may have lost it, and, after a restart, read back from the
// agent's own conversation where it can be.

export interface DeliverableFile {
  readonly id: ConversationFileId;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly storedPath: string;
  /** Whether the live session's history holds it as an image block. */
  readonly inlineSent: boolean;
}

export interface DeliverableMessage {
  readonly id: ConversationItemId;
  readonly body: string;
  readonly pushedAt: string | null;
  readonly pushUuids: readonly string[];
  readonly files: readonly DeliverableFile[];
}

/** The owner's words for a message: its text, with the pictures in `asBlocks` attached as blocks. */
export type MessageText = (
  message: DeliverableMessage,
  asBlocks: ReadonlySet<ConversationFileId>,
) => string;

/** A builder message as a session takes it: its text, its pictures that go as blocks, its uuid. */
export interface OutgoingMessage {
  readonly text: string;
  readonly images: readonly ShapeImage[];
  readonly uuid: string;
  /** The pictures sent as blocks, which the live session's history now holds. */
  readonly blocks: readonly ConversationFileId[];
}

/**
 * The client uuid a push of the message goes under: its own id's, the first time it is
 * pushed anywhere, else a fresh one, since the conversation may already hold its own (a message handed
 * back is no longer pushed, but went under it).
 */
export function clientUuid(
  message: Pick<DeliverableMessage, 'id' | 'pushedAt' | 'pushUuids'>,
  fresh: () => string,
): string {
  return message.pushedAt === null && message.pushUuids.length === 0 ? idUuid(message.id) : fresh();
}

/**
 * The messages to push again after an interrupt, among those pushed and not delivered: one
 * the receipt names as still queued runs as the next turn's start; one it does not name may have been
 * lost with the interrupted turn. With no receipt (null), every one is pushed again, which
 * at-least-once delivery allows: the message's id travels in its text.
 */
export function pushedAgainAfter<M extends { readonly id: ConversationItemId }>(
  undelivered: readonly M[],
  stillQueued: ReadonlySet<ConversationItemId> | null,
): M[] {
  if (stillQueued === null) return [...undelivered];
  return undelivered.filter((m) => !stillQueued.has(m.id));
}

/**
 * The picture as a block, its bytes with the file they were read from, or null when it is no picture
 * a block may carry or its bytes can no longer be read: it then goes as its path.
 */
function asBlock(file: DeliverableFile): ShapeImage | null {
  const kind = TaskPictureKind.safeParse(file.mediaType);
  if (!kind.success) return null;
  try {
    return {
      mediaType: kind.data,
      data: readFileSync(file.storedPath).toString('base64'),
      path: file.storedPath,
    };
  } catch {
    return null;
  }
}

/**
 * The message as the session is sent it: each picture that fits as a block after `spent` bytes the
 * session already holds goes as one, and the others are named by the paths the session reads. A
 * picture the session already holds as a block goes by its path, so the session never holds a copy
 * the budget does not count. An agent that reads each picture from its file (`readsPictureFiles`,
 * Codex) is sent every one so.
 */
export function outgoingMessage(
  message: DeliverableMessage,
  spent: number,
  limits: PictureLimits,
  readsPictureFiles: boolean,
  text: MessageText,
  fresh: () => string,
): OutgoingMessage {
  const chosen = readsPictureFiles
    ? new Set(message.files.map((file) => file.id))
    : blockPictures(
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
    text: text(message, new Set(blocks.map((b) => b.id))),
    images: blocks.map((b) => b.image),
    uuid: clientUuid(message, fresh),
    blocks: blocks.map((b) => b.id),
  };
}

/** What rule 5 asks the agent's own conversation after a restart. */
export interface ReadBackAsk {
  /** Every uuid a message in doubt went under. */
  readonly wanted: readonly string[];
  /** When the oldest of them was written: the agent's conversation is read from there. */
  readonly since: string;
}

/**
 * Rule 5's ask over the messages pushed and never seen taken, oldest first: the uuids each went under,
 * since the oldest pushed one was written; null when none went under a uuid, so nothing is asked.
 */
export function readBackAsk(
  inDoubt: readonly { readonly pushUuids: readonly string[]; readonly createdAt: string }[],
): ReadBackAsk | null {
  const pushed = inDoubt.filter((m) => m.pushUuids.length > 0);
  const [oldest] = pushed;
  if (oldest === undefined) return null;
  return { wanted: pushed.flatMap((m) => m.pushUuids), since: oldest.createdAt };
}
