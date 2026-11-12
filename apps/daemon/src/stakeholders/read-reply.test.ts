import type { InboxOption } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { readReply } from './index';

const opt = (label: string): InboxOption => ({ label, description: '' });
const three = [
  opt('Keep access for 7 days'),
  opt('Cut access at once'),
  opt('Keep the whole period'),
];
const four = [...three, opt('Ask legal first')];

const one = (words: string) => ({ words, messageCount: 1 });

describe('readReply picks an option', () => {
  it.each([
    ['B', 'Cut access at once'],
    ['b', 'Cut access at once'],
    ['B.', 'Cut access at once'],
    ['b) yes', 'Cut access at once'],
    ['(b)', 'Cut access at once'],
    ['B: because of legal', 'Cut access at once'],
    ["B, we can't give away a week of service", 'Cut access at once'],
    ['  a  ', 'Keep access for 7 days'],
    ['C', 'Keep the whole period'],
    ['Cut access at once', 'Cut access at once'],
    ['cut ACCESS at once', 'Cut access at once'],
  ])('%j picks %s', (words, label) => {
    const read = readReply(one(words), three);
    expect(read.readAs).toBe('option');
    expect(read.answer).toEqual({ choice: label, note: words.trim() });
  });

  it('D picks the fourth option when there are four', () => {
    expect(readReply(one('D'), four).answer?.choice).toBe('Ask legal first');
  });

  it('cuts the note at the 4,000-character limit and keeps the choice', () => {
    const read = readReply(one(`B ${'x'.repeat(5000)}`), three);
    expect(read.answer?.choice).toBe('Cut access at once');
    expect(read.answer?.note).toHaveLength(4000);
  });
});

describe('readReply reads own words', () => {
  it.each([
    ['D with three lane options, never Park', 'D', three],
    ['E with four options', 'E', four],
    ['a first word that only starts with a letter', 'Before we decide, what is the cost?', three],
    ['a hyphenated letter', 'B-side thinking', three],
    ['an empty reply', '', three],
    ['whitespace only', '   \n ', three],
    ['a sentence', 'Let us keep access for a week and see', three],
    ['no options at all', 'A', []],
  ])('%s', (_name, words, options) => {
    expect(readReply(one(words), options)).toEqual({ answer: null, readAs: 'own_words' });
  });

  it('"B" then "wait, C" as two messages is own words, never B', () => {
    expect(readReply({ words: 'B\nwait, C', messageCount: 2 }, three)).toEqual({
      answer: null,
      readAs: 'own_words',
    });
  });

  it('a label sent as two messages is own words too', () => {
    expect(readReply({ words: 'Cut access at once', messageCount: 2 }, three).answer).toBeNull();
  });

  it('never picks Park, even when the caller passes it and the letter points at it', () => {
    const withPark = [...three, opt('Park the task')];
    expect(readReply(one('D'), withPark).answer).toBeNull();
    expect(readReply(one('Park the task'), withPark).answer).toBeNull();
  });
});
