import type { ToolCallHunk } from '@10db/contracts';
import { diffLines } from 'diff';

// Mantine's Diff draws a hunk with `withLineNumbers={false}`, since it would number from 1; the
// gutter beside it numbers each line from the hunk's own starts instead. It splits the same line
// diff the same way Diff does (the `diff` package's `diffLines`, the version Mantine resolves), so
// its rows line up with the drawn ones.

export interface GutterLine {
  readonly kind: 'context' | 'added' | 'removed';
  readonly number: number;
  readonly text: string;
}

/** Each line of `hunk` in the order Diff draws it: context and added lines from `newStart`, removed from `oldStart`. */
export function hunkGutter(hunk: ToolCallHunk): readonly GutterLine[] {
  const out: GutterLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const change of diffLines(hunk.before, hunk.after)) {
    const kind = change.added ? 'added' : change.removed ? 'removed' : 'context';
    const lines = change.value.split('\n');
    // A change ending in a newline splits into one empty string past its last line.
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) {
      const text = line.replace(/\r$/, '');
      if (kind === 'removed') out.push({ kind, number: oldLine++, text });
      else {
        out.push({ kind, number: newLine++, text });
        if (kind === 'context') oldLine += 1;
      }
    }
  }
  return out;
}
