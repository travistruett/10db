import type { Watchpoint, WatchpointFileHit } from '@10db/contracts';
import { WatchpointLoudness } from '@10db/contracts';
import { areaMatches } from '../guard';
import { verdictKey, type LineCheck, type LineVerdicts } from './line-verdicts';

/**
 * Whether `watchpoint` covers `file`: its globs do and, when it has line patterns, one changed line matched. A
 * watchpoint with a question and no line patterns covers nothing: its question is the judge's, and a rule hit comes
 * only through globs plus lines.
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
  if (watchpoint.lines.length === 0) return watchpoint.question === null;
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

/** A question watchpoint's question and the files it is asked about. */
export interface QuestionCandidates {
  readonly key: string;
  readonly label: string;
  readonly question: string;
  readonly paths: readonly string[];
}

/**
 * The files each question watchpoint asks the judge about: those its globs cover that no line pattern settled (a
 * matched line makes the file a hit, so it needs no question), in the order of `watchpoints`. A watchpoint with no
 * such file is left out.
 */
export function questionCandidates(
  files: readonly WatchpointFileHit[],
  watchpoints: readonly Watchpoint[],
  verdicts: LineVerdicts,
): QuestionCandidates[] {
  return watchpoints.flatMap((w): QuestionCandidates[] => {
    if (w.question === null) return [];
    const paths = files
      .filter((file) => w.globs.some((glob) => areaMatches(file.path, glob)))
      .filter(
        (file) =>
          w.lines.length === 0 || verdicts.get(verdictKey(w.key, file.path))?.matched !== true,
      )
      .map((file) => file.path);
    return paths.length === 0 ? [] : [{ key: w.key, label: w.label, question: w.question, paths }];
  });
}
