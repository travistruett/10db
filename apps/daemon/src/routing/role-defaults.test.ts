import { ModelTier } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { strongerDefault } from './role-defaults';
import { label, unscoredCatalogue } from './test-catalogue';

describe('strongerDefault', () => {
  const profiles = unscoredCatalogue({}, ['small', 'mid', 'big', 'peak']);
  const threeAboveBalanced = unscoredCatalogue({}, ['small', 'mid', 'big', 'peak', 'apex']);
  const at = (l: string, pool = profiles) => {
    const p = pool.find((x) => label(x) === l);
    if (!p) throw new Error(l);
    return p;
  };
  const climb = (from: string, pool = profiles, tier: ModelTier = ModelTier.Balanced) => {
    const next = strongerDefault(at(from, pool), pool, tier);
    return next ? label(next) : null;
  };

  it.each([
    { name: 'a tier up from the only model of its own', from: 'small@medium', want: 'mid@medium' },
    { name: 'the cheapest model of the next tier up', from: 'mid@high', want: 'big@high' },
    { name: 'the top of its tier from a cheaper model', from: 'big@high', want: 'peak@high' },
    { name: 'the next effort on the dearest model', from: 'peak@high', want: 'peak@xhigh' },
    { name: 'nothing above the top', from: 'peak@max', want: null },
  ])('moves to $name', ({ from, want }) => {
    expect(climb(from)).toBe(want);
  });

  it.each([
    {
      name: 'the top of a tier of three, skipping the middle',
      from: 'big@high',
      want: 'apex@high',
    },
    { name: 'the top of a tier of three from the middle', from: 'peak@high', want: 'apex@high' },
    { name: 'the next effort once on the top of three', from: 'apex@high', want: 'apex@xhigh' },
  ])('with three models in one tier goes to $name', ({ from, want }) => {
    expect(climb(from, threeAboveBalanced)).toBe(want);
  });

  it('skips a model the account does not offer', () => {
    const offered = unscoredCatalogue({}, ['small', 'big']);
    expect(climb('small@low', offered)).toBe('big@low');
  });

  it('never moves to a model routing may not pick, so the next effort is all that is left', () => {
    const off = unscoredCatalogue({}, ['small', 'mid']).map((p) =>
      p.model === 'mid' ? { ...p, enabled: false } : p,
    );
    expect(climb('small@low', off)).toBe('small@medium');
  });

  it.each([
    { name: 'the balanced tier', tier: ModelTier.Balanced, want: 'mid@high' },
    { name: 'the capable tier', tier: ModelTier.Capable, want: 'peak@high' },
    { name: 'the efficient tier', tier: ModelTier.Efficient, want: 'small@high' },
  ])('climbs from $name for a model with no tier or price, never downward', ({ tier, want }) => {
    const house = { ...at('small@high'), model: 'house', tier: null, outputPrice: null };
    const next = strongerDefault(house, profiles, tier);
    expect(next ? label(next) : null).toBe(want);
  });
});
