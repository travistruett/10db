// Whether a text is drawn as markdown or shown as plain text. The markdown parser and its plugins
// recurse over the tree, so a document nested deeper than MARKDOWN_MAX_DEPTH exhausts the call stack
// or runs for seconds first, and one longer than MARKDOWN_MAX_LENGTH holds the window while it draws.
// This scan reads each line once and never recurses.

/** The longest text drawn as markdown, in UTF-16 code units; a longer one shows whole as plain text. */
export const MARKDOWN_MAX_LENGTH = 512 * 1024;

/** The deepest nesting drawn: block quotes and lists, plus emphasis left open, on any line. */
export const MARKDOWN_MAX_DEPTH = 32;

/** One block quote marker, or one list marker followed by a space or the line's end. */
const CONTAINER = /^[ \t]*(?:>|(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$))/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const EMPHASIS = new Set(['*', '_', '~']);
/** A list item's marker: it always starts a new item, which emphasis can't run into. */
const LIST_MARKER = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)/;
/** An ATX heading: one line, a block of its own. */
const HEADING = /^[ \t]*#{1,6}(?:[ \t]|$)/;
/** A table's delimiter row; the rows after it, to a blank line, are each a block of their own. */
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

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
 * Emphasis left open after a line, starting from `open`, and the most open at once. A run that only
 * opens (space before, text after) adds its length, one that only closes takes it away; inline code
 * is skipped.
 */
function emphasisAfter(line: string, open: number): { open: number; most: number } {
  let most = open;
  let i = 0;
  while (i < line.length) {
    const c = line.charAt(i);
    let j = i + 1;
    while (j < line.length && line.charAt(j) === c) j += 1;
    if (c === '`') {
      const close = line.indexOf(c.repeat(j - i), j);
      i = close < 0 ? j : close + (j - i);
      continue;
    }
    if (EMPHASIS.has(c)) {
      const opens = !isSpace(line[j]);
      const closes = !isSpace(line[i - 1]);
      if (opens && !closes) open += j - i;
      else if (closes && !opens) open = Math.max(0, open - (j - i));
      most = Math.max(most, open);
    }
    i = j;
  }
  return { open, most };
}

/** Whether `text` is short and shallow enough to draw as markdown. */
export function markdownFits(text: string): boolean {
  if (text.length > MARKDOWN_MAX_LENGTH) return false;
  let fence: string | null = null;
  let open = 0;
  let inTable = false;
  let afterPipeLine = false;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (fence !== null) {
      const close = FENCE.exec(line.replace(/^[ \t>]*/, ''));
      if (close?.[1]?.startsWith(fence) === true && line.trim().endsWith(close[1])) fence = null;
      continue;
    }
    let rest = line;
    let markers = 0;
    let listItem = false;
    for (let m = CONTAINER.exec(rest); m !== null; m = CONTAINER.exec(rest)) {
      markers += 1;
      if (LIST_MARKER.test(m[0])) listItem = true;
      if (markers > MARKDOWN_MAX_DEPTH) return false;
      rest = rest.slice(m[0].length);
    }
    const opened = FENCE.exec(rest)?.[1];
    if (opened !== undefined) {
      fence = opened;
      afterPipeLine = false;
      continue;
    }
    if (rest.trim() === '') {
      open = 0;
      inTable = false;
      afterPipeLine = false;
      continue;
    }
    // A new list item, a heading, or a row of a table whose delimiter row was seen starts a block
    // of its own, and emphasis never crosses into it. A quote line or a pipe line outside a table
    // may continue the paragraph before it, so it keeps what was left open: counting too much only
    // shows the text plain, counting too little lets the parser recurse past the bound.
    if (afterPipeLine && rest.includes('|') && TABLE_DELIMITER.test(rest)) {
      inTable = true;
      open = 0;
      continue;
    }
    if (listItem || HEADING.test(rest) || (inTable && rest.trimStart().startsWith('|'))) open = 0;
    afterPipeLine = rest.includes('|');
    // An indented list marker nests one level for every two columns before it.
    const containers = markers === 0 ? 0 : markers + Math.floor(indentOf(line) / 2);
    const emphasis = emphasisAfter(rest, open);
    open = emphasis.open;
    if (containers + emphasis.most > MARKDOWN_MAX_DEPTH) return false;
  }
  return true;
}
