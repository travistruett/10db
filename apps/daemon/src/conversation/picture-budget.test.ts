import { describe, expect, it } from 'vitest';
import { imagesWithinBudget } from './picture-budget';
import { pictureLimitsFor } from './picture-limits';

const MIB = 1024 * 1024;
const bedrock = pictureLimitsFor('bedrock');

describe('imagesWithinBudget', () => {
  it('sends what fits in order, and nothing once the conversation is full', () => {
    expect(imagesWithinBudget([MIB, MIB, 5 * MIB], 0, bedrock)).toEqual([0, 1]);
    expect(imagesWithinBudget([MIB], bedrock.inlineMaxBytes - MIB / 2, bedrock)).toEqual([]);
  });
});
