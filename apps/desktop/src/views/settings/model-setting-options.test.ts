import type { ModelSetting } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { automaticAtLeast, settingSummary, settingValue, topOfTier } from './model-setting-options';

describe('settingSummary', () => {
  const names = new Map([['model-a', 'Model A']]);
  it.each<{ name: string; setting: ModelSetting; want: string }>([
    { name: 'automatic', setting: { kind: 'automatic' }, want: 'Auto' },
    {
      name: 'automatic with a minimum',
      setting: { kind: 'automatic', minimum: 45 },
      want: 'Auto, at least 45',
    },
    {
      name: 'automatic with a minimum of zero',
      setting: { kind: 'automatic', minimum: 0 },
      want: 'Auto, at least 0',
    },
    { name: 'a tier', setting: { kind: 'tier', tier: 'capable' }, want: 'Capable' },
    { name: 'the top of any tier', setting: { kind: 'top_of_tier' }, want: 'Top of tier' },
    {
      name: 'the top of a tier',
      setting: { kind: 'top_of_tier', tier: 'frontier' },
      want: 'Top of Frontier',
    },
    { name: 'a model it knows', setting: { kind: 'model', model: 'model-a' }, want: 'Model A' },
    { name: 'a model it does not', setting: { kind: 'model', model: 'model-z' }, want: 'model-z' },
  ])('says $name', ({ setting, want }) => {
    expect(settingSummary(setting, names)).toBe(want);
  });
});

describe('the settings the editor builds', () => {
  it('leaves the minimum out for none, and keeps zero', () => {
    expect(automaticAtLeast(null)).toEqual({ kind: 'automatic' });
    expect(automaticAtLeast(0)).toEqual({ kind: 'automatic', minimum: 0 });
  });

  it('names a tier for Top of tier only when one is given', () => {
    expect(topOfTier(null)).toEqual({ kind: 'top_of_tier' });
    expect(topOfTier('capable')).toEqual({ kind: 'top_of_tier', tier: 'capable' });
  });

  it('keeps one select choice for Automatic however its minimum, and for Top of tier however its tier', () => {
    expect(settingValue(automaticAtLeast(60))).toBe(settingValue(automaticAtLeast(null)));
    expect(settingValue(topOfTier('capable'))).toBe(settingValue(topOfTier(null)));
  });
});
