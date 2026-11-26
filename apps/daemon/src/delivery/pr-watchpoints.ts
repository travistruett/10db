import type { WatchpointHitsDto, WorkstreamId } from '@10db/contracts';
import { getWorkstreamRow, listEvidence, type DbReader } from '@10db/db';
import { agentNotesOf, newestWatchpointRow, reviewerNotesOf, withNotes } from '../watchpoints';

/**
 * What a pull request's "For you" section shows: the watchpoints the given runs' newest readings hit, each file
 * with the agent's reason and the reviewer's check. A watchpoint hit by several runs lists its files once, the
 * later run's notes winning.
 */
export function watchpointsOfRuns(
  db: DbReader,
  runs: readonly WorkstreamId[],
): WatchpointHitsDto['hits'] {
  const merged = new Map<string, WatchpointHitsDto['hits'][number]>();
  for (const id of runs) {
    const reading = newestWatchpointRow(listEvidence(db, id));
    if (reading === null) continue;
    const hits = withNotes(reading.detail, {
      agent: agentNotesOf(db, id),
      reviewer: reviewerNotesOf(getWorkstreamRow(db, id).steps),
    });
    for (const hit of hits) {
      const had = merged.get(hit.watchpoint.key);
      const kept = (had?.files ?? []).filter((f) => !hit.files.some((g) => g.path === f.path));
      merged.set(hit.watchpoint.key, {
        watchpoint: hit.watchpoint,
        files: [...kept, ...hit.files],
      });
    }
  }
  return [...merged.values()];
}
