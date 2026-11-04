import { describe, expect, it } from 'vitest';
import { isSearch, matchesSearch, searchTerms } from './knowledge-search';

describe('searchTerms', () => {
  it.each([
    { name: 'Hangul', text: '한글', term: '한글' },
    { name: 'Hangul pasted decomposed', text: '한글'.normalize('NFD'), term: '한글' },
    { name: 'Cyrillic й', text: 'чай', term: 'чай' },
    { name: 'kana with dakuten', text: 'が', term: 'が' },
    { name: 'an accented Latin word', text: 'Crème', term: 'creme' },
    { name: 'a Latin letter with two accents', text: 'Việt', term: 'việt' },
    { name: 'a Latin letter with no plain form', text: 'Søren', term: 'søren' },
  ])('keeps what the tokenizer keeps: $name', ({ text, term }) => {
    expect(searchTerms(text)).toEqual([term]);
  });

  it('splits on anything that is not a letter or digit, lower-cased', () => {
    expect(searchTerms(`What's -the "Deal" (NEAR OR`)).toEqual([
      'what',
      's',
      'the',
      'deal',
      'near',
      'or',
    ]);
    expect(searchTerms('***')).toEqual([]);
  });

  it('folds accents so a typed word meets its accented spelling', () => {
    expect(searchTerms('Café')).toEqual(['cafe']);
    expect(searchTerms('Café')).toEqual(['cafe']);
  });
});

describe('matchesSearch', () => {
  it('finds a word from its first letters', () => {
    expect(matchesSearch('No sleeps in tests', 'slee')).toBe(true);
    expect(matchesSearch('No sleeps in tests', 'sleeps')).toBe(true);
  });

  it('does not find a word from the middle of it', () => {
    expect(matchesSearch('No sleeps in tests', 'eeps')).toBe(false);
  });

  it('needs every word, each as the start of some word', () => {
    expect(matchesSearch('No sleeps in tests', 'slee tes')).toBe(true);
    expect(matchesSearch('No sleeps in tests', 'slee queue')).toBe(false);
  });

  it('splits the text the way the query is split', () => {
    expect(matchesSearch('testing.no-sleeps', 'sleep')).toBe(true);
  });

  it('matches everything when the query holds no word', () => {
    expect(matchesSearch('anything', '')).toBe(true);
    expect(matchesSearch('anything', '  ')).toBe(true);
    expect(matchesSearch('anything', '***')).toBe(true);
  });
});

describe('isSearch', () => {
  it.each([
    { query: '', searching: false },
    { query: '  ', searching: false },
    { query: '-', searching: false },
    { query: '***', searching: false },
    { query: 's', searching: true },
    { query: '- 한', searching: true },
  ])('$query: $searching', ({ query, searching }) => {
    expect(isSearch(query)).toBe(searching);
  });
});
