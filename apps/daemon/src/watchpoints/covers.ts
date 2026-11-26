import type { Watchpoint, WatchpointFileHit } from '@10db/contracts';
import { WatchpointLoudness } from '@10db/contracts';
import { areaMatches } from '../guard';
import { verdictKey, type LineCheck, type LineVerdicts } from './line-verdicts';

/**
 * Whether `watchpoint` covers `file`: its globs do and, when it has line patterns, one changed line matched.
 * A file not read in full (clipped, a line cut, or no verdict at all) with no matching line is covered by an ask or
 * hold watchpoint, which fails closed so a big change can't slip past one the builder asked to judge; a show
 * watchpoint doesn't count it, or `**` would flag every file of a big change.
 */
export function watchpointCovers(
  watchpoint: Watchpoint,
  file: Pick<WatchpointFileHit, 'path' | 'clipped'>,
  verdicts: LineVerdicts,
): boolean {
  if (!watchpoint.globs.some((glob) => areaMatches(file.path, glob))) return false;
  if (watchpoint.lines.length === 0) return true;
  const verdict = verdicts.get(verdictKey(watchpoint.key, file.path));
  if (verdict?.matched === true) return true;
  if (watchpoint.loudness === WatchpointLoudness.Show) return false;
  return file.clipped || verdict === undefined || verdict.cut;
}

/** The line checks a list of files needs: each line watchpoint against each file its globs cover. */
export function lineChecks(
  files: readonly WatchpointFileHit[],
  watchpoints: readonly Watchpoint[],
): LineCheck[] {
  return watchpoints
    .filter((w) => w.lines.length > 0)
    .flatMap((w) =>
      files
        .filter((file) => w.globs.some((glob) => areaMatches(file.path, glob)))
        .map((file) => ({
          key: w.key,
          path: file.path,
          patterns: w.lines,
          patch: file.patch,
          changed: file.added !== 0 || file.removed !== 0,
        })),
    );
}
