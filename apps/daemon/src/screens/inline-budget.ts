import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  isShapeImage,
  ScreenMessageBody,
  shapeFileKind,
  ShapeMessageKind,
  type ShapeId,
  type ShapeMessageDto,
} from '@10db/contracts';
import { listShapeFiles, listShapeMessages } from '@10db/db';
import type { StateStore } from '../events';
import { readImageSize } from './image-check';

// Shape spec §5.4. A resumed session resends every earlier image with each request, whether it arrived in
// a message or as a see_screen result, so dropped images and screens share one budget.

const MIB = 1024 * 1024;

/** The largest image sent as a content block: 2 MiB is under 3 MB as base64. */
const INLINE_IMAGE_MAX_BYTES = 2 * MIB;

/**
 * The longest side of an image sent as a content block. The API takes at most 2000 px a side when a
 * request holds more than 20 images, and a conversation's screens (12) and dropped images (20) can pass
 * that together, so a request that failed on it would fail every later turn too. Claude Code is not
 * known to shrink an image block, so a larger one goes as a path, which `Read` resizes.
 */
const INLINE_IMAGE_MAX_SIDE = 2000;

/**
 * The most image bytes a whole conversation carries, dropped images and screens together. Base64 grows
 * them by 4/3: 18 MiB raw is 24 MiB (about 25 MB) on the wire, which leaves the API's 32 MB request limit
 * about 6 MB. Twelve screens at their 1.5 MB most fit inside it. A picture Claude pulls in with `Read` is a
 * tool result this budget can't see; the Shape hook counts those (`shape/read-budget.ts`), and they draw on
 * one pool with these (`PICTURE_POOL_BYTES`), so Reads past their reserve take from this budget.
 */
export const INLINE_CONVERSATION_MAX_BYTES = 18 * MIB;

/**
 * What pictures and PDF pages Claude pulls in with `Read` may add on top of a full inline budget: 3 MiB is
 * 4.2 MB as base64, so 25.2 MB of inline pictures plus it is near 29.4 MB, which leaves 2.6 MB of the 32 MB
 * for text. The two share one pool of their sum: Reads may use whatever the inline pictures leave of it, and
 * an inline picture may use whatever the Reads leave, so a conversation that has spent little of one can
 * spend more of the other and the sum still stays under the limit.
 */
export const READ_RESERVE_BYTES = 3 * MIB;

/** The pool inline pictures and Read pictures and PDFs draw on together. */
export const PICTURE_POOL_BYTES = INLINE_CONVERSATION_MAX_BYTES + READ_RESERVE_BYTES;

/** The transcript line that starts a session with nothing to resume and no digest to say so. */
export const FRESH_START_LINE = 'Session · started fresh';

/**
 * The transcript the live session carries: what follows the latest digest, or the latest fresh-start line,
 * whichever is later. A digest row is written when a session starts from one (§5.5); a session that
 * lost its predecessor before Claude spoke has no digest, so `start` writes the fresh-start line instead.
 */
export function liveMessages(messages: readonly ShapeMessageDto[]): readonly ShapeMessageDto[] {
  const start =
    messages.findLastIndex(
      (m) =>
        m.kind === ShapeMessageKind.Digest ||
        (m.kind === ShapeMessageKind.Tool && m.body === FRESH_START_LINE),
    ) + 1;
  return messages.slice(start);
}

export type ReadKind = 'picture' | 'PDF';

/** The dimmed transcript line that records a counted Read; `readBytesSpent` reads it back. */
export const readCountedLine = (path: string, charge: number, kind: ReadKind = 'picture'): string =>
  `Read · ${path} · ${kind} · ${String(charge)} bytes counted`;

/** The line that replaces a Read's counted charge with the bytes it was measured to return. */
export const readMeasuredLine = (
  path: string,
  measured: number,
  counted: number,
  kind: ReadKind = 'picture',
): string =>
  `Read · ${path} · ${kind} · ${String(measured)} bytes measured in place of ${String(counted)}`;

const COUNTED = /^Read · .* · (?:picture|PDF) · (\d+) bytes counted$/s;
const MEASURED = /^Read · .* · (?:picture|PDF) · (\d+) bytes measured in place of (\d+)$/s;

/**
 * The bytes of Read pictures and PDF pages the live session carries, from its counted lines: a measured
 * line stands in for the count before it. A restart resumes the session with all of them, so they come
 * from the transcript, not from memory.
 */
export function readBytesSpent(messages: readonly ShapeMessageDto[]): number {
  const total = liveMessages(messages).reduce((sum, message) => {
    if (message.kind !== ShapeMessageKind.Tool) return sum;
    const counted = COUNTED.exec(message.body)?.[1];
    if (counted !== undefined) return sum + Number(counted);
    const measured = MEASURED.exec(message.body);
    return measured === null ? sum : sum + Number(measured[1]) - Number(measured[2]);
  }, 0);
  return Math.max(0, total);
}

export const isImageName = (name: string): boolean => {
  const kind = shapeFileKind(name);
  return kind !== null && isShapeImage(kind);
};

/** What a Screen message's body says, or null for a body that isn't one. */
export function parseScreenBody(body: string): ScreenMessageBody | null {
  try {
    const parsed = ScreenMessageBody.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const keptScreenBytes = (path: string): number => {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
};

/**
 * The bytes of the screens the live session took. A session started from a digest carries no earlier
 * picture (§5.5), and the digest's own row marks where it began, so a restart loses nothing.
 */
function liveScreenBytes(
  messages: readonly ShapeMessageDto[],
  filesRoot: string,
  shapeId: ShapeId,
): number {
  return liveMessages(messages).reduce((sum, message) => {
    if (message.kind !== ShapeMessageKind.Screen) return sum;
    const name = parseScreenBody(message.body)?.name;
    return name === undefined
      ? sum
      : sum + keptScreenBytes(join(filesRoot, shapeId, 'screens', name));
  }, 0);
}

/**
 * Whether the stored image is within the side cap. One whose size can't be read (cut short, or not
 * what its name says) is not: it would be sent blind, and a model refusing it ends every turn.
 */
function withinSideCap(storedPath: string): boolean {
  try {
    const size = readImageSize(readFileSync(storedPath));
    return size !== null && Math.max(size.width, size.height) <= INLINE_IMAGE_MAX_SIDE;
  } catch {
    return false;
  }
}

/**
 * An image too big, in bytes or in pixels, to be a content block on its own. The one rule for what goes
 * inline and what is charged for it, so the two can't disagree.
 */
export const tooBigAlone = (file: {
  readonly size: number;
  readonly storedPath: string;
}): boolean => file.size > INLINE_IMAGE_MAX_BYTES || !withinSideCap(file.storedPath);

/**
 * The image bytes the daemon itself sent that the live session carries: every screen it took and every
 * dropped image one of its turns sent as a block (`shape_files.inline_sent`, which a fresh session
 * clears). Images that went as paths, and pictures of an earlier session, are not charged. `filesRoot` is
 * the data directory's `shapes` folder.
 */
export function inlinePictureBytes(state: StateStore, filesRoot: string, shapeId: ShapeId): number {
  const sent = listShapeFiles(state.db, shapeId).reduce(
    (sum, file) =>
      file.inlineSent && isImageName(file.name) && !tooBigAlone(file) ? sum + file.size : sum,
    0,
  );
  return sent + liveScreenBytes(listShapeMessages(state.db, shapeId), filesRoot, shapeId);
}

/**
 * What an inline picture is charged against `INLINE_CONVERSATION_MAX_BYTES`: the inline pictures the live
 * session carries, and the Read pictures beyond their reserve, which took room the pool would have given
 * an inline one.
 */
export function inlineBytesSpent(state: StateStore, filesRoot: string, shapeId: ShapeId): number {
  const reads = readBytesSpent(listShapeMessages(state.db, shapeId));
  return inlinePictureBytes(state, filesRoot, shapeId) + Math.max(0, reads - READ_RESERVE_BYTES);
}
