import {
  MAX_COVERAGE_EXAMPLES,
  STARTER_WATCHPOINTS,
  WatchpointCoverageState,
  type ProjectId,
  type Watchpoint,
  type WatchpointCoverage,
} from '@10db/contracts';
import { areaMatches } from '../guard';
import type { Git } from '../git';
import type { Logger } from '../log';
import { readLineVerdicts } from './line-reading';
import { verdictKey, type LineCheck, type LineVerdicts } from './line-verdicts';

export const coverageSignature = (w: Pick<Watchpoint, 'globs' | 'lines'>): string =>
  JSON.stringify([w.globs, w.lines]);
const signature = coverageSignature;

/**
 * Bounds on reading files' text for line patterns: the most files one watchpoint may cover, the most files and
 * bytes read in all (each file once, however many watchpoints cover it), the most bytes of one file, and the files
 * and bytes asked of git at once. A watchpoint the bounds leave unread is `unreadable`, never counted low.
 */
const MAX_LINE_FILES = 10_000;
const MAX_TOTAL_FILES = 20_000;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const READ_BATCH_FILES = 500;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
/** How long git may take to read the files' text for one count. */
const READ_DEADLINE_MS = 20_000;
/** How many of a project's recent HEADs keep their counts, and how long the background count waits for quiet. */
const KEPT_HEADS = 3;
const SCHEDULE_MS = 2000;

type Coverage = Pick<WatchpointCoverage, 'files' | 'examples' | 'state'> & { partial?: boolean };

/** Whether the watchpoint only asks the judge a question, so its count says what it asks about. */
const asksOnly = (w: Pick<Watchpoint, 'question' | 'lines'>): boolean =>
  w.question !== null && w.lines.length === 0;
const NONE: Coverage = { files: 0, examples: [], state: WatchpointCoverageState.Unreadable };

/**
 * The tracked files a watchpoint covers: those its globs match and, when it has line patterns, one line of the
 * file's whole text matches (`verdicts` are keyed by `coverageSignature`, so two watchpoints with one key but
 * different lines never share one). A matched line proves coverage, cut or not. A file with no verdict was left
 * out for being large or binary and doesn't count; a file with a cut line and no match might still hold one past
 * the cut, so `incomplete` is set and the count is a floor.
 */
export function coverageOf(
  watchpoint: Pick<Watchpoint, 'globs' | 'lines'>,
  tracked: readonly string[],
  verdicts: LineVerdicts,
): { files: number; examples: string[]; incomplete: boolean } {
  const covered = tracked.filter((path) =>
    watchpoint.globs.some((glob) => areaMatches(path, glob)),
  );
  if (watchpoint.lines.length === 0)
    return {
      files: covered.length,
      examples: covered.slice(0, MAX_COVERAGE_EXAMPLES),
      incomplete: false,
    };
  const sig = signature(watchpoint);
  const counted = covered.filter((path) => verdicts.get(verdictKey(sig, path))?.matched === true);
  const incomplete = covered.some((path) => {
    const verdict = verdicts.get(verdictKey(sig, path));
    return verdict !== undefined && !verdict.matched && verdict.cut;
  });
  return {
    files: counted.length,
    examples: counted.slice(0, MAX_COVERAGE_EXAMPLES),
    incomplete,
  };
}

/**
 * The watchpoints to count: those that apply, then the builder's own that a project turned off (so a row shows its own
 * count, not a starter's), then each starter no list holds by key.
 */
export function coverageSubjects(
  applying: readonly Watchpoint[],
  yours: readonly Watchpoint[] = [],
): Watchpoint[] {
  const held = new Set(applying.map((w) => w.key));
  const off = yours.filter((w) => !held.has(w.key));
  for (const w of off) held.add(w.key);
  return [...applying, ...off, ...STARTER_WATCHPOINTS.filter((w) => !held.has(w.key))];
}

/**
 * One answer from several projects, an entry for each of `subjects`: files summed, examples joined. It is `counting`
 * while any project is, `unreadable` when any is (a sum missing a project would read low), else `counted`; with no
 * project it is counted at none.
 */
export function sumCoverage(
  lists: readonly (readonly WatchpointCoverage[])[],
  subjects: readonly Pick<Watchpoint, 'key' | 'question' | 'lines'>[],
): WatchpointCoverage[] {
  return subjects.map((w) => {
    const entries = lists.flatMap((list) => list.filter((e) => e.key === w.key));
    return {
      key: w.key,
      files: entries.reduce((n, e) => n + e.files, 0),
      repoFiles: entries.reduce((n, e) => n + e.repoFiles, 0),
      examples: entries.flatMap((e) => e.examples).slice(0, MAX_COVERAGE_EXAMPLES),
      asks: asksOnly(w),
      partial: entries.some((e) => e.partial),
      state: entries.some((e) => e.state === WatchpointCoverageState.Counting)
        ? WatchpointCoverageState.Counting
        : entries.some((e) => e.state === WatchpointCoverageState.Unreadable)
          ? WatchpointCoverageState.Unreadable
          : WatchpointCoverageState.Counted,
    };
  });
}

/** A file's whole text as an all-added patch, so the line worker that scans diffs scans it unchanged. */
function wholeFilePatch(text: string): string {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return `diff --git a/f b/f\n@@ -0,0 +1,${String(lines.length)} @@\n${lines.map((l) => `+${l}`).join('\n')}`;
}

interface HeadCounts {
  readonly repoFiles: number;
  readonly done: Map<string, Coverage>;
  readonly pending: Map<string, Promise<void>>;
}

interface Checkout {
  readonly id: ProjectId;
  readonly repoPath: string;
}

export interface WatchpointCoverageReader {
  /**
   * The coverage of each of `watchpoints` in the project's checkout at HEAD. A count already made is answered from
   * memory; one still being made (started by a request, or by `schedule`) is joined and answers `counting`.
   */
  read(project: Checkout, watchpoints: readonly Watchpoint[]): Promise<WatchpointCoverage[]>;
  /** Counts the project's watchpoints soon, in the background; calls close together make one. */
  schedule(projectId: ProjectId): void;
  /** Cancels what is waiting to run. */
  stop(): void;
}

export interface WatchpointCoverageDeps {
  readonly git: Pick<Git, 'survey' | 'commitAt' | 'surveyTexts'>;
  /** What a background count covers for the project: the watchpoints that apply and the builder's own. Null when it is gone. */
  readonly subjects: (
    projectId: ProjectId,
  ) => { project: Checkout; watchpoints: Watchpoint[] } | null;
  /** Told when a count that was being made lands, so a page that showed `counting` asks again. */
  readonly landed: (projectId: ProjectId) => void;
  readonly logger: Pick<Logger, 'warn'>;
  readonly scheduleMs?: number;
}

/**
 * Counts, from a project's checkout and with no model, the files each watchpoint covers. Globs count at once from
 * the tracked-file list. Line patterns read every covered file's text, which runs in the line worker under its
 * deadline and in the background. Each count is kept in memory per project, HEAD (the last few) and the
 * watchpoint's globs and lines, so editing a watchpoint counts only that one again, and concurrent asks for the same
 * count share one run.
 */
export function createWatchpointCoverage(deps: WatchpointCoverageDeps): WatchpointCoverageReader {
  const heads = new Map<ProjectId, Map<string, HeadCounts>>();
  const waiting = new Map<ProjectId, NodeJS.Timeout>();
  let stopped = false;

  async function countLines(
    repoPath: string,
    tracked: readonly string[],
    lineWatchpoints: readonly Watchpoint[],
  ): Promise<Map<string, Coverage>> {
    const unreadable = new Map(lineWatchpoints.map((w) => [signature(w), NONE]));
    const covering = new Map(
      lineWatchpoints.map((w) => [
        signature(w),
        tracked.filter((path) => w.globs.some((g) => areaMatches(path, g))),
      ]),
    );
    // A watchpoint over more files than the bound is not read at all: a partial count would read as a low one.
    const readable = lineWatchpoints.filter(
      (w) => (covering.get(signature(w))?.length ?? 0) <= MAX_LINE_FILES,
    );
    // Each file is read once, whichever watchpoints cover it.
    const candidates = [...new Set(readable.flatMap((w) => covering.get(signature(w)) ?? []))];
    const signal = AbortSignal.timeout(READ_DEADLINE_MS);
    const texts = new Map<string, string>();
    const unread = new Set<string>();
    let bytes = 0;
    for (let at = 0; at < candidates.length; at += READ_BATCH_FILES) {
      const batch = candidates.slice(at, at + READ_BATCH_FILES);
      if (at + batch.length > MAX_TOTAL_FILES || bytes >= MAX_TOTAL_BYTES) {
        for (const path of batch) unread.add(path);
        continue;
      }
      const read = await deps.git.surveyTexts(repoPath, batch, {
        maxBytes: MAX_FILE_BYTES,
        maxTotalBytes: Math.min(MAX_BATCH_BYTES, MAX_TOTAL_BYTES - bytes),
        signal,
      });
      // A refused batch (a partial clone, or more bytes than the budget left) was not read, as opposed to a
      // file left out for being binary or large, which is read and does not match.
      if (read.refused !== null) for (const path of batch) unread.add(path);
      bytes += read.bytes;
      for (const [path, text] of read.texts) texts.set(path, text);
    }
    const whole = new Map(
      readable
        .filter((w) => !(covering.get(signature(w)) ?? []).some((path) => unread.has(path)))
        .map((w) => [signature(w), w]),
    );
    const patches = new Map([...texts].map(([path, text]) => [path, wholeFilePatch(text)]));
    // The patches replace the texts, so the file text is held once.
    texts.clear();
    // Checks are keyed by the watchpoint's signature: two with one key and different lines never share a verdict.
    const checks: LineCheck[] = [...whole.entries()].flatMap(([sig, w]) =>
      [...patches]
        .filter(([path]) => w.globs.some((g) => areaMatches(path, g)))
        .map(([path, patch]) => ({ key: sig, path, patterns: w.lines, patch, changed: true })),
    );
    const verdicts = await readLineVerdicts(checks);
    if (verdicts === null) return unreadable;
    return new Map(
      lineWatchpoints.map((w) => {
        if (!whole.has(signature(w))) return [signature(w), NONE];
        const { incomplete, ...counted } = coverageOf(w, tracked, verdicts);
        // A file with a cut line and no match may hold one past the cut: the count is a floor, never a plain number.
        return [
          signature(w),
          { ...counted, state: WatchpointCoverageState.Counted, partial: incomplete },
        ];
      }),
    );
  }

  /** Tells the pages a count landed; a failure is logged, never thrown, since nothing awaits it. */
  function announce(projectId: ProjectId): void {
    if (stopped) return;
    try {
      deps.landed(projectId);
    } catch (error) {
      deps.logger.warn(
        { projectId, err: error instanceof Error ? error.message : String(error) },
        'could not announce a watchpoint count',
      );
    }
  }

  /** The counts held for the project's HEAD, starting the line counts nothing holds or is making yet. */
  async function ensure(
    project: Checkout,
    watchpoints: readonly Watchpoint[],
  ): Promise<HeadCounts | 'unreadable' | 'empty'> {
    // HEAD is named once; the file list and texts are read after it and dropped if HEAD moved meanwhile.
    let commit: string;
    try {
      commit = await deps.git.commitAt(project.repoPath, 'HEAD');
    } catch {
      // No HEAD: an empty repository holds no file, but a missing folder or a failed read is not that.
      const survey = await deps.git.survey(project.repoPath, 0).catch(() => null);
      return survey !== null && !('refused' in survey) && survey.files.length === 0
        ? 'empty'
        : 'unreadable';
    }
    const survey = await deps.git.survey(project.repoPath, 0);
    if ('refused' in survey) return 'unreadable';
    const moved = async (): Promise<boolean> =>
      (await deps.git.commitAt(project.repoPath, 'HEAD').catch(() => null)) !== commit;
    if (await moved()) return ensure(project, watchpoints);
    const byHead = heads.get(project.id) ?? new Map<string, HeadCounts>();
    heads.set(project.id, byHead);
    const held = byHead.get(commit) ?? {
      repoFiles: survey.files.length,
      done: new Map(),
      pending: new Map(),
    };
    // Re-inserted last, so the oldest HEAD is the one dropped.
    byHead.delete(commit);
    byHead.set(commit, held);
    for (const oldest of [...byHead.keys()].slice(0, Math.max(0, byHead.size - KEPT_HEADS)))
      byHead.delete(oldest);
    for (const w of watchpoints) {
      if (w.lines.length === 0 && !held.done.has(signature(w))) {
        const { files, examples } = coverageOf(w, survey.files, new Map());
        held.done.set(signature(w), { files, examples, state: WatchpointCoverageState.Counted });
      }
    }
    const fresh = [
      ...new Map(
        watchpoints
          .filter(
            (w) =>
              w.lines.length > 0 && !held.done.has(signature(w)) && !held.pending.has(signature(w)),
          )
          .map((w) => [signature(w), w]),
      ).values(),
    ];
    if (fresh.length > 0) {
      const job = countLines(project.repoPath, survey.files, fresh)
        .catch((error: unknown) => {
          deps.logger.warn(
            {
              projectId: project.id,
              err: error instanceof Error ? error.message : String(error),
            },
            'a watchpoint count failed',
          );
          return new Map(fresh.map((w) => [signature(w), NONE]));
        })
        .then(async (results) => {
          // Counts read while HEAD moved belong to no HEAD held here: leave them out and say so, so the page asks again.
          if (!(await moved())) for (const [sig, result] of results) held.done.set(sig, result);
          // Pending clears only after the counts are stored, so a read in between joins this job.
          for (const w of fresh) held.pending.delete(signature(w));
          announce(project.id);
        })
        .catch((error: unknown) => {
          deps.logger.warn(
            {
              projectId: project.id,
              err: error instanceof Error ? error.message : String(error),
            },
            'a watchpoint count could not be kept',
          );
        });
      for (const w of fresh) held.pending.set(signature(w), job);
    }
    return held;
  }

  return {
    async read(project, watchpoints) {
      const answer = (of: (w: Watchpoint) => Coverage, repoFiles = 0): WatchpointCoverage[] =>
        watchpoints.map((w) => ({
          key: w.key,
          ...of(w),
          partial: of(w).partial ?? false,
          asks: asksOnly(w),
          repoFiles,
        }));
      const held = await ensure(project, watchpoints);
      if (held === 'unreadable') return answer(() => NONE);
      if (held === 'empty')
        return answer(() => ({ files: 0, examples: [], state: WatchpointCoverageState.Counted }));
      return answer(
        (w) =>
          held.done.get(signature(w)) ?? {
            files: 0,
            examples: [],
            state: WatchpointCoverageState.Counting,
          },
        held.repoFiles,
      );
    },
    schedule(projectId) {
      if (stopped) return;
      const pending = waiting.get(projectId);
      if (pending !== undefined) clearTimeout(pending);
      waiting.set(
        projectId,
        setTimeout(() => {
          waiting.delete(projectId);
          const subject = deps.subjects(projectId);
          if (subject === null) return;
          ensure(subject.project, subject.watchpoints).catch((error: unknown) => {
            deps.logger.warn(
              { projectId, err: error instanceof Error ? error.message : String(error) },
              'a background watchpoint count failed',
            );
          });
        }, deps.scheduleMs ?? SCHEDULE_MS),
      );
    },
    stop() {
      stopped = true;
      for (const timer of waiting.values()) clearTimeout(timer);
      waiting.clear();
    },
  };
}
