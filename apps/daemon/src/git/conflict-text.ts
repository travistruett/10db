/** What `resolveAddedLines` made of a file git left with conflict markers. */
export type TextResolution =
  | { readonly kind: 'resolved'; readonly text: string }
  | { readonly kind: 'unresolved'; readonly reason: string };

const OURS = /^<{7}( |$)/;
const BASE = /^\|{7}( |$)/;
const MIDDLE = /^={7}$/;
const THEIRS = /^>{7}( |$)/;

const unresolved = (reason: string): TextResolution => ({ kind: 'unresolved', reason });

/** Why `resolveAddedLines` leaves a hunk where the ancestor had lines: a choice, which markers show. */
export const BOTH_CHANGED = 'both sides changed the same lines';

/** True when `text` has a line that opens a conflict and a line that closes one. */
export function hasConflictMarkers(text: string): boolean {
  const lines = text.split(/\r?\n/);
  return lines.some((line) => OURS.test(line)) && lines.some((line) => THEIRS.test(line));
}

const indentOf = (line: string): string => /^\s*/.exec(line)?.[0] ?? '';

/**
 * `theirs` without the lines `ours` also added, when both sides added a flat list: every line
 * non-blank and at one indentation (import names, enum members, array entries), where a line
 * written twice is a duplicate (`TS2300` for an import). Added blocks (a function on each side)
 * are left whole, since their shared lines (`}`, `return x;`) belong to their own block.
 */
function withoutShared(ours: readonly string[], theirs: readonly string[]): string[] {
  const lines = [...ours, ...theirs];
  const flat =
    lines.every((line) => line.trim() !== '') &&
    lines.every((line) => indentOf(line) === indentOf(lines[0] ?? ''));
  if (!flat) return [...theirs];
  const added = new Set(ours);
  return theirs.filter((line) => !added.has(line));
}

/**
 * Reads a file git merged with `merge.conflictStyle=diff3` and resolves it when every conflict is
 * two sides adding lines at the same place, where the common ancestor has none there: both sides'
 * lines stay, ours first, and a line of a flat list that both sides added stays once. A conflict where either side changed or deleted a line the ancestor had
 * is a choice between two versions, and stays unresolved, as does a file whose markers don't show
 * the ancestor or aren't well formed (a file that holds markers of its own).
 */
export function resolveAddedLines(text: string): TextResolution {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  const out: string[] = [];
  let hunks = 0;
  let side: 'text' | 'ours' | 'base' | 'theirs' = 'text';
  let ours: string[] = [];
  let theirs: string[] = [];
  let base = 0;
  for (const line of lines) {
    switch (side) {
      case 'text':
        if (OURS.test(line)) {
          side = 'ours';
          ours = [];
          theirs = [];
          base = 0;
        } else if (BASE.test(line) || MIDDLE.test(line) || THEIRS.test(line)) {
          return unresolved('the file has conflict markers git did not write');
        } else out.push(line);
        break;
      case 'ours':
        if (BASE.test(line)) side = 'base';
        else if (MIDDLE.test(line))
          return unresolved("git's conflict markers don't show the common ancestor");
        else if (OURS.test(line) || THEIRS.test(line))
          return unresolved('the file has conflict markers git did not write');
        else ours.push(line);
        break;
      case 'base':
        if (MIDDLE.test(line)) side = 'theirs';
        else if (OURS.test(line) || BASE.test(line) || THEIRS.test(line))
          return unresolved('the file has conflict markers git did not write');
        else base += 1;
        break;
      case 'theirs':
        if (THEIRS.test(line)) {
          if (base > 0) return unresolved(BOTH_CHANGED);
          out.push(...ours, ...withoutShared(ours, theirs));
          hunks += 1;
          side = 'text';
        } else if (OURS.test(line) || BASE.test(line) || MIDDLE.test(line))
          return unresolved('the file has conflict markers git did not write');
        else theirs.push(line);
        break;
    }
  }
  if (side !== 'text') return unresolved('a conflict in the file is not closed');
  if (hunks === 0) return unresolved('git reported a conflict but left no markers in the file');
  return { kind: 'resolved', text: out.join(eol) };
}
