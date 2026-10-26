import { describe, expect, it } from 'vitest';
import { expandBraceWord } from './braces';

/**
 * One row per brace form. `words` is what bash expands the word to; `null` means the expansion runs
 * past the caps and is unread. A single-element or malformed brace stays literal, as both shells
 * leave it. Checked by hand with `printf '<%s>' <word>` under bash and zsh.
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
  { name: 'a stepped sequence', word: '{1..5..2}', words: ['1', '3', '5'] },
  { name: 'a letter sequence', word: '{a..c}', words: ['a', 'b', 'c'] },
  { name: 'a single-element brace stays literal', word: 'stash@{0}', words: ['stash@{0}'] },
  { name: 'an empty brace stays literal', word: '{}', words: ['{}'] },
  { name: 'a flag with an empty brace', word: '-I{}', words: ['-I{}'] },
  { name: 'an unbalanced open stays whole', word: '{rm', words: ['{rm'] },
  { name: 'an unbalanced close stays whole', word: 'a}', words: ['a}'] },
  { name: 'a malformed sequence stays literal', word: '{a..}', words: ['{a..}'] },
];

describe('expandBraceWord', () => {
  it.each(ROWS)('expands $name', ({ word, words }) => {
    expect(expandBraceWord(word)).toEqual(words);
  });

  it('is uncertain past the alternative cap', () => {
    expect(expandBraceWord('{1..1000}')).toBeNull();
  });
});
