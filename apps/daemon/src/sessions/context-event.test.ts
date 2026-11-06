import { describe, expect, it } from 'vitest';
import { contextEvent } from './context-event';

describe('contextEvent', () => {
  it('computes the percentage from the token counts, whatever scale the SDK uses', () => {
    expect(contextEvent({ totalTokens: 50_000, maxTokens: 200_000, percentage: 0.25 })).toEqual({
      type: 'context',
      percentage: 25,
      totalTokens: 50_000,
      maxTokens: 200_000,
    });
  });

  it.each([
    [0.4, 40],
    [40, 40],
  ])('falls back to percentage %s when maxTokens is 0', (percentage, expected) => {
    expect(contextEvent({ totalTokens: 0, maxTokens: 0, percentage }).percentage).toBe(expected);
  });
});
