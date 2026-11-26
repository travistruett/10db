import {
  WATCHPOINT_FILE_PATCH_BYTES,
  WATCHPOINT_LINE_SCAN_BYTES,
  WatchpointLoudness,
  WATCHPOINT_ROW_PATCH_BYTES,
  WatchpointFileStatus,
  type Watchpoint,
  type WatchpointDetail,
  type WatchpointFileHit,
  type WatchpointHit,
  type WatchpointShadow,
} from '@10db/contracts';
import { lineChecks, questionCandidates, type QuestionCandidates } from './covers';
import { readLineVerdicts } from './line-reading';
import { verdictKey, type LineCheck, type LineVerdict, type LineVerdicts } from './line-verdicts';
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

/**
 * A way of finding hits: the file list of the change, the watchpoints in force and the verdicts on their line
 * patterns, answering the hits it sees.
 */
export type WatchpointHitSource = (
  files: readonly WatchpointFileHit[],
  watchpoints: readonly Watchpoint[],
  verdicts: LineVerdicts,
) => WatchpointHit[];

/** The glob matcher; a run adds the eval definition source (`evalDefinitionSource`) to it. */
export const WATCHPOINT_HIT_SOURCES: readonly WatchpointHitSource[] = [matchWatchpoints];

/** Every source's hits, joined by watchpoint in the order of `watchpoints`, a file once per watchpoint. */
function joined(
  sources: readonly WatchpointHitSource[],
  files: readonly WatchpointFileHit[],
  watchpoints: readonly Watchpoint[],
  verdicts: LineVerdicts,
): WatchpointHit[] {
  const byKey = new Map<string, WatchpointHit>();
  for (const hit of sources.flatMap((source) => source(files, watchpoints, verdicts))) {
    const had = byKey.get(hit.watchpoint.key);
    if (had === undefined) byKey.set(hit.watchpoint.key, hit);
    else {
      // A file both sources found keeps the eval source's account of it.
      const read = new Map(hit.files.map((f) => [f.path, f]));
      const seen = new Set(had.files.map((f) => f.path));
      byKey.set(hit.watchpoint.key, {
        ...had,
        files: [
          ...had.files.map((f) => (f.evalDefinition === undefined ? (read.get(f.path) ?? f) : f)),
          ...hit.files.filter((f) => !seen.has(f.path)),
        ],
      });
    }
  }
  return watchpoints.flatMap((watchpoint) => byKey.get(watchpoint.key) ?? []);
}

/** The listed files with the text of those that were read. */
function withSections(
  listed: readonly WatchpointFileHit[],
  sections: ReadonlyMap<string, PatchSection>,
): WatchpointFileHit[] {
  return listed.map((file) => {
    const section = sections.get(file.path);
    return section === undefined
      ? file
      : { ...file, status: section.status, patch: section.patch, clipped: section.clipped };
  });
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
 * A watchpoint with line patterns is judged on the text of the files its globs cover, read once within
 * `WATCHPOINT_LINE_SCAN_BYTES`; a file of an ask or hold watchpoint that the scan didn't reach or cut is read again at its
 * own cap, and stays a hit, clipped, if it still can't be cleared. The patterns run in a worker under a deadline
 * (`readLines`); when it fails nothing is cleared and `onLinesUnread` names the watchpoints. Which files are hits is
 * decided on that text alone; the hunks read afterwards only fill in each hit's patch. The files each question
 * watchpoint's rules left open go to `ask` last, and its answers are kept as `shadow`, never as hits.
 * A change git can't read is the caller's to turn into a row with `skipped` set.
 */
export async function watchpointHitsAfter(input: {
  readonly watchpoints: readonly Watchpoint[];
  readonly head: string;
  readonly read: WatchpointChangeReader;
  readonly sources?: readonly WatchpointHitSource[];
  readonly readLines?: (checks: readonly LineCheck[]) => Promise<LineVerdicts | null>;
  readonly onLinesUnread?: (keys: readonly string[]) => void;
  readonly ask?: (
    candidates: readonly QuestionCandidates[],
  ) => Promise<readonly WatchpointShadow[]>;
}): Promise<WatchpointDetail> {
  const sources = input.sources ?? WATCHPOINT_HIT_SOURCES;
  const readLines = input.readLines ?? readLineVerdicts;
  const counts = await input.read(null, 0);
  const listed: WatchpointFileHit[] = counts.files.map((f) => ({
    path: f.path,
    status: WatchpointFileStatus.Modified,
    added: f.added,
    removed: f.removed,
    patch: '',
    clipped: true,
  }));
  const sections = new Map<string, PatchSection>();
  const splitOf = (changes: Awaited<ReturnType<WatchpointChangeReader>>) =>
    splitPatch(changes.diff, {
      fileBytes: WATCHPOINT_FILE_PATCH_BYTES,
      diffCut: changes.truncated,
    });
  // A watchpoint with line patterns needs the text of the files its globs cover: read once, within the scan budget.
  const candidates = new Set(lineChecks(listed, input.watchpoints).map((c) => c.path));
  if (candidates.size > 0) {
    const scan = await input.read([...candidates], WATCHPOINT_LINE_SCAN_BYTES);
    const split = splitOf(scan);
    for (const [path, section] of split) sections.set(path, section);
    // A file the scan didn't reach, or the one it cut, can't be cleared: an ask or hold watchpoint reads it again.
    const cutPath = scan.truncated ? [...split.keys()].pop() : undefined;
    const asking = new Set(
      lineChecks(
        listed,
        input.watchpoints.filter((w) => w.loudness !== WatchpointLoudness.Show),
      ).map((c) => c.path),
    );
    let reread = 0;
    for (const path of asking) {
      if (reread >= WATCHPOINT_ROW_PATCH_BYTES) break;
      if (sections.has(path) && path !== cutPath) continue;
      const found = splitOf(await input.read([path], WATCHPOINT_FILE_PATCH_BYTES + 1024)).get(path);
      if (found === undefined) continue;
      sections.set(path, found);
      reread += Buffer.byteLength(found.patch, 'utf8');
    }
  }
  const read = withSections(listed, sections);
  // A file with no text read has no verdict: an ask or hold watchpoint can't clear it.
  const verdicts = new Map<string, LineVerdict>();
  const verdictsFor = async (paths: ReadonlySet<string>): Promise<void> => {
    const checks = lineChecks(withSections(listed, sections), input.watchpoints).filter((c) =>
      paths.has(c.path),
    );
    if (checks.length === 0) return;
    const answered = await readLines(checks);
    if (answered === null) input.onLinesUnread?.([...new Set(checks.map((c) => c.key))]);
    else for (const [key, verdict] of answered) verdicts.set(key, verdict);
  };
  await verdictsFor(new Set(sections.keys()));
  // Which files are hits is decided here; the hunks read below never drop one.
  const first = joined(sources, read, input.watchpoints, verdicts);
  const matched = new Set(first.flatMap((hit) => hit.files.map((f) => f.path)));
  // The questions are asked once the rules are done: a file a line settled is a hit, and is not asked about.
  const withShadow = async (detail: WatchpointDetail): Promise<WatchpointDetail> => {
    const candidates = questionCandidates(listed, input.watchpoints, verdicts);
    if (input.ask === undefined || candidates.length === 0) return detail;
    const shadow = await input.ask(candidates);
    return shadow.length === 0 ? detail : { ...detail, shadow: [...shadow] };
  };
  if (matched.size === 0) return withShadow({ hits: [], head: input.head, skipped: null });
  // Each file is read at its own cap, so one huge file cannot starve the files after it; reading stops
  // once the row's budget is spent, and the rest keep their counts, clipped. A file already read is not read again.
  let spent = 0;
  const newlyRead = new Set<string>();
  for (const path of matched) {
    if (spent >= WATCHPOINT_ROW_PATCH_BYTES) break;
    let section = sections.get(path);
    if (section === undefined) {
      section = splitOf(await input.read([path], WATCHPOINT_FILE_PATCH_BYTES + 1024)).get(path);
      if (section === undefined) continue;
      sections.set(path, section);
      newlyRead.add(path);
    }
    spent += Buffer.byteLength(section.patch, 'utf8');
  }
  // A file first read now is judged on that text, which can only add to what it was held for.
  await verdictsFor(newlyRead);
  // The sources run again on the files with their hunks only to classify an eval definition on its patch.
  const definitions = new Map(
    joined(sources, withSections(listed, sections), input.watchpoints, verdicts).flatMap((hit) =>
      hit.files.flatMap((f) =>
        f.evalDefinition === undefined ? [] : [[f.path, f.evalDefinition] as const],
      ),
    ),
  );
  const lined = new Set(input.watchpoints.filter((w) => w.lines.length > 0).map((w) => w.key));
  const final = first.map((hit) => ({
    ...hit,
    files: withSections(hit.files, sections).map((f): WatchpointFileHit => {
      const evalDefinition = definitions.get(f.path) ?? f.evalDefinition;
      // A file a line watchpoint holds without a matching line is held for what could not be read: it says so.
      const held =
        lined.has(hit.watchpoint.key) &&
        verdicts.get(verdictKey(hit.watchpoint.key, f.path))?.matched !== true;
      const out = held ? { ...f, clipped: true } : f;
      return evalDefinition === undefined ? out : { ...out, evalDefinition };
    }),
  }));
  return withShadow({ hits: withinRowBudget(final), head: input.head, skipped: null });
}
