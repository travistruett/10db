import { mintId } from '@10db/contracts';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { leaveLate, takeLate, useLate, withoutSent } from './late-outcome';

describe('what waits for a conversation’s input', () => {
  it.each([
    { name: 'a failed text beside different typed text', first: 'B', then: 'A', want: 'A\n\nB' },
    {
      name: 'a failed text inside the typed text',
      first: 'A and B',
      then: 'A',
      want: 'A\n\nA and B',
    },
    {
      name: 'typed text inside the failed text',
      first: 'A',
      then: 'A and B',
      want: 'A and B\n\nA',
    },
    { name: 'a failed text beside empty typed text', first: '', then: 'A', want: 'A' },
    { name: 'the same text twice', first: 'A', then: 'A', want: 'A' },
  ])('keeps $name', ({ first, then, want }) => {
    const id = mintId('Shape');
    leaveLate(id, { draft: first });
    leaveLate(id, { failure: 'The daemon is restarting', draft: then });
    const { result } = renderHook(() => useLate(id));
    expect(result.current?.draft).toBe(want);
    expect(result.current?.failure).toBe('The daemon is restarting');
    takeLate(id);
  });

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

  it('keeps a waiting draft when what comes next has none', () => {
    const id = mintId('Shape');
    leaveLate(id, { draft: 'A' });
    leaveLate(id, { refused: ['brief.md is too big'] });
    const { result } = renderHook(() => useLate(id));
    expect(result.current?.draft).toBe('A');
    expect(result.current?.refused).toEqual(['brief.md is too big']);
    takeLate(id);
  });
});
