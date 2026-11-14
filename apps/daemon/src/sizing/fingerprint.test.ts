import { describe, expect, it } from 'vitest';
import { mintId } from '@10db/contracts';
import { sizingFingerprint, type SizedText } from './fingerprint';

const base: SizedText = {
  title: 'Add a thing',
  description: 'It does a thing',
  acceptanceCriteria: ['it works'],
  areas: ['api'],
  goalId: null,
};

describe('sizingFingerprint', () => {
  it('is the same for the same text, and for a goal left absent or null', () => {
    expect(sizingFingerprint({ ...base })).toBe(sizingFingerprint({ ...base, goalId: undefined }));
  });

  it.each([
    { name: 'the title', change: { title: 'Add two things' } },
    { name: 'the description', change: { description: 'It does more' } },
    { name: 'a criterion', change: { acceptanceCriteria: ['it works', 'and is fast'] } },
    { name: 'the areas', change: { areas: ['api', 'ui'] } },
    { name: 'the goal', change: { goalId: mintId('Goal') } },
  ])('changes with $name', ({ change }) => {
    expect(sizingFingerprint({ ...base, ...change })).not.toBe(sizingFingerprint(base));
  });

  it('does not run two fields together', () => {
    expect(sizingFingerprint({ ...base, title: 'ab', description: 'c' })).not.toBe(
      sizingFingerprint({ ...base, title: 'a', description: 'bc' }),
    );
  });
});
