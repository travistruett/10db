import type { ModelProfileDto, StepRole } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { offeredProfiles } from './offered';
import { roleDefault, strongerDefault } from './role-defaults';
import { label, seedCatalogue } from './test-catalogue';

const off = (...labels: string[]) => Object.fromEntries(labels.map((l) => [l, { enabled: false }]));
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const allOf = (model: string) => efforts.map((e) => `${model}@${e}`);

const choose = (
  role: StepRole,
  profiles: readonly ModelProfileDto[],
  floor: string | null = null,
) => roleDefault({ provider: 'claude', role, floor, profiles });
const pick = (
  role: StepRole,
  profiles: readonly ModelProfileDto[],
  floor: string | null = null,
) => {
  const choice = choose(role, profiles, floor);
  if (!choice) throw new Error(`no default for ${role}`);
  return choice;
};

describe('roleDefault', () => {
  it.each([
    { name: 'plan on the strongest', role: 'plan', want: 'opus@high' },
    { name: 'plan review on the strongest', role: 'plan_review', want: 'opus@high' },
    { name: 'review on the strongest', role: 'review', want: 'opus@high' },
    { name: 'implement on the balanced', role: 'implement', want: 'sonnet@high' },
    { name: 'QA on the fast', role: 'qa', want: 'haiku@medium' },
  ] as const)('runs $name model of the seeded catalogue', ({ role, want }) => {
    expect(label(pick(role, seedCatalogue()).profile)).toBe(want);
  });

  it.each([
    {
      name: 'the strongest is the strongest the account offers',
      role: 'review',
      aliases: ['haiku', 'sonnet'],
      want: 'sonnet@high',
    },
    {
      name: 'fast rises to the next model when the account offers no fast one',
      role: 'qa',
      aliases: ['sonnet', 'opus'],
      want: 'sonnet@medium',
    },
    {
      name: 'balanced prefers the stronger neighbour',
      role: 'implement',
      aliases: ['haiku', 'opus'],
      want: 'opus@high',
    },
    ...(['plan', 'plan_review', 'implement', 'review'] as const).map((role) => ({
      name: `${role} runs on the one model offered`,
      role,
      aliases: ['haiku'],
      want: 'haiku@high',
    })),
    {
      name: 'qa runs on the one model offered',
      role: 'qa',
      aliases: ['haiku'],
      want: 'haiku@medium',
    },
  ] as const)('$name', ({ role, aliases, want }) => {
    expect(label(pick(role, offeredProfiles(seedCatalogue(), aliases)).profile)).toBe(want);
  });

  it.each([
    {
      name: 'a disabled effort takes the nearest, the higher on a tie',
      role: 'implement',
      overrides: off('sonnet@high'),
      want: 'sonnet@xhigh',
    },
    {
      name: 'a model with every effort disabled is not offered',
      role: 'review',
      overrides: off(...allOf('opus')),
      want: 'sonnet@high',
    },
    {
      name: 'an enabled stronger family becomes the strongest',
      role: 'review',
      overrides: Object.fromEntries(allOf('fable').map((l) => [l, { enabled: true }])),
      want: 'fable@high',
    },
  ] as const)('$name', ({ role, overrides, want }) => {
    expect(label(pick(role, seedCatalogue(overrides)).profile)).toBe(want);
  });

  it.each([
    { name: 'a migration implement', role: 'implement', want: 'opus@xhigh' },
    { name: 'a security review', role: 'review', want: 'opus@xhigh' },
    { name: 'a QA step', role: 'qa', want: 'opus@high' },
  ] as const)(
    'raises $name to the strongest model, one effort up, under a floor',
    ({ role, want }) => {
      expect(label(pick(role, seedCatalogue(), 'migration').profile)).toBe(want);
    },
  );

  it('says which default chose the model and names a floor', () => {
    expect(pick('implement', seedCatalogue()).reason).toBe(
      'by role default: the balanced model offered',
    );
    expect(pick('review', seedCatalogue(), 'security-sensitive review').reason).toBe(
      'by role default: the strongest model offered, one effort up (floor: security-sensitive review)',
    );
  });

  it.each([
    {
      name: 'nothing is enabled',
      profiles: seedCatalogue(
        Object.fromEntries(
          efforts.flatMap((e) =>
            ['haiku', 'sonnet', 'opus'].map((m) => [`${m}@${e}`, { enabled: false }]),
          ),
        ),
      ),
    },
    {
      name: 'the account offers no Claude Code model',
      profiles: offeredProfiles(seedCatalogue(), ['opusplan']),
    },
  ])('chooses nothing when $name', ({ profiles }) => {
    expect(choose('implement', profiles)).toBeUndefined();
  });
});

describe('strongerDefault', () => {
  const at = (l: string, profiles = seedCatalogue()) => {
    const p = profiles.find((x) => label(x) === l);
    if (!p) throw new Error(l);
    return p;
  };
  it.each([
    { name: 'the next stronger model at the same effort', from: 'sonnet@high', want: 'opus@high' },
    {
      name: 'from the fast model to the balanced one',
      from: 'haiku@medium',
      want: 'sonnet@medium',
    },
    { name: 'the next effort on the strongest model', from: 'opus@high', want: 'opus@xhigh' },
    { name: 'nothing above the top', from: 'opus@max', want: null },
  ])('moves to $name', ({ from, want }) => {
    const profiles = seedCatalogue();
    const next = strongerDefault('claude', at(from, profiles), profiles);
    expect(next ? label(next) : null).toBe(want);
  });

  it('skips a model the account does not offer', () => {
    const profiles = offeredProfiles(seedCatalogue(), ['haiku', 'opus']);
    const next = strongerDefault('claude', at('haiku@low', profiles), profiles);
    expect(next ? label(next) : null).toBe('opus@low');
  });
});
