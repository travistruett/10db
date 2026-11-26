import type { Watchpoint, WatchpointFileHit, WatchpointHit } from '@10db/contracts';
import { classifyDefinitionChange, definitionHit } from '../evals';
import { watchpointCovers } from './covers';
import type { WatchpointHitSource } from './hits-after';

/** The starter that watches evals; a definition file no watchpoint's globs cover is shown under it. */
const EVALS_WATCHPOINT_KEY = 'evals';

/**
 * A hit source for the files that define an eval suite (`suiteOf` maps a definition path to its suite's key): each
 * one is a hit on the watchpoints whose globs cover it, or on the Evals starter when none does, carrying what
 * its patch did to the definition. Read on the file list alone (no patch yet) it answers which files to read.
 */
export function evalDefinitionSource(suiteOf: ReadonlyMap<string, string>): WatchpointHitSource {
  return (files, watchpoints, verdicts): WatchpointHit[] => {
    const defined = files.flatMap((file): WatchpointFileHit[] => {
      const suiteKey = suiteOf.get(file.path);
      if (suiteKey === undefined) return [];
      const changes = classifyDefinitionChange(file.path, file.patch);
      return [{ ...file, evalDefinition: definitionHit(suiteKey, changes, file.clipped) }];
    });
    if (defined.length === 0) return [];
    return watchpoints.flatMap((watchpoint): WatchpointHit[] => {
      const covered = defined.filter((file) => watchpointCovers(watchpoint, file, verdicts));
      // The Evals starter also takes the definition files no watchpoint covers.
      const own =
        watchpoint.key === EVALS_WATCHPOINT_KEY
          ? defined.filter(
              (file) =>
                watchpointCovers(watchpoint, file, verdicts) ||
                !watchpoints.some((w) => watchpointCovers(w, file, verdicts)),
            )
          : covered;
      return own.length === 0 ? [] : [{ watchpoint: snapshot(watchpoint), files: own }];
    });
  };
}

function snapshot(w: Watchpoint): WatchpointHit['watchpoint'] {
  const { key, label, why, guidance, loudness } = w;
  return { key, label, why, guidance, loudness };
}
