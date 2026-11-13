// Whether a text is drawn as markdown or shown as plain text. The markdown parser and its plugins
// recurse over the tree, so a document nested deeper than MARKDOWN_MAX_DEPTH exhausts the call stack
// or runs for seconds first, and one longer than MARKDOWN_MAX_LENGTH holds the window while it draws.
// This scan is linear in the text and never recurses. A text it passes that the parser still can't
// draw falls to `MarkdownBoundary`, which shows it plain.

/** The longest text drawn as markdown, in UTF-16 code units; a longer one shows whole as plain text. */
export const MARKDOWN_MAX_LENGTH = 512 * 1024;

/** The deepest nesting drawn: block quotes and lists, plus emphasis open at once, on any line. */
export const MARKDOWN_MAX_DEPTH = 32;

/** One block quote marker, or one list marker followed by a space or the line's end. */
const CONTAINER = /^[ \t]*(?:>|(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$))/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const EMPHASIS = ['*', '_', '~'] as const;
type EmphasisChar = (typeof EMPHASIS)[number];
const isEmphasis = (c: string): c is EmphasisChar => (EMPHASIS as readonly string[]).includes(c);
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

/** A run of one emphasis character: whether it can open (text after it) and close (text before). */
interface Run {
  char: EmphasisChar;
  length: number;
  opens: boolean;
  closes: boolean;
}

/** A line of a paragraph: how deep its containers nest, and its emphasis runs in order. */
interface ParagraphLine {
  containers: number;
  runs: Run[];
}

/** Columns of leading white space, a tab to the next multiple of four. */
function indentOf(line: string): number {
  let columns = 0;
  for (const c of line) {
    if (c === ' ') columns += 1;
    else if (c === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/**
 * The emphasis runs of a line outside inline code. A backtick run opens a code span only when a run
 * of the same length follows it; the runs are found by length first, so each is looked up once.
 */
function emphasisRuns(line: string): Run[] {
  const ticksByLength = new Map<number, number[]>();
  for (let i = 0; i < line.length;) {
    let j = i + 1;
    if (line.charAt(i) === '`') {
      while (j < line.length && line.charAt(j) === '`') j += 1;
      const at = ticksByLength.get(j - i) ?? [];
      at.push(i);
      ticksByLength.set(j - i, at);
    }
    i = j;
  }
  const nextTick = new Map<number, number>();
  const runs: Run[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line.charAt(i);
    let j = i + 1;
    while (j < line.length && line.charAt(j) === c) j += 1;
    if (c === '`') {
      const length = j - i;
      const at = ticksByLength.get(length) ?? [];
      let k = nextTick.get(length) ?? 0;
      while (k < at.length && (at[k] ?? 0) <= i) k += 1;
      nextTick.set(length, k + 1);
      const close = at[k];
      i = close === undefined ? j : close + length;
      continue;
    }
    if (isEmphasis(c)) {
      runs.push({
        char: c,
        length: j - i,
        opens: !isSpace(line[j]),
        closes: !isSpace(line[i - 1]),
      });
    }
    i = j;
  }
  return runs;
}

/**
 * Whether a paragraph's emphasis nests within the bound. Emphasis never crosses a blank line or a
 * fence, so the lines between them are taken together. An emphasis open at a point needs an opener
 * before it and a closer of the same character after it, so the depth there is at most, per
 * character, the openers still open or the closers still to come, whichever is fewer. A lone `~2h`
 * or `*.md` with no closer after it nests nothing. Taking headings, table rows and list items with
 * the paragraph only counts more, never less.
 */
function paragraphFits(lines: readonly ParagraphLine[]): boolean {
  const left = new Map<EmphasisChar, number>(EMPHASIS.map((c) => [c, 0]));
  for (const line of lines) {
    for (const run of line.runs)
      if (run.closes) left.set(run.char, (left.get(run.char) ?? 0) + run.length);
  }
  const open = new Map<EmphasisChar, number>(EMPHASIS.map((c) => [c, 0]));
  for (const line of lines) {
    let most = 0;
    for (const run of line.runs) {
      if (run.closes) {
        left.set(run.char, (left.get(run.char) ?? 0) - run.length);
        open.set(run.char, Math.max(0, (open.get(run.char) ?? 0) - run.length));
      }
      if (run.opens) open.set(run.char, (open.get(run.char) ?? 0) + run.length);
      let depth = 0;
      for (const c of EMPHASIS) depth += Math.min(open.get(c) ?? 0, left.get(c) ?? 0);
      most = Math.max(most, depth);
    }
    if (line.containers + most > MARKDOWN_MAX_DEPTH) return false;
  }
  return true;
}

/** Whether `text` is short and shallow enough to draw as markdown. */
export function markdownFits(text: string): boolean {
  if (text.length > MARKDOWN_MAX_LENGTH) return false;
  let fence: string | null = null;
  let paragraph: ParagraphLine[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (fence !== null) {
      const close = FENCE.exec(line.replace(/^[ \t>]*/, ''));
      if (close?.[1]?.startsWith(fence) === true && line.trim().endsWith(close[1])) fence = null;
      continue;
    }
    let rest = line;
    let markers = 0;
    for (let m = CONTAINER.exec(rest); m !== null; m = CONTAINER.exec(rest)) {
      markers += 1;
      if (markers > MARKDOWN_MAX_DEPTH) return false;
      rest = rest.slice(m[0].length);
    }
    const opened = FENCE.exec(rest)?.[1];
    if (opened !== undefined || rest.trim() === '') {
      if (!paragraphFits(paragraph)) return false;
      paragraph = [];
      if (opened !== undefined) fence = opened;
      continue;
    }
    // An indented list marker nests one level for every two columns before it.
    const containers = markers === 0 ? 0 : markers + Math.floor(indentOf(line) / 2);
    if (containers > MARKDOWN_MAX_DEPTH) return false;
    paragraph.push({ containers, runs: emphasisRuns(rest) });
  }
  return paragraphFits(paragraph);
}
