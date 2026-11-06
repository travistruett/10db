import type { ModelProfileDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { offeredModels, offeredProfiles } from './index';
import { testCatalogue } from './test-catalogue';

describe('offeredProfiles', () => {
  it('keeps every profile when the account lists no aliases, and only its aliases when it does', () => {
    const all = testCatalogue();
    expect(offeredProfiles(all, undefined)).toEqual(all);
    const offered = offeredProfiles(all, ['mid']);
    expect(offered.length).toBeGreaterThan(0);
    expect(new Set(offered.map((p) => p.model))).toEqual(new Set(['mid']));
  });
});

describe('offeredModels', () => {
  const [first] = testCatalogue();
  if (first === undefined) throw new Error('the test catalogue is empty');
  const profile = (model: string, enabled = true): ModelProfileDto => ({
    ...first,
    model,
    enabled,
    provider: 'claude',
  });

  it('lists each Claude Code alias an account offers once, weakest first, enabled for routing or not', () => {
    const profiles = [
      profile('fable', false),
      profile('opus'),
      profile('opus'),
      profile('haiku'),
      profile('sonnet'),
    ];
    expect(offeredModels(profiles)).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
  });

  it('leaves out a model the catalogue does not rank', () => {
    expect(offeredModels([profile('mid')])).toEqual([]);
  });
});
