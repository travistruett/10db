import { describe, expect, it } from 'vitest';
import { limitName } from './cards';

describe('limitName', () => {
  it.each<{ limit: string | null; says: string }>([
    { limit: 'five_hour', says: '5-hour limit' },
    { limit: 'seven_day', says: 'weekly limit' },
    { limit: 'seven_day_overage_included', says: 'weekly limit' },
    { limit: 'overage', says: 'extra-usage limit' },
    // A model-specific weekly limit is named from its key, so a model the code has never heard of reads right.
    { limit: 'seven_day_opus', says: 'weekly Opus limit' },
    { limit: 'seven_day_fable', says: 'weekly Fable limit' },
    { limit: 'seven_day_gpt_6_astra', says: 'weekly Gpt 6 Astra limit' },
    { limit: 'something_new', says: 'usage limit' },
    { limit: null, says: 'usage limit' },
  ])('reads $limit as the $says', ({ limit, says }) => {
    expect(limitName(limit)).toBe(says);
  });
});
