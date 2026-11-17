import { describe, expect, it } from 'vitest';
import { withoutTerminalCodes } from './terminal-text';

const ESC = '\u001b';
const BEL = '\u0007';

describe('withoutTerminalCodes', () => {
  it.each([
    ['plain text stays as it is', 'Tests 4 passed', 'Tests 4 passed'],
    ['a colour and its reset', `${ESC}[33mvalue${ESC}[39m=`, 'value='],
    ['bold, colour and reset in one code', `${ESC}[1;32m✓${ESC}[0m done`, '✓ done'],
    ['a 256-colour code', `${ESC}[38;5;208mwarn${ESC}[0m`, 'warn'],
    ['cursor moves and line clears', `${ESC}[2K${ESC}[1Gprogress`, 'progress'],
    ['a private mode switch', `${ESC}[?25lhidden cursor${ESC}[?25h`, 'hidden cursor'],
    ['a link ended by BEL', `${ESC}]8;;https://x.test${BEL}x${ESC}]8;;${BEL}`, 'x'],
    ['a title ended by ESC \\', `${ESC}]0;title${ESC}\\after`, 'after'],
    ['a two-byte escape', `${ESC}(Bplain`, 'plain'],
    ['a link cut off before its end', `before${ESC}]8;;https://x.test`, 'before'],
    ['newlines and tabs stay', `a\n\tb${ESC}[0m\n`, 'a\n\tb\n'],
  ])('%s', (_name, input, expected) => {
    expect(withoutTerminalCodes(input)).toBe(expected);
  });
});
