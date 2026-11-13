import type { ToolCallHunk } from '@10db/contracts';
import { parsePatch, structuredPatch, type StructuredPatchHunk } from 'diff';

/** Lines of context around each change, as `diff -u` gives. */
export const CONTEXT_LINES = 3;
/** The most changed lines (added and removed) an edit's hunks keep. */
export const EDIT_LINES_CAP = 1_500;
/** jsdiff gives up past this edit length, so one edit can't hold the daemon's event loop. */
export const DIFF_MAX_EDIT_LENGTH = 10_000;
/** And past this long. */
export const DIFF_TIMEOUT_MS = 100;

export interface EditHunks {
  readonly hunks: readonly ToolCallHunk[];
  /** Every added line of the edit, kept or not. */
  readonly addedLines: number;
  /** Every removed line of the edit, kept or not. */
  readonly removedLines: number;
  /** Lines were left out: past the cap, or because the texts could not be diffed in time. */
  readonly truncated: boolean;
}

interface RawHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

/** A text's lines; a final newline ends the last line and starts none. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

const isChange = (line: string): boolean => line.startsWith('+') || line.startsWith('-');

/** One hunk's two texts and its counts, from its kept lines; jsdiff's markers appear in neither text. */
function toHunk(raw: RawHunk, lines: readonly string[]): ToolCallHunk {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of lines) {
    const text = line.slice(1);
    if (line.startsWith(' ')) {
      before.push(text);
      after.push(text);
    } else if (line.startsWith('-')) before.push(text);
    else if (line.startsWith('+')) after.push(text);
  }
  return {
    oldStart: raw.oldStart,
    oldLines: before.length,
    newStart: raw.newStart,
    newLines: after.length,
    before: before.join('\n'),
    after: after.join('\n'),
  };
}

/** Keeps the hunks, in order, while their changed lines fit the cap; the hunk that crosses it is cut after its last change within it. */
function capped(raws: readonly RawHunk[], forceTruncated: boolean): EditHunks {
  let addedLines = 0;
  let removedLines = 0;
  for (const raw of raws)
    for (const line of raw.lines) {
      if (line.startsWith('+')) addedLines += 1;
      else if (line.startsWith('-')) removedLines += 1;
    }
  const hunks: ToolCallHunk[] = [];
  let budget = EDIT_LINES_CAP;
  let truncated = forceTruncated;
  for (const raw of raws) {
    const changed = raw.lines.filter(isChange).length;
    if (changed <= budget) {
      hunks.push(toHunk(raw, raw.lines));
      budget -= changed;
      continue;
    }
    truncated = true;
    if (budget > 0) {
      let left = budget;
      let end = 0;
      for (const [index, line] of raw.lines.entries()) {
        if (!isChange(line)) continue;
        left -= 1;
        end = index + 1;
        if (left === 0) break;
      }
      hunks.push(toHunk(raw, raw.lines.slice(0, end)));
    }
    break;
  }
  return { hunks, addedLines, removedLines, truncated };
}

const shifted = (hunk: StructuredPatchHunk, by: number): RawHunk => ({
  oldStart: hunk.oldStart + by,
  oldLines: hunk.oldLines,
  newStart: hunk.newStart + by,
  newLines: hunk.newLines,
  lines: hunk.lines,
});

/**
 * The hunks between two texts; `firstLine` is the file line `before` starts at. Past jsdiff's bounds
 * the whole of `after` shows as added, cut at the cap, and `removedLines` counts `before`'s lines.
 */
export function hunksOfTexts(before: string, after: string, firstLine = 1): EditHunks {
  const patch = structuredPatch('a', 'b', before, after, undefined, undefined, {
    context: CONTEXT_LINES,
    maxEditLength: DIFF_MAX_EDIT_LENGTH,
    timeout: DIFF_TIMEOUT_MS,
  });
  const by = firstLine - 1;
  if (patch !== undefined)
    return capped(
      patch.hunks.map((hunk) => shifted(hunk, by)),
      false,
    );
  const added = splitLines(after);
  const shown = capped(
    added.length === 0
      ? []
      : [
          {
            oldStart: firstLine,
            oldLines: 0,
            newStart: firstLine,
            newLines: added.length,
            lines: added.map((line) => `+${line}`),
          },
        ],
    true,
  );
  return { ...shown, removedLines: splitLines(before).length };
}

/** A line of a unified diff's file header, which no hunk holds. */
const FILE_HEADER =
  /^(diff |index |--- |\+\+\+ |Index: |={3,}$|new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/;

/** Whether a new file's section starts at `at`: a `diff --git` line, or a `---` line with its `+++`. */
function startsFileSection(lines: readonly string[], at: number): boolean {
  const line = lines[at] ?? '';
  return (
    line.startsWith('diff --git ') ||
    (line.startsWith('--- ') && (lines[at + 1] ?? '').startsWith('+++ '))
  );
}

/**
 * Whether every line of the patch is a line of one of `raws`, in order, or a file header line in a
 * header block: before the first hunk, or in a new file's section after one. A parser skips what it
 * doesn't read (lines before the first hunk, lines after a blank one past a hunk), so hunks that
 * leave a line out would show a change the text doesn't stop at.
 */
function accountsForEveryLine(patch: string, raws: readonly RawHunk[]): boolean {
  const lines = splitLines(patch);
  let hunk = 0;
  let inHeader = true;
  for (let at = 0; at < lines.length;) {
    const line = lines[at] ?? '';
    if (line.startsWith('@@ ')) {
      const raw = raws[hunk];
      if (raw === undefined) return false;
      hunk += 1;
      at += 1 + raw.lines.length;
      inHeader = false;
      continue;
    }
    if (!inHeader && startsFileSection(lines, at)) inHeader = true;
    if (!inHeader || !FILE_HEADER.test(line)) return false;
    at += 1;
  }
  return hunk === raws.length;
}

/**
 * The hunks of a unified diff, with or without its file headers; null when it holds no hunk or doesn't
 * parse. When its hunks leave a line of it out, they are marked `truncated`.
 */
export function hunksOfPatch(patch: string): EditHunks | null {
  try {
    const raws = parsePatch(patch).flatMap((file) => file.hunks);
    return raws.length === 0 ? null : capped(raws, !accountsForEveryLine(patch, raws));
  } catch {
    return null;
  }
}
