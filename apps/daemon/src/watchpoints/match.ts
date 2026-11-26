import {
  WatchpointLoudness,
  type Watchpoint,
  type WatchpointFileHit,
  type WatchpointHit,
} from '@10db/contracts';
import { areaMatches } from '../guard';
import { changedLines } from './changed-lines';

/**
 * The watchpoints a change hits: each watchpoint whose globs cover at least one file, with those files, in the order of
 * `watchpoints`. A file under two watchpoints is in both, and a clipped file stays clipped. A watchpoint with line
 * patterns covers a file only when one of the file's changed lines matches, judged on the text that was read. A
 * clipped file with no matching line in that text is covered only by an ask or hold watchpoint: it can't be
 * shown clear, and a watchpoint the builder asked to judge fails closed, while a show one would flag every file of a
 * big change. The snapshot keeps what a later edit to the watchpoint must not rewrite.
 */
export function matchWatchpoints(
  files: readonly WatchpointFileHit[],
  watchpoints: readonly Watchpoint[],
): WatchpointHit[] {
  return watchpoints.flatMap((watchpoint): WatchpointHit[] => {
    const patterns = watchpoint.lines.map((source) => new RegExp(source, 'i'));
    const covered = files.filter(
      (file) =>
        watchpoint.globs.some((glob) => areaMatches(file.path, glob)) &&
        (patterns.length === 0 ||
          (file.clipped && watchpoint.loudness !== WatchpointLoudness.Show) ||
          changedLines(file.patch).some((line) => patterns.some((p) => p.test(line)))),
    );
    if (covered.length === 0) return [];
    const { key, label, why, guidance, loudness } = watchpoint;
    return [{ watchpoint: { key, label, why, guidance, loudness }, files: covered }];
  });
}

/**
 * The glob-covered paths of the watchpoints that have line patterns: the files whose text must be read before
 * those watchpoints can be matched.
 */
export function lineCandidates(
  files: readonly WatchpointFileHit[],
  watchpoints: readonly Watchpoint[],
): string[] {
  const withLines = watchpoints.filter((w) => w.lines.length > 0);
  return files
    .filter((file) => withLines.some((w) => w.globs.some((glob) => areaMatches(file.path, glob))))
    .map((file) => file.path);
}
