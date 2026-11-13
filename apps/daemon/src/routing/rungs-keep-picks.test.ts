import { mintId, ModelTier, type ModelSetting, type PatternDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { chooseModel, type ChooseInput } from './choose-model';
import { strongerDefault } from './role-defaults';
import { label, unscoredCatalogue } from './test-catalogue';

/**
 * Capable and Frontier together are what one Strongest tier was: every default, floor, Top of tier, override,
 * tier setting and escalation must pick the model it picked before the tier was split. Each ladder is
 * shaped like a maker's own line: `big` is the Capable model, `apex` the Frontier one.
 */
const LADDERS = {
  'one Capable and one Frontier': ['small', 'mid', 'big', 'apex'],
  'Capable empty': ['small', 'mid', 'apex'],
  'Frontier and Efficient only': ['small', 'apex'],
  'Frontier empty': ['small', 'mid', 'big'],
} as const;
type Ladder = keyof typeof LADDERS;

const profilesOf = (ladder: Ladder) => unscoredCatalogue({}, [...LADDERS[ladder]]);

const AT_CAPABLE = { kind: 'tier', tier: ModelTier.Capable } satisfies ModelSetting;
const AT_BALANCED = { kind: 'tier', tier: ModelTier.Balanced } satisfies ModelSetting;
const TOP_OF_TIER = { kind: 'top_of_tier' } satisfies ModelSetting;
const overrideOf = (model: string) => ({ capable: model, frontier: model });

const patternFor = (setting: ModelSetting): PatternDto => ({
  id: mintId('Pattern'),
  projectId: null,
  name: 'High-risk work',
  match: { roles: [], riskTags: [], areas: [], retryOnly: false },
  setting,
  position: 0,
});

const choose = (ladder: Ladder, over: Partial<ChooseInput>): string | null => {
  const choice = chooseModel({
    def: { role: 'review', need: 40 },
    persona: undefined,
    task: { riskTags: [], acceptanceCriteria: [], areas: [], modelSetting: null },
    project: { id: mintId('Project'), budgetCeiling: null },
    profiles: profilesOf(ladder),
    roleSettings: [],
    patterns: [],
    tierOverrides: {},
    stakes: { retry: false },
    ...over,
  });
  return choice.profile ? label(choice.profile) : null;
};

const security = { riskTags: ['security' as const], acceptanceCriteria: [], areas: [] };

describe('four rungs keep the pick of the three tiers', () => {
  it.each([
    { name: 'a review by default', ladder: 'one Capable and one Frontier', want: 'big@high' },
    { name: 'a review by default', ladder: 'Capable empty', want: 'apex@high' },
    { name: 'a review by default', ladder: 'Frontier and Efficient only', want: 'apex@high' },
    { name: 'a review by default', ladder: 'Frontier empty', want: 'big@high' },
  ] as const)('$name on $ladder', ({ ladder, want }) => {
    expect(choose(ladder, {})).toBe(want);
  });

  it.each([
    { ladder: 'one Capable and one Frontier', want: 'apex@xhigh' },
    { ladder: 'Capable empty', want: 'apex@xhigh' },
    { ladder: 'Frontier and Efficient only', want: 'apex@xhigh' },
    { ladder: 'Frontier empty', want: 'big@xhigh' },
  ] as const)('a floored security review on $ladder takes the top, one effort up', (c) => {
    expect(
      choose(c.ladder, {
        task: { ...security, modelSetting: null },
        def: { role: 'review', need: 40 },
      }),
    ).toBe(c.want);
  });

  it.each([
    { ladder: 'one Capable and one Frontier', want: 'apex@xhigh' },
    { ladder: 'Capable empty', want: 'apex@xhigh' },
    { ladder: 'Frontier empty', want: 'big@xhigh' },
  ] as const)('a floored step set to the Capable tier on $ladder still takes the top', (c) => {
    expect(
      choose(c.ladder, {
        task: { ...security, modelSetting: AT_CAPABLE },
        def: { role: 'review', need: 40 },
      }),
    ).toBe(c.want);
  });

  it.each([
    { ladder: 'one Capable and one Frontier', want: 'apex@high' },
    { ladder: 'Capable empty', want: 'apex@high' },
    { ladder: 'Frontier and Efficient only', want: 'apex@high' },
    { ladder: 'Frontier empty', want: 'big@high' },
  ] as const)('Top of tier for a review on $ladder takes the dearest model', (c) => {
    expect(choose(c.ladder, { patterns: [patternFor(TOP_OF_TIER)] })).toBe(c.want);
  });

  it.each([
    { ladder: 'one Capable and one Frontier', want: 'mid@high' },
    { ladder: 'Capable empty', want: 'mid@high' },
    { ladder: 'Frontier and Efficient only', want: 'apex@high' },
    { ladder: 'Frontier empty', want: 'mid@high' },
  ] as const)('a Balanced setting on $ladder, with a stronger rung preferred to a weaker', (c) => {
    expect(
      choose(c.ladder, {
        roleSettings: [{ role: 'review', projectId: null, setting: AT_BALANCED }],
      }),
    ).toBe(c.want);
  });

  it.each([
    { ladder: 'one Capable and one Frontier', want: 'big@high' },
    { ladder: 'Capable empty', want: 'apex@high' },
    { ladder: 'Frontier and Efficient only', want: 'apex@high' },
    { ladder: 'Frontier empty', want: 'big@high' },
  ] as const)('a Capable setting on $ladder', (c) => {
    expect(
      choose(c.ladder, {
        roleSettings: [{ role: 'review', projectId: null, setting: AT_CAPABLE }],
      }),
    ).toBe(c.want);
  });

  it.each([
    { ladder: 'one Capable and one Frontier', want: 'apex@high' },
    { ladder: 'Capable empty', want: 'apex@high' },
    { ladder: 'Frontier empty', want: 'big@high' },
  ] as const)('the override of the strongest tier on $ladder', (c) => {
    const model = c.want.split('@')[0] ?? '';
    expect(choose(c.ladder, { tierOverrides: overrideOf(model) })).toBe(c.want);
  });

  it('an override of the strongest tier is used by a step that scores into either rung', () => {
    const ladder = 'one Capable and one Frontier';
    expect(choose(ladder, { tierOverrides: overrideOf('apex') })).toBe('apex@high');
    expect(
      choose(ladder, {
        tierOverrides: overrideOf('big'),
        roleSettings: [{ role: 'review', projectId: null, setting: AT_CAPABLE }],
      }),
    ).toBe('big@high');
  });
});

describe('four rungs keep the escalation of the three tiers', () => {
  it.each([
    { ladder: 'one Capable and one Frontier', from: 'small@medium', want: 'mid@medium' },
    { ladder: 'one Capable and one Frontier', from: 'mid@high', want: 'big@high' },
    { ladder: 'one Capable and one Frontier', from: 'big@high', want: 'apex@high' },
    { ladder: 'one Capable and one Frontier', from: 'apex@high', want: 'apex@xhigh' },
    { ladder: 'Capable empty', from: 'mid@high', want: 'apex@high' },
    { ladder: 'Capable empty', from: 'apex@max', want: null },
    { ladder: 'Frontier and Efficient only', from: 'small@low', want: 'apex@low' },
    { ladder: 'Frontier empty', from: 'big@high', want: 'big@xhigh' },
  ] as const)('$from on $ladder goes to $want', ({ ladder, from, want }) => {
    const profiles = profilesOf(ladder);
    const start = profiles.find((p) => label(p) === from);
    if (!start) throw new Error(from);
    const next = strongerDefault(start, profiles, ModelTier.Balanced);
    expect(next ? label(next) : null).toBe(want);
  });
});
