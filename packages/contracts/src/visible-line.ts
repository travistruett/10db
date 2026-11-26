/**
 * What a line feed shows as: a mark no command holds as a break, so a line can't start on its own.
 * The mark itself, typed by the agent, shows escaped.
 */
const LINE_MARK = '⏎';

/**
 * A line feed, every other control, format or separator character (a carriage return, tab, ESC, NEL,
 * a bidi or zero-width character, U+2028 and U+2029), the line mark itself, and a backslash that
 * starts an escape's own form.
 */
const HIDDEN = /\n|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}⏎]|\\(?=u\{)/gu;

const escaped = (char: string): string => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`;

/**
 * Agent text on one line with every hidden character shown: a line feed as `⏎`, the rest as
 * `\u{hex}`. Shown beside 10db's own words, it can't add a line or reorder what reads around it, and
 * the form is unambiguous: a literal `⏎` or `\u{` in the text shows escaped too. Other backslashes
 * stay, so a shell command still reads as typed.
 */
export function visibleLine(text: string): string {
  return text.replace(HIDDEN, (char) => (char === '\n' ? LINE_MARK : escaped(char)));
}

/**
 * Agent text for a block of its own, such as a command's code block: its line feeds stay breaks and
 * every other hidden character shows as `\u{hex}`, so nothing in it reorders or hides what it runs.
 */
export function visibleBlock(text: string): string {
  return text.replace(HIDDEN, (char) =>
    char === '\n' || char === LINE_MARK ? char : escaped(char),
  );
}

/** A command as the last, labelled paragraph of a card, after 10db's own words. */
export function commandParagraph(command: string): string {
  return `Command: ${visibleLine(command)}`;
}
