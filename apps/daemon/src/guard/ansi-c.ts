/** What the body of an ANSI-C `$'…'` word decodes to. */
export interface AnsiCText {
  readonly text: string;
  /**
   * The body is decoded exactly as bash and zsh both read it: every escape is one of the standard
   * set, and none decodes to a NUL, which bash ends the word at, or to a `/`.
   */
  readonly exact: boolean;
  /** An escape other than `\'`, `\\` and `\"` was decoded. */
  readonly escapes: boolean;
  /** Where in `text` an escape decoded to a newline. */
  readonly newlines: readonly number[];
}

const SIMPLE: Readonly<Record<string, string>> = {
  a: '\u0007',
  b: '\b',
  e: '\u001b',
  E: '\u001b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};
const QUOTES = new Set(['\\', "'", '"']);
/** The most hex digits `\u` and `\U` take. */
const UNICODE_DIGITS: Readonly<Record<string, number>> = { u: 4, U: 8 };
/**
 * A `\x` or `\nnn` byte at or above this is uncertain: both shells emit the raw byte, while a code
 * point above U+007F is a different string. Below it the two agree.
 */
const ASCII_MAX = 0x7f;
const MAX_CODE_POINT = 0x10ffff;

/** One escape after its backslash: the character it decodes to and how many characters it used. */
function escape(body: string, at: number): { char: string; length: number } | null {
  const letter = body.charAt(at);
  const simple = SIMPLE[letter];
  if (simple !== undefined) return { char: simple, length: 1 };
  const octal = /^[0-7]{1,3}/.exec(body.slice(at));
  if (octal) {
    const value = Number.parseInt(octal[0], 8);
    // A byte of 0x80 or more is a raw byte in both shells, not the code point of that value.
    if (value > ASCII_MAX) return null;
    return { char: String.fromCharCode(value), length: octal[0].length };
  }
  if (letter === 'x') {
    const hex = /^[0-9a-fA-F]{1,2}/.exec(body.slice(at + 1));
    if (!hex) return null;
    // Same raw-byte split as octal.
    if (Number.parseInt(hex[0], 16) > ASCII_MAX) return null;
    return { char: String.fromCharCode(Number.parseInt(hex[0], 16)), length: 1 + hex[0].length };
  }
  const unicode = UNICODE_DIGITS[letter];
  if (unicode !== undefined) {
    const hex = new RegExp(`^[0-9a-fA-F]{1,${String(unicode)}}`).exec(body.slice(at + 1));
    if (!hex) return null;
    const value = Number.parseInt(hex[0], 16);
    if (value > MAX_CODE_POINT || (value >= 0xd800 && value <= 0xdfff)) return null;
    return { char: String.fromCodePoint(value), length: 1 + hex[0].length };
  }
  // `\cX` is a control character in bash but the two characters `cX` in zsh, so it is never exact.
  return null;
}

/**
 * Decodes the body of an ANSI-C `$'…'` word (between the quotes) with the escape set bash and zsh
 * read the same way: `\a \b \e \E \f \n \r \t \v \\ \' \" \?`, `\nnn` octal and `\xHH` below 0x80,
 * and `\uHHHH`/`\UHHHHHHHH`. `\cX` and a higher byte are left undecoded, so the word is not exact.
 */
export function decodeAnsiC(body: string): AnsiCText {
  let text = '';
  let exact = true;
  let escapes = false;
  const newlines: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (ch !== '\\') {
      text += ch;
      continue;
    }
    const decoded = escape(body, i + 1);
    if (decoded === null) {
      exact = false;
      text += ch;
      continue;
    }
    if (!QUOTES.has(body.charAt(i + 1))) escapes = true;
    if (decoded.char === '\0' || decoded.char === '/') exact = false;
    if (decoded.char === '\n') newlines.push(text.length);
    text += decoded.char;
    i += decoded.length;
  }
  return { text, exact, escapes, newlines };
}
