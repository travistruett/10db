import { mintId, ModelTier, type ModelSetting, type PatternDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { chooseModel, type ChooseInput } from './choose-model';
import { strongerDefault } from './role-defaults';
import { label, testCatalogue, unscoredCatalogue } from './test-catalogue';

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

  it('a security-tagged task under the seeded High-risk work pattern is floored, and Top of tier takes the same model', () => {
    const seeded: PatternDto = {
      ...patternFor(TOP_OF_TIER),
      match: {
        roles: [],
        riskTags: ['security', 'auth', 'migration'],
        areas: [],
        retryOnly: false,
      },
    };
    for (const [ladder, want] of [
      ['one Capable and one Frontier', 'apex@xhigh'],
      ['Capable empty', 'apex@xhigh'],
      ['Frontier and Efficient only', 'apex@xhigh'],
      ['Frontier empty', 'big@xhigh'],
    ] as const)
      expect(
        choose(ladder, { patterns: [seeded], task: { ...security, modelSetting: null } }),
      ).toBe(want);
  });
});

/** Distinct models under the two keys, so a landing shows which key routing read. */
const SPLIT = { capable: 'small', frontier: 'mid' };

/** The model launched, which is the override's own name where it has no profile. */
const launched = (ladder: Ladder, over: Partial<ChooseInput>): string => {
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
  return choice.profile ? label(choice.profile) : choice.model;
};

/** The ladder with its Frontier model measured, so a step can score into either rung. */
const scoredLadder = () => [
  ...testCatalogue(),
  ...unscoredCatalogue({}, ['apex']).map((p, i) => ({
    ...p,
    scores: { intelligence: 60 + 2 * i },
    costPerTaskUsd: 9 + i,
  })),
];

describe('four rungs keep the account override of the strongest tier', () => {
  it.each([
    {
      name: 'a Capable landing reads the Capable key',
      ladder: 'one Capable and one Frontier',
      want: 'small@high',
    },
    {
      name: 'a Frontier landing reads the Frontier key',
      ladder: 'Capable empty',
      want: 'mid@high',
    },
    {
      name: 'a Frontier landing whose override has no profile here is launched as named',
      ladder: 'Frontier and Efficient only',
      want: 'mid',
    },
  ] as const)('a default review: $name', ({ ladder, want }) => {
    expect(launched(ladder, { tierOverrides: SPLIT })).toBe(want);
  });

  it('a floored review lands on Frontier and reads the Frontier key', () => {
    expect(
      launched('one Capable and one Frontier', {
        tierOverrides: SPLIT,
        task: { ...security, modelSetting: null },
      }),
    ).toBe('mid@xhigh');
  });

  it('Top of tier ignores the override and takes the dearest model', () => {
    expect(
      launched('one Capable and one Frontier', {
        tierOverrides: { capable: 'big', frontier: 'apex' },
        patterns: [patternFor(TOP_OF_TIER)],
      }),
    ).toBe('apex@high');
  });

  it.each([
    { name: 'a scored step that lands in Capable', need: 48, want: 'small@high' },
    { name: 'a scored step that lands in Frontier', need: 58, want: 'mid@high' },
  ])('$name reads the key of its landing rung', ({ need, want }) => {
    const choice = chooseModel({
      def: { role: 'review', need },
      persona: undefined,
      task: { riskTags: [], acceptanceCriteria: [], areas: [], modelSetting: null },
      project: { id: mintId('Project'), budgetCeiling: null },
      profiles: scoredLadder(),
      roleSettings: [],
      patterns: [],
      tierOverrides: SPLIT,
      stakes: { retry: false },
    });
    expect(choice.profile ? label(choice.profile) : choice.model).toBe(want);
  });

  it.each([
    { ladder: 'one Capable and one Frontier', want: 'small@high' },
    { ladder: 'Capable empty', want: 'mid@high' },
  ] as const)('a step started over in the refused model tier on $ladder', ({ ladder, want }) => {
    expect(launched(ladder, { tierOverrides: SPLIT, startOverTier: ModelTier.Capable })).toBe(want);
  });

  it('a gateway override naming a model with no profile is launched as named, on either rung', () => {
    expect(
      launched('one Capable and one Frontier', { tierOverrides: { capable: 'gw-large' } }),
    ).toBe('gw-large');
    expect(launched('Capable empty', { tierOverrides: { capable: 'gw-large' } })).toBe('gw-large');
  });

  it('an unset Frontier override is the Capable one, as one override covered both', () => {
    expect(launched('Capable empty', { tierOverrides: { capable: 'small' } })).toBe('small@high');
    expect(
      launched('Capable empty', { tierOverrides: { capable: 'small', frontier: 'mid' } }),
    ).toBe('mid@high');
    expect(launched('Capable empty', { tierOverrides: { frontier: 'mid' } })).toBe('mid@high');
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
