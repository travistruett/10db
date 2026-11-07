import { describe, expect, it } from 'vitest';
import { limitName } from './cards';

const ASTRA = { id: 'gpt-6-astra', name: 'GPT-6 Astra' };

describe('limitName', () => {
  it.each<{ limit: string | null; says: string; models?: { id: string; name: string }[] }>([
    { limit: 'five_hour', says: '5-hour limit' },
    { limit: 'seven_day', says: 'weekly limit' },
    { limit: 'seven_day_overage_included', says: 'weekly limit' },
    { limit: 'overage', says: 'extra-usage limit' },
    // A model-specific weekly limit is named from its key, so a model the code has never heard of reads right.
    { limit: 'seven_day_opus', says: 'weekly Opus limit' },
    { limit: 'seven_day_fable', says: 'weekly Fable limit' },
    { limit: 'seven_day_gpt_6_astra', says: 'weekly Gpt 6 Astra limit' },
    // A key whose model has joined the catalogue reads as the catalogue names it.
    { limit: 'seven_day_gpt_6_astra', says: 'weekly GPT-6 Astra limit', models: [ASTRA] },
    // A key that matches no one model (Opus is several) keeps the words of the key.
    {
      limit: 'seven_day_opus',
      says: 'weekly Opus limit',
      models: [ASTRA, { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
    },
    { limit: 'something_new', says: 'usage limit' },
    { limit: null, says: 'usage limit' },
  ])('reads $limit as the $says', ({ limit, says, models }) => {
    expect(limitName(limit, models)).toBe(says);
  });
});
