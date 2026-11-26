import type { EvalDriftDto } from '@10db/contracts';
import { siteGap, type CallSite } from './call-sites';

/** What HEAD shows and what the assessed commit showed, as `evalDrift` compares them. */
export interface DriftInput {
  /** The assessed commit. */
  readonly since: string;
  /** Eval files by name at HEAD that no manifest suite links. */
  readonly unlinked: readonly string[];
  /** The files the assessed commit tracked; null when it can't be read (it may be gone). */
  readonly filesThen: ReadonlySet<string> | null;
  /** HEAD's sites no suite covers. */
  readonly uncoveredNow: readonly CallSite[];
  /** Every site the assessed commit's patterns found; null when it can't be read. */
  readonly sitesThen: readonly CallSite[] | null;
  /** What the manifest names that HEAD doesn't track. */
  readonly missingPaths: readonly string[];
}

/** A site by what it says, so a line that only moved, in its file, is the same site. */
const siteKey = (s: CallSite): string => `${s.label}\0${s.path}\0${s.text}`;

/**
 * What changed since the assessment that the manifest doesn't account for: eval files and uncovered call
 * sites that weren't there, and paths it names that are gone. Null when nothing has. A commit that can't be
 * read any more counts every unlinked file as new and no site as new, since neither can be told apart.
 */
export function evalDrift(input: DriftInput): EvalDriftDto | null {
  const newEvalFiles = input.unlinked.filter((p) => input.filesThen?.has(p) !== true);
  const then = new Map<string, number>();
  for (const site of input.sitesThen ?? [])
    then.set(siteKey(site), (then.get(siteKey(site)) ?? 0) + 1);
  const newSites =
    input.sitesThen === null
      ? []
      : input.uncoveredNow.filter((site) => {
          const left = then.get(siteKey(site)) ?? 0;
          if (left === 0) return true;
          then.set(siteKey(site), left - 1);
          return false;
        });
  if (newEvalFiles.length === 0 && newSites.length === 0 && input.missingPaths.length === 0)
    return null;
  return {
    since: input.since,
    newEvalFiles: [...newEvalFiles],
    newGaps: newSites.map(siteGap),
    missingPaths: [...input.missingPaths],
  };
}
