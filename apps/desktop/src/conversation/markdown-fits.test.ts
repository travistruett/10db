import { describe, expect, it } from 'vitest';
import { MARKDOWN_MAX_DEPTH, MARKDOWN_MAX_LENGTH, markdownFits } from './markdown-fits';

// What Markdown draws and what it shows as plain text instead: the parser and its plugins recurse,
// so a document nested past the limit, or longer than it, is never handed to them.

const nested = (n: number): string =>
  Array.from({ length: n }, (_, i) => `${' '.repeat(i * 2)}- level ${String(i)}`).join('\n');

describe('markdownFits', () => {
  it.each<[string, string, boolean]>([
    ['a plain document', '# Title\n\nSome **bold** and *em* and `code*`.\n\n- a\n  - b\n', true],
    ['quotes at the limit', `${'>'.repeat(MARKDOWN_MAX_DEPTH)} x`, true],
    ['quotes past the limit', `${'>'.repeat(5000)} x`, false],
    ['lists on one line past the limit', `${'- '.repeat(1000)}x`, false],
    ['indented lists at the limit', nested(MARKDOWN_MAX_DEPTH), true],
    ['indented lists past the limit', nested(300), false],
    ['one emphasis run past the limit', `${'*'.repeat(5000)}x${'*'.repeat(5000)}`, false],
    ['nested emphasis past the limit', `${'*a '.repeat(1000)}x${' a*'.repeat(1000)}`, false],
    ['many closed emphases in a paragraph', '**a** '.repeat(2000), true],
    ['emphasis runs in a fence are code', ['```', '*a '.repeat(1000), '```'].join('\n'), true],
    ['emphasis runs in inline code are code', `\`${'*a '.repeat(1000)}\``, true],
    ['a deep indent in a fence is code', ['```', `${' '.repeat(400)}x`, '```'].join('\n'), true],
    ['thematic breaks', '***\n\n- - -\n\n___', true],
    [
      'a tight checklist of lone tildes',
      Array.from({ length: 60 }, (_, n) => `- [ ] T${String(n)} (P1, ~2h / ~10m) the step`).join(
        '\n',
      ),
      true,
    ],
    [
      'emphasis opened across quote lines past the limit',
      Array.from({ length: 40 }, () => '> *a').join('\n'),
      false,
    ],
    [
      'emphasis opened across pipe lines that are no table',
      Array.from({ length: 40 }, () => '| *a').join('\n'),
      false,
    ],
    [
      'a thematic break is no table delimiter',
      ['x', '---', ...Array.from({ length: 40 }, () => '| *a')].join('\n'),
      false,
    ],
    [
      'a table of lone stars',
      [
        '| glob | holds |',
        '| --- | --- |',
        ...Array.from({ length: 60 }, () => '| *.md | docs |'),
      ].join('\n'),
      true,
    ],
    [
      'headings of lone underscores',
      Array.from({ length: 60 }, () => '## _draft x').join('\n'),
      true,
    ],
    ['the longest document drawn', 'a'.repeat(MARKDOWN_MAX_LENGTH), true],
    ['one character longer', 'a'.repeat(MARKDOWN_MAX_LENGTH + 1), false],
  ])('%s', (_, text, fits) => {
    expect(markdownFits(text)).toBe(fits);
  });
});
