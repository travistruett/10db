import {
  WATCHPOINT_FILE_PATCH_BYTES,
  WATCHPOINT_ROW_PATCH_BYTES,
  WatchpointFileStatus,
  type Watchpoint,
  type WatchpointDetail,
  type WatchpointFileHit,
  type WatchpointHit,
} from '@10db/contracts';
import { matchWatchpoints } from './match';
import { splitPatch, type PatchSection } from './split-patch';

/** What a diff read answers: the whole change's counts, and the patch text of the files asked for. */
export interface WatchpointChanges {
  readonly diff: string;
  readonly truncated: boolean;
  readonly files: readonly {
    readonly path: string;
    readonly added: number | null;
    readonly removed: number | null;
  }[];
}

/**
 * Reads the run's change. `only` null reads every file's counts and no text (a zero-byte cap is passed);
 * a list reads those files' patches, up to `maxBytes`.
 */
export type WatchpointChangeReader = (
  only: readonly string[] | null,
  maxBytes: number,
) => Promise<WatchpointChanges>;

/** A way of finding hits: the file list of the change and the watchpoints in force, answering the hits it sees. */
export type WatchpointHitSource = (
  files: readonly WatchpointFileHit[],
  watchpoints: readonly Watchpoint[],
) => WatchpointHit[];

/** The glob matcher, the one source in use. The Evals session's classified events join it as another. */
export const WATCHPOINT_HIT_SOURCES: readonly WatchpointHitSource[] = [matchWatchpoints];

/** Every source's hits, joined by watchpoint in the order of `watchpoints`, a file once per watchpoint. */
function joined(
  sources: readonly WatchpointHitSource[],
  files: readonly WatchpointFileHit[],
  watchpoints: readonly Watchpoint[],
): WatchpointHit[] {
  const byKey = new Map<string, WatchpointHit>();
  for (const hit of sources.flatMap((source) => source(files, watchpoints))) {
    const had = byKey.get(hit.watchpoint.key);
    if (had === undefined) byKey.set(hit.watchpoint.key, hit);
    else {
      const seen = new Set(had.files.map((f) => f.path));
      byKey.set(hit.watchpoint.key, {
        ...had,
        files: [...had.files, ...hit.files.filter((f) => !seen.has(f.path))],
      });
    }
  }
  return watchpoints.flatMap((watchpoint) => byKey.get(watchpoint.key) ?? []);
}

/** Past the row's patch budget a file keeps its counts and says it was clipped. */
function withinRowBudget(hits: readonly WatchpointHit[]): WatchpointHit[] {
  let left = WATCHPOINT_ROW_PATCH_BYTES;
  return hits.map((hit) => ({
    ...hit,
    files: hit.files.map((file) => {
      const size = Buffer.byteLength(file.patch, 'utf8');
      if (size <= left) {
        left -= size;
        return file;
      }
      return { ...file, patch: '', clipped: true };
    }),
  }));
}

/**
 * What the watchpoints make of a run's change, read after its gate passed. The file list is the whole change's
 * counts, so a watchpoint file past any cap is still matched; only the matched files' hunks are read, each
 * cut at `WATCHPOINT_FILE_PATCH_BYTES`, and a file whose hunks the read did not reach is kept with `clipped`.
 * A change git can't read is the caller's to turn into a row with `skipped` set.
 */
export async function watchpointHitsAfter(input: {
  readonly watchpoints: readonly Watchpoint[];
  readonly head: string;
  readonly read: WatchpointChangeReader;
  readonly sources?: readonly WatchpointHitSource[];
}): Promise<WatchpointDetail> {
  const sources = input.sources ?? WATCHPOINT_HIT_SOURCES;
  const counts = await input.read(null, 0);
  const listed: WatchpointFileHit[] = counts.files.map((f) => ({
    path: f.path,
    status: WatchpointFileStatus.Modified,
    added: f.added,
    removed: f.removed,
    patch: '',
    clipped: true,
  }));
  const matched = new Set(
    joined(sources, listed, input.watchpoints).flatMap((hit) => hit.files.map((f) => f.path)),
  );
  if (matched.size === 0) return { hits: [], head: input.head, skipped: null };
  // Each file is read at its own cap, so one huge file cannot starve the files after it; reading stops
  // once the row's budget is spent, and the rest keep their counts, clipped.
  const sections = new Map<string, PatchSection>();
  let spent = 0;
  for (const path of matched) {
    if (spent >= WATCHPOINT_ROW_PATCH_BYTES) break;
    const changes = await input.read([path], WATCHPOINT_FILE_PATCH_BYTES + 1024);
    const found = splitPatch(changes.diff, {
      fileBytes: WATCHPOINT_FILE_PATCH_BYTES,
      diffCut: changes.truncated,
    }).get(path);
    if (found === undefined) continue;
    sections.set(path, found);
    spent += Buffer.byteLength(found.patch, 'utf8');
  }
  const files = listed.map((file): WatchpointFileHit => {
    const section = sections.get(file.path);
    return section === undefined
      ? file
      : { ...file, status: section.status, patch: section.patch, clipped: section.clipped };
  });
  return {
    hits: withinRowBudget(joined(sources, files, input.watchpoints)),
    head: input.head,
    skipped: null,
  };
}
