import type { TaskFileId } from '@10db/contracts';
import type { TaskFileRow } from '@10db/db';
import { tooBigAlone, type PictureLimits } from '../screens';
import { inlineImageIds } from '../shape';

// Workbench spec §6.3: which of a builder message's pictures reach a lane session as image blocks.
// A resumed session resends every block it holds with each request, so the thread has one budget,
// counted as Plan counts a conversation's (Shape spec §5.4), under the account's own limits. A
// picture that does not fit goes as the path the session reads it from.

/**
 * The image bytes the live session holds as blocks: each picture one of its turns was sent inline
 * (`inline_sent`, which a fresh session's start clears), within the account's per-picture caps.
 */
export function threadInlineBytes(files: readonly TaskFileRow[], limits: PictureLimits): number {
  return files.reduce(
    (sum, file) => (file.inlineSent && !tooBigAlone(file, limits) ? sum + file.size : sum),
    0,
  );
}

/**
 * The pictures among `files` that go as image blocks: each within the account's per-picture caps,
 * together within what one message carries, and within what the thread's budget has left after
 * `spent` (`threadInlineBytes`). Every other goes as its path.
 */
export function blockPictures(
  files: readonly TaskFileRow[],
  spent: number,
  limits: PictureLimits,
): Set<TaskFileId> {
  const inline = inlineImageIds(files, spent, limits);
  return new Set(files.filter((file) => inline.has(file.id)).map((file) => file.id));
}
