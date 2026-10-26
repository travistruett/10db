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
/** The most hex digits `\x`, `\u` and `\U` take. */
const HEX_DIGITS: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };
const MAX_BYTE = 0o377;
const MAX_CODE_POINT = 0x10ffff;

/** One escape after its backslash: the character it decodes to and how many characters it used. */
function escape(body: string, at: number): { char: string; length: number } | null {
  const letter = body.charAt(at);
  const simple = SIMPLE[letter];
  if (simple !== undefined) return { char: simple, length: 1 };
  const octal = /^[0-7]{1,3}/.exec(body.slice(at));
  if (octal) {
    const value = Number.parseInt(octal[0], 8);
    // bash keeps only the low byte of a larger value; another shell may not.
    if (value > MAX_BYTE) return null;
    // `\0` followed by three more octal digits reads differently in zsh.
    if (
      octal[0].startsWith('0') &&
      /^[0-7]/.test(body.slice(at + octal[0].length)) &&
      octal[0].length === 3
    )
      return null;
    return { char: String.fromCharCode(value), length: octal[0].length };
  }
  const digits = HEX_DIGITS[letter];
  if (digits !== undefined) {
    const hex = new RegExp(`^[0-9a-fA-F]{1,${String(digits)}}`).exec(body.slice(at + 1));
    if (!hex) return null;
    const value = Number.parseInt(hex[0], 16);
    if (value > MAX_CODE_POINT || (value >= 0xd800 && value <= 0xdfff)) return null;
    return { char: String.fromCodePoint(value), length: 1 + hex[0].length };
  }
  if (letter === 'c') {
    const control = body.charAt(at + 1);
    if (control === '' || control === '\\' || control.charCodeAt(0) > 0x7f) return null;
    const value = control === '?' ? 0x7f : control.toUpperCase().charCodeAt(0) & 0x1f;
    return { char: String.fromCharCode(value), length: 2 };
  }
  return null;
}

/**
 * Decodes the body of an ANSI-C `$'…'` word (between the quotes) with bash's escape set: `\a \b
 * \e \E \f \n \r \t \v \\ \' \" \?`, `\nnn` octal, `\xHH`, `\uHHHH`, `\UHHHHHHHH` and `\cX`.
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
