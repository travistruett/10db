import { tooBigAlone } from './inline-budget';
import { inlineImageIds, type FileSize } from './picture-budget';
import type { PictureLimits } from './picture-limits';

/** A file a message carries, as the budget reads it: whether the live session holds it as a block. */
export interface HeldFile extends FileSize {
  readonly inlineSent: boolean;
}

// Workbench spec §6.3: which of a builder message's pictures reach a lane session as image blocks.
// A resumed session resends every block it holds with each request, so a conversation has one budget,
// counted as Plan counts a conversation's (Shape spec §5.4), under the account's own limits. A
// picture that does not fit goes as the path the session reads it from.

/**
 * The image bytes the live session holds as blocks: each picture one of its turns was sent inline
 * (`inline_sent`, which a fresh session's start clears), within the account's per-picture caps.
 */
export function heldInlineBytes(files: readonly HeldFile[], limits: PictureLimits): number {
  return files.reduce(
    (sum, file) => (file.inlineSent && !tooBigAlone(file, limits) ? sum + file.size : sum),
    0,
  );
}

/**
 * The pictures among `files` that go as image blocks: each within the account's per-picture caps,
 * together within what one message carries, and within what the thread's budget has left after
 * `spent` (`heldInlineBytes`). Every other goes as its path.
 */
export function blockPictures<F extends FileSize>(
  files: readonly F[],
  spent: number,
  limits: PictureLimits,
): Set<F['id']> {
  const inline = inlineImageIds(files, spent, limits);
  return new Set(files.filter((file) => inline.has(file.id)).map((file) => file.id));
}
