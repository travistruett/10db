import type { Watchpoint, WatchpointFileHit, WatchpointHit } from '@10db/contracts';
import { areaMatches } from '../guard';

/**
 * The watchpoints a change hits: each watchpoint whose globs cover at least one file, with those files, in the order of
 * `watchpoints`. A file under two watchpoints is in both, and a clipped file stays clipped. The snapshot keeps what
 * a later edit to the watchpoint must not rewrite.
 */
export function matchWatchpoints(
  files: readonly WatchpointFileHit[],
  watchpoints: readonly Watchpoint[],
): WatchpointHit[] {
  return watchpoints.flatMap((watchpoint): WatchpointHit[] => {
    const covered = files.filter((file) =>
      watchpoint.globs.some((glob) => areaMatches(file.path, glob)),
    );
    if (covered.length === 0) return [];
    const { key, label, why, guidance, loudness } = watchpoint;
    return [{ watchpoint: { key, label, why, guidance, loudness }, files: covered }];
  });
}
