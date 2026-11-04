import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isShapeImage, shapeFileKind, type ShapeId } from '@10db/contracts';
import { listShapeFiles } from '@10db/db';
import type { StateStore } from '../events';

// Shape spec §5.4. A resumed session resends every earlier image with each request, whether it arrived in
// a message or as a see_screen result, so dropped images and screens share one budget.

const MIB = 1024 * 1024;

/** The largest image sent as a content block: 2 MiB is under 3 MB as base64. */
export const INLINE_IMAGE_MAX_BYTES = 2 * MIB;

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
 * The image bytes a conversation has already spent: every screen it keeps and every image Claude was told
 * of within the per-image cap. Which told images went as blocks depends on how they were batched into
 * turns, and a fresh session drops what came before it, so this is an upper bound, never an undercount.
 * `filesRoot` is the data directory's `shapes` folder.
 */
export function inlineBytesSpent(state: StateStore, filesRoot: string, shapeId: ShapeId): number {
  const told = listShapeFiles(state.db, shapeId).reduce(
    (sum, file) =>
      file.toldAt !== null && isImageName(file.name) && file.size <= INLINE_IMAGE_MAX_BYTES
        ? sum + file.size
        : sum,
    0,
  );
  return told + keptScreenBytes(join(filesRoot, shapeId, 'screens'));
}
