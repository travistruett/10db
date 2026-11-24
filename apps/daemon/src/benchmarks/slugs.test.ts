import { Effort } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { aaSlugFor } from './slugs';

describe('aaSlugFor', () => {
  it('scores a model OpenRouter lists under its maker, and never a router alias', () => {
    const listed = new Set(['aion-2-0', 'gemini-pro']);
    expect(aaSlugFor('aion-labs/aion-2.0', Effort.Max, listed)).toBe('aion-2-0');
    expect(aaSlugFor('~google/gemini-pro', Effort.Max, listed)).toBeNull();
  });
});
