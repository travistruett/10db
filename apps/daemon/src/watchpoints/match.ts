import type { Watchpoint, WatchpointFileHit, WatchpointHit } from '@10db/contracts';
import { watchpointCovers } from './covers';
import type { LineVerdicts } from './line-verdicts';

/**
 * The watchpoints a change hits: each watchpoint whose globs cover at least one file, with those files, in the order of
 * `watchpoints`. A file under two watchpoints is in both, and a clipped file stays clipped. A watchpoint with line
 * patterns covers a file by the `verdicts` on its changed lines (`watchpointCovers`); with none given no line is cleared.
 * The snapshot keeps what a later edit to the watchpoint must not rewrite.
 */
export function matchWatchpoints(
  files: readonly WatchpointFileHit[],
  watchpoints: readonly Watchpoint[],
  verdicts: LineVerdicts = new Map(),
): WatchpointHit[] {
  return watchpoints.flatMap((watchpoint): WatchpointHit[] => {
    const covered = files.filter((file) => watchpointCovers(watchpoint, file, verdicts));
    if (covered.length === 0) return [];
    const { key, label, why, guidance, loudness } = watchpoint;
    return [{ watchpoint: { key, label, why, guidance, loudness }, files: covered }];
  });
}
