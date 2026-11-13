import { describe, expect, it } from 'vitest';
import { codeSpans } from './code-spans';

// Code spans read as markdown reads them: a run of backticks closes at the next run of as many.

describe('codeSpans', () => {
  it.each<[string, string, [boolean, string][]]>([
    ['plain text', 'no code here', [[false, 'no code here']]],
    [
      'one span',
      'call `x()` now',
      [
        [false, 'call '],
        [true, 'x()'],
        [false, ' now'],
      ],
    ],
    ['a span holding a backtick', '``a ` b``', [[true, 'a ` b']]],
    ['padding spaces trimmed once', '`` `x` ``', [[true, '`x`']]],
    ['a lone backtick stays text', 'it`s fine', [[false, 'it`s fine']]],
    ['a longer run does not close a shorter one', '`a``b`', [[true, 'a``b']]],
  ])('%s', (_, text, parts) => {
    expect(codeSpans(text).map((p) => [p.code, p.text])).toEqual(parts);
  });
});
