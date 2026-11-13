/** How far from its line, in lines, an excerpt found again counts as moved rather than changed. */
export const ANCHOR_MOVE_WINDOW = 200;

/** Where an anchor's excerpt is in a file's text. */
export interface AnchorLocation {
  result: 'current' | 'moved' | 'changed';
  line: number | null;
}

const linesOf = (text: string): string[] => text.split('\n').map((line) => line.trimEnd());

/**
 * Finds an anchor's excerpt in a file: `current` when every excerpt line equals the file's line from
 * `anchor.line` on (trailing whitespace aside); else `moved` to the nearest match within
 * ANCHOR_MOVE_WINDOW lines, the earlier on a tie; else `changed`.
 */
export function locateAnchor(
  fileText: string,
  anchor: { line: number; excerpt: string },
): AnchorLocation {
  const file = linesOf(fileText);
  const excerpt = linesOf(anchor.excerpt);
  const matchesAt = (line: number): boolean =>
    excerpt.every((text, i) => file[line - 1 + i] === text);
  if (matchesAt(anchor.line)) return { result: 'current', line: anchor.line };
  let best: number | null = null;
  const from = Math.max(1, anchor.line - ANCHOR_MOVE_WINDOW);
  const to = Math.min(file.length, anchor.line + ANCHOR_MOVE_WINDOW);
  for (let line = from; line <= to; line += 1) {
    if (!matchesAt(line)) continue;
    if (best === null || Math.abs(line - anchor.line) < Math.abs(best - anchor.line)) best = line;
  }
  return best === null ? { result: 'changed', line: null } : { result: 'moved', line: best };
}
