import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isShapeImage, shapeFileKind, type ShapeId } from '@10db/contracts';
import { listShapeFiles } from '@10db/db';
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
 * tool result this budget can't see, so the 6 MB is not a promise that such pictures fit.
 */
export const INLINE_CONVERSATION_MAX_BYTES = 18 * MIB;

export const isImageName = (name: string): boolean => {
  const kind = shapeFileKind(name);
  return kind !== null && isShapeImage(kind);
};

const keptScreenBytes = (dir: string): number => {
  try {
    return readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
};

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
 * The image bytes a conversation has already spent: every screen it keeps and every dropped image a turn
 * of the live session sent as a block (`shape_files.inline_sent`, which a fresh session clears). Images
 * that went as paths are not charged. `filesRoot` is the data directory's `shapes` folder.
 */
export function inlineBytesSpent(state: StateStore, filesRoot: string, shapeId: ShapeId): number {
  const sent = listShapeFiles(state.db, shapeId).reduce(
    (sum, file) =>
      file.inlineSent && isImageName(file.name) && !tooBigAlone(file) ? sum + file.size : sum,
    0,
  );
  return sent + keptScreenBytes(join(filesRoot, shapeId, 'screens'));
}
