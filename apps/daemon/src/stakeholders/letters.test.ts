import { describe, expect, it } from 'vitest';
import { letterOf, namesLetter } from './letters';

describe('letterOf', () => {
  it.each([
    ['B', 'B'],
    ['b', 'B'],
    ['A.', 'A'],
    ['a)', 'A'],
    ['(c)', 'C'],
    ['A, because it is cheaper', 'A'],
    ['B: we cannot', 'B'],
    ['B please', 'B'],
    ['D thanks', 'D'],
    ['  C', 'C'],
  ])('reads %j as option %s', (text, letter) => {
    expect(letterOf(text, 4)).toBe(letter);
  });

  it.each([
    ['A couple of questions first', 'prose starting with the word A'],
    ['a quick thing: ask legal', 'prose starting with the word a'],
    ['A new approach would be better', 'prose starting with A'],
    ['I think B', 'prose starting with I'],
    ['Actually no', 'a word that starts with a letter'],
    ['Because it is cheaper', 'a word that starts with B'],
    ['Check with legal', 'a word that starts with C'],
    ['E', 'a letter past the options'],
  ])('does not read %j (%s)', (text) => {
    expect(letterOf(text, 4)).toBeNull();
  });

  it('does not read a letter beyond the options the question has', () => {
    expect(letterOf('C', 2)).toBeNull();
  });
});

describe('namesLetter', () => {
  it.each([
    ['option B is better', true],
    ['choice (c)', true],
    ['A couple of things', false],
    ['I would go with the second', false],
    ['B', true],
  ])('%j -> %s', (text, named) => {
    expect(namesLetter(text, 4)).toBe(named);
  });
});
