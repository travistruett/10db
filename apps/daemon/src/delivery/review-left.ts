import type { PassId } from '@10db/contracts';
import {
  deleteAppSetting,
  getAppSetting,
  setAppSetting,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';
import type { Git } from '../git';

// Workbench spec §8.3, D21: the one review reads at most so much of a pass's diff. What a review cut
// short did not read is kept by pass, so the next review reads on from there, beside the new
// commits, until all of it has been read.

const key = (passId: PassId): string => `pass_review_left.${passId}`;

/** One read of a diff, as `Git.diffSince` answers it. */
export type DiffSince = Awaited<ReturnType<Git['diffSince']>>;

/** What the pass's reviews have not read yet. */
const ReviewLeft = z.object({
  /** Where the unread changes start: the diff from here to the tip, on `files`, is still to read. */
  from: z.string().min(1),
  files: z.array(z.string()),
  /** Files whose diff is longer than a review reads: read as far as it goes, the rest never. */
  partial: z.array(z.string()),
});
export type ReviewLeft = z.infer<typeof ReviewLeft>;

/** What the pass's reviews have left unread, or null when they read all of it. */
export function reviewLeft(db: DbReader, passId: PassId): ReviewLeft | null {
  // Read from the database: parsed, as at every boundary.
  const stored = ReviewLeft.safeParse(getAppSetting(db, key(passId)));
  return stored.success ? stored.data : null;
}

/** Whether a review of the pass still has files to read, at the same tip too. */
export function reviewHasUnread(db: DbReader, passId: PassId): boolean {
  return (reviewLeft(db, passId)?.files.length ?? 0) > 0;
}

export function setReviewLeft(w: WriteContext, passId: PassId, left: ReviewLeft | null): void {
  if (left === null) deleteAppSetting(w, key(passId));
  else setAppSetting(w, key(passId), { ...left });
}

/** How many files the diff text shows, the last one maybe cut. */
const shown = (part: DiffSince): number => part.diff.match(/^diff --git /gm)?.length ?? 0;

/**
 * The files of `part` the review read whole: all of them unless it was cut, else each before the
 * one the cut fell in. Its text lists the files in the order of its counts.
 */
export function readWhole(part: DiffSince): string[] {
  const paths = part.files.map((f) => f.path);
  return part.truncated ? paths.slice(0, Math.max(0, shown(part) - 1)) : paths;
}

/** The file the cut of `part` fell in, or null when it was not cut or showed no file. */
export function cutIn(part: DiffSince): string | null {
  if (!part.truncated) return null;
  return part.files[shown(part) - 1]?.path ?? null;
}
