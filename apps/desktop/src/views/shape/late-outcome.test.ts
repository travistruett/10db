import { mintId } from '@10db/contracts';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { leaveLate, takeLate, useLate } from './late-outcome';

describe('what waits for a conversation’s input', () => {
  it.each([
    { name: 'a failed text beside different typed text', first: 'B', then: 'A', want: 'A\n\nB' },
    { name: 'a failed text the typed text holds', first: 'A and B', then: 'A', want: 'A and B' },
    { name: 'typed text that holds the failed text', first: 'A', then: 'A and B', want: 'A and B' },
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
