import { describe, expect, it } from 'vitest';
import { withoutSent } from './drafts';

describe('what a composer holds once its send succeeds', () => {
  it.each([
    { name: 'only the sent text', typed: ' sent ', want: '' },
    { name: 'a restored text ahead of the sent text', typed: 'failed\n\nsent', want: 'failed' },
    {
      name: 'an edit that no longer holds the sent text',
      typed: 'sent, then more',
      want: 'sent, then more',
    },
  ])('leaves $name once a send succeeds', ({ typed, want }) => {
    expect(withoutSent(typed, 'sent')).toBe(want);
  });
});
