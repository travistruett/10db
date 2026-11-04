import { describe, expect, it } from 'vitest';
import { matchesSearch, searchTerms } from './knowledge-search';

describe('searchTerms', () => {
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
  });
});
