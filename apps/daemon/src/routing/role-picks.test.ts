import {
  mintId,
  type ModelProfileDto,
  type ModelSetting,
  type PersonaDto,
  type RoleSettingDto,
  type StepRole,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { rolePicks, type RolePicksInput } from './role-picks';
import { testCatalogue, unscoredCatalogue } from './test-catalogue';

const NOW = '2026-10-17T12:00:00.000Z';

const persona = (role: StepRole, key: string, over: Partial<PersonaDto> = {}): PersonaDto => ({
  id: mintId('Persona'),
  key,
  name: key,
  role,
  tools: 'read_only',
  instructions: 'x',
  skills: [],
  minimumScore: null,
  modelPin: null,
  archived: false,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const roleSetting = (role: StepRole, setting: ModelSetting): RoleSettingDto => ({
  role,
  projectId: null,
  setting,
});

const picksOf = (over: Partial<RolePicksInput> = {}) =>
  rolePicks({
    profiles: testCatalogue(),
    roleSettings: [],
    patterns: [],
    tierOverrides: {},
    personas: [],
    ...over,
  });

/** Each role's pick as `model@effort`, or null when nothing was chosen. */
const shown = (over: Partial<RolePicksInput> = {}) =>
  Object.fromEntries(
    picksOf(over).map((p) => [p.role, p.model === null ? null : `${p.model}@${String(p.effort)}`]),
  );

const disabled = (profiles: ModelProfileDto[], model: string) =>
  profiles.map((p) => (p.model === model ? { ...p, enabled: false } : p));

describe('rolePicks', () => {
  it('lists the roles in flow order with their starting needs', () => {
    expect(picksOf().map((p) => [p.role, p.need])).toEqual([
      ['plan', 45],
      ['plan_review', 48],
      ['implement', 40],
      ['review', 48],
      ['qa', 35],
    ]);
  });

  it.each([
    {
      name: 'the cheapest scored profile that reaches each role’s need',
      over: {},
      want: {
        plan: 'mid@high',
        plan_review: 'big@high',
        implement: 'mid@high',
        review: 'big@high',
        qa: 'mid@low',
      },
    },
    {
      name: 'a disabled model is never picked unasked',
      over: { profiles: disabled(testCatalogue(), 'mid') },
      want: {
        plan: 'big@high',
        plan_review: 'big@high',
        implement: 'big@high',
        review: 'big@high',
        qa: 'big@high',
      },
    },
    {
      name: 'a global role setting',
      over: { roleSettings: [roleSetting('qa', { kind: 'tier', tier: 'strongest' })] },
      want: {
        plan: 'mid@high',
        plan_review: 'big@high',
        implement: 'mid@high',
        review: 'big@high',
        qa: 'big@high',
      },
    },
    {
      name: 'a tier override wins for the tier a pick lands in',
      over: { tierOverrides: { balanced: 'small' } },
      want: {
        plan: 'small@high',
        plan_review: 'big@high',
        implement: 'small@high',
        review: 'big@high',
        qa: 'small@high',
      },
    },
    {
      name: 'a persona pin',
      over: {
        personas: [
          persona('implement', 'implementer', { modelPin: { model: 'small', effort: 'low' } }),
        ],
      },
      want: {
        plan: 'mid@high',
        plan_review: 'big@high',
        implement: 'small@low',
        review: 'big@high',
        qa: 'mid@low',
      },
    },
    {
      name: 'the role’s only persona when the seeded default is gone',
      over: {
        personas: [
          persona('review', 'house-reviewer', { modelPin: { model: 'big', effort: 'max' } }),
        ],
      },
      want: {
        plan: 'mid@high',
        plan_review: 'big@high',
        implement: 'mid@high',
        review: 'big@max',
        qa: 'mid@low',
      },
    },
    {
      name: 'no scores: each role’s default tier and effort',
      over: { profiles: unscoredCatalogue() },
      want: {
        plan: 'big@high',
        plan_review: 'big@high',
        implement: 'mid@high',
        review: 'big@high',
        qa: 'small@medium',
      },
    },
  ])('picks $name', ({ over, want }) => {
    expect(shown(over)).toEqual(want);
  });

  it('prices each pick on the account and carries routing’s reason', () => {
    const [plan] = picksOf();
    expect(plan).toMatchObject({ intelligence: 46, costPerTaskUsd: 1 });
    expect(plan?.profileId).not.toBeNull();
    expect(plan?.reason).toContain('cheapest profile at or above 45 intelligence');
  });

  it('says nothing was chosen, and that a task is refused, where no model reaches the need', () => {
    const picks = picksOf({ profiles: testCatalogue().filter((p) => p.model === 'small') });
    const implement = picks.find((p) => p.role === 'implement');
    expect(implement).toMatchObject({
      profileId: null,
      model: null,
      effort: null,
      costPerTaskUsd: null,
    });
    expect(implement?.reason).toBe(
      'No profile reaches 40 intelligence; a task planned on this account is refused here',
    );
  });

  it('names a tier override the account serves with no profile, with nothing measured', () => {
    const picks = picksOf({ tierOverrides: { balanced: 'house-model' } });
    expect(picks.find((p) => p.role === 'implement')).toMatchObject({
      profileId: null,
      model: 'house-model',
      intelligence: null,
      costPerTaskUsd: null,
    });
  });

  it('leaves the model empty where the account offers nothing for the tier', () => {
    const picks = picksOf({
      profiles: [],
      roleSettings: [roleSetting('qa', { kind: 'tier', tier: 'fast' })],
    });
    expect(picks.find((p) => p.role === 'qa')).toMatchObject({ profileId: null, model: null });
  });
});
