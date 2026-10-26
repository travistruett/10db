import { describe, expect, it } from 'vitest';
import { expandBraceWord } from './braces';

/**
 * One row per brace form. `words` is what bash expands the word to; `null` means the expansion is
 * unread: past the caps, or a `..` body the two shells read differently (bash 3.2 keeps a stepped
 * sequence literal and never zero-pads, zsh expands both). A single-element or malformed brace
 * without `..` stays literal, as both shells leave it. Checked by hand with `printf '<%s>' <word>`
 * under `/bin/bash` 3.2 and `/bin/zsh -f` 5.9.
 */
const ROWS: { name: string; word: string; words: string[] | null }[] = [
  { name: 'a plain word', word: 'README.md', words: ['README.md'] },
  { name: 'a comma list', word: 'file.{ts,js}', words: ['file.ts', 'file.js'] },
  { name: 'an empty alternative', word: '{~/.claude.json,}', words: ['~/.claude.json', ''] },
  { name: 'a doubled empty list', word: 'env{,}', words: ['env', 'env'] },
  { name: 'a list with a prefix and suffix', word: 'src/{a,b}/c', words: ['src/a/c', 'src/b/c'] },
  { name: 'a nested list', word: '{a,{b,c}}', words: ['a', 'b', 'c'] },
  { name: 'a numeric sequence', word: '{1..3}', words: ['1', '2', '3'] },
  { name: 'a descending sequence', word: '{3..1}', words: ['3', '2', '1'] },
  { name: 'a stepped sequence, literal in bash 3.2', word: '{1..5..2}', words: null },
  { name: 'a sequence with a + step', word: '{1..3..+1}', words: null },
  { name: 'a sequence with a - step', word: '{1..3..-1}', words: null },
  { name: 'a letter sequence with a - step', word: '{a..e..-1}', words: null },
  { name: 'a zero-padded sequence, padded only by zsh', word: '{01..10}', words: null },
  { name: 'a sequence padded at its end', word: '{10..01}', words: null },
  { name: 'a negative zero-padded sequence', word: '{-01..1}', words: null },
  { name: 'a sequence from zero', word: '{0..3}', words: ['0', '1', '2', '3'] },
  { name: 'a sequence with a zero step', word: '{1..5..0}', words: null },
  { name: 'a letter sequence with a letter step', word: '{a..b..c}', words: null },
  { name: 'a sequence with no end', word: '{1..}', words: null },
  { name: 'a letter sequence', word: '{a..c}', words: ['a', 'b', 'c'] },
  { name: 'a single-element brace stays literal', word: 'stash@{0}', words: ['stash@{0}'] },
  { name: 'an empty brace stays literal', word: '{}', words: ['{}'] },
  { name: 'a flag with an empty brace', word: '-I{}', words: ['-I{}'] },
  { name: 'an unbalanced open stays whole', word: '{rm', words: ['{rm'] },
  { name: 'an unbalanced close stays whole', word: 'a}', words: ['a}'] },
  { name: 'a malformed sequence is unread', word: '{a..}', words: null },
  {
    name: 'a sequence of 65',
    word: '{1..65}',
    words: Array.from({ length: 65 }, (_, i) => String(i + 1)),
  },
  { name: 'a sequence past the sequence cap', word: '{1..5000}', words: null },
  {
    name: 'a product of a sequence and a list past the list cap',
    word: '{1..40}{a,b}',
    words: null,
  },
  { name: 'a sequence yielding option words', word: '{-5..-1}', words: null },
  { name: 'a prefixed sequence yielding option words', word: '-{1..3}', words: null },
];

/**
 * The word as written and its mask: the same text with every quoted or escaped character blanked to
 * NUL, so only the braces, commas and dots the shell reads as brace syntax remain. Positions are
 * UTF-16 units, as the scanner's mask counts them.
 */
const masked = (word: string, quotedAt: readonly number[]): { word: string; mask: string } => ({
  word,
  mask: Array.from({ length: word.length }, (_, at) =>
    quotedAt.includes(at) ? '\0' : word.charAt(at),
  ).join(''),
});

/** Rows whose quoted characters (checked under bash and zsh) are literal, never brace syntax. */
const MASKED_ROWS: { name: string; word: string; mask: string; words: string[] | null }[] = [
  {
    name: 'a quoted open brace as an alternative',
    ...masked('{rm,-rf,.git,{}', [13]),
    words: ['rm', '-rf', '.git', '{'],
  },
  {
    name: 'a quoted close brace as an alternative',
    ...masked('{rm,-rf,.git,}}', [13]),
    words: ['rm', '-rf', '.git', '}'],
  },
  {
    name: 'an escaped comma as an alternative',
    ...masked('{rm,-rf,.git,,}', [13]),
    words: ['rm', '-rf', '.git', ','],
  },
  {
    name: 'a quoted comma inside an alternative',
    ...masked('{sudo,ls,x,}', [10]),
    words: ['sudo', 'ls', 'x,'],
  },
  {
    name: 'a quoted close brace inside an alternative',
    ...masked('{a,b}}', [4]),
    words: ['a', 'b}'],
  },
  { name: 'a quoted open brace before a list', ...masked('{a,b}', [0]), words: ['{a,b}'] },
  {
    name: 'a wholly quoted jq filter',
    ...masked('{a: .b, c: .d}', [...Array(14).keys()]),
    words: ['{a: .b, c: .d}'],
  },
  {
    name: 'a wholly quoted glob list',
    ...masked('*.{ts,tsx}', [...Array(10).keys()]),
    words: ['*.{ts,tsx}'],
  },
  // zsh reads `{1'..'3}` as a sequence while bash keeps it literal, so it is unread.
  { name: 'a sequence with quoted dots', ...masked('{1..3}', [2, 3]), words: null },
  // An astral character is two UTF-16 units; the braces after it still line up with the mask.
  {
    name: 'a list after an astral character',
    ...masked('{😀,a}', []),
    words: ['😀', 'a'],
  },
  {
    name: 'a quoted brace after an astral alternative',
    ...masked('{a,😀,{}', [6]),
    words: ['a', '😀', '{'],
  },
];

describe('expandBraceWord', () => {
  it.each(ROWS)('expands $name', ({ word, words }) => {
    expect(expandBraceWord(word)).toEqual(words);
  });

  it.each(MASKED_ROWS)('expands $name by its mask', ({ word, mask, words }) => {
    expect(expandBraceWord(word, mask)).toEqual(words);
  });

  it('is uncertain past the list cap', () => {
    expect(expandBraceWord('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}')).toBeNull();
  });

  it.each(['{1..300000000}', '{1..99999999999}', '{1..9007199254740993}', '{-99999999999..0}'])(
    'is uncertain on %s without allocating the sequence',
    (word) => {
      const started = performance.now();
      expect(expandBraceWord(word)).toBeNull();
      expect(performance.now() - started).toBeLessThan(100);
    },
  );
});
