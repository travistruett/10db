import { describe, expect, it } from 'vitest';
import { decodeAnsiC } from './ansi-c';

/**
 * One row per ANSI-C `$'…'` escape form. `text` is the decoding when both shells read it the same
 * way (`exact`); `null` means the form is not decoded exactly and the guard treats the word as
 * unreadable. Each row was checked by hand with `printf '<%s>' $'…'` under `/bin/bash` 3.2.57 and
 * `/bin/zsh` 5.9 (the shells on this machine): an "exact" row prints the same bytes in both; an
 * "uncertain" row prints different bytes, or a raw byte a code point would not.
 *
 * `\u` and `\U` are an intended exception: bash 3.2 keeps them literal while zsh decodes them, and
 * the guard follows zsh. Deciding on the decoded form only ever refuses more, since the literal
 * bash form has extra characters and cannot match a protected path the decoded one misses.
 */
const ROWS: { name: string; body: string; text: string | null }[] = [
  // Simple escapes, identical in both shells.
  { name: 'bell', body: '\\a', text: '\u0007' },
  { name: 'backspace', body: '\\b', text: '\b' },
  { name: 'escape e', body: '\\e', text: '\u001b' },
  { name: 'escape E', body: '\\E', text: '\u001b' },
  { name: 'form feed', body: '\\f', text: '\f' },
  { name: 'newline', body: '\\n', text: '\n' },
  { name: 'return', body: '\\r', text: '\r' },
  { name: 'tab', body: '\\t', text: '\t' },
  { name: 'vertical tab', body: '\\v', text: '\v' },
  { name: 'backslash', body: '\\\\', text: '\\' },
  { name: 'single quote', body: "\\'", text: "'" },
  { name: 'double quote', body: '\\"', text: '"' },
  { name: 'question mark', body: '\\?', text: '?' },
  // Hex, below 0x80.
  { name: 'hex dot', body: '\\x2e', text: '.' },
  { name: 'hex dot then letter', body: '\\x2eg', text: '.g' },
  { name: 'hex stops at two digits', body: '\\x2E2', text: '.2' },
  { name: 'hex DEL', body: '\\x7f', text: '\u007f' },
  // Hex, 0x80 or more: both shells emit a raw byte, not the code point.
  { name: 'hex 0x80', body: '\\x80', text: null },
  { name: 'hex 0xff', body: '\\xff', text: null },
  { name: 'hex with no digits', body: '\\x', text: null },
  { name: 'hex with a non-digit', body: '\\xg', text: null },
  // Octal, below 0x80.
  { name: 'octal A', body: '\\101', text: 'A' },
  { name: 'octal A then digit', body: '\\1011', text: 'A1' },
  { name: 'octal stops at three digits', body: '\\0101', text: '\b1' },
  { name: 'octal newline', body: '\\012', text: '\n' },
  { name: 'octal DEL', body: '\\177', text: '\u007f' },
  // Octal, 0x80 or more, or ambiguous: uncertain.
  { name: 'octal 0x80', body: '\\200', text: null },
  { name: 'octal 0xff', body: '\\377', text: null },
  { name: 'octal past one byte', body: '\\400', text: null },
  { name: 'octal zero then two digits then more', body: '\\08', text: null },
  { name: 'bare backslash digit', body: '\\8', text: null },
  // NUL and slash: both shells differ on the first, and a decoded `/` changes a path's shape.
  { name: 'hex NUL', body: '\\x00', text: null },
  { name: 'hex slash', body: '\\x2f', text: null },
  { name: 'octal slash', body: '\\057', text: null },
  // Unicode: zsh decodes, bash 3.2 keeps literal; the guard follows zsh (see the file comment).
  { name: 'short unicode dot', body: '\\u2e', text: '.' },
  { name: 'unicode dot', body: '\\u002e', text: '.' },
  { name: 'unicode e-acute', body: '\\u00e9', text: 'é' },
  { name: 'long unicode dot', body: '\\U0000002e', text: '.' },
  { name: 'unicode with no digits', body: '\\u', text: null },
  { name: 'unicode surrogate', body: '\\ud800', text: null },
  { name: 'unicode past the max code point', body: '\\U00110000', text: null },
  // Control escapes: a control character in bash, the two letters `cX` in zsh.
  { name: 'control A', body: '\\cA', text: null },
  { name: 'control a', body: '\\ca', text: null },
  { name: 'control question', body: '\\c?', text: null },
  { name: 'control e', body: '\\ce', text: null },
  { name: 'control l', body: '\\cl', text: null },
  // An escape no shell gives meaning.
  { name: 'unknown escape', body: '\\q', text: null },
  // A body with no escapes is exact and holds no decoded escape.
  { name: 'plain text', body: 'README.md', text: 'README.md' },
];

describe('decodeAnsiC', () => {
  it.each(ROWS)('decodes $name', ({ body, text }) => {
    const result = decodeAnsiC(body);
    expect(result.exact).toBe(text !== null);
    if (text !== null) expect(result.text).toBe(text);
  });

  it('marks a word with a real escape, so permission rules keep clear of it', () => {
    expect(decodeAnsiC('\\x2e').escapes).toBe(true);
    expect(decodeAnsiC("\\'").escapes).toBe(false);
    expect(decodeAnsiC('plain').escapes).toBe(false);
  });

  it('reports where an escape decoded to a newline', () => {
    expect(decodeAnsiC('a\\nb').newlines).toEqual([1]);
    expect(decodeAnsiC('ab').newlines).toEqual([]);
  });
});
