import { Rigor, type ModelProfileDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { rolePicks, type RolePicksInput } from './role-picks';
import { testCatalogue, unscoredCatalogue } from './test-catalogue';

const picksOf = (over: Partial<RolePicksInput> = {}, rigor?: Rigor) =>
  rolePicks({ profiles: testCatalogue(), tierOverrides: {}, ...over }, rigor);

/** Each role's pick as `model@effort`, or null when nothing was chosen. */
const shown = (over: Partial<RolePicksInput> = {}, rigor?: Rigor) =>
  Object.fromEntries(
    picksOf(over, rigor).map((p) => [
      p.role,
      p.model === null ? null : `${p.model}@${String(p.effort)}`,
    ]),
  );

const disabled = (profiles: ModelProfileDto[], model: string) =>
  profiles.map((p) => (p.model === model ? { ...p, enabled: false } : p));

describe('rolePicks', () => {
  it.each([
    {
      name: 'Standard by default: its own cells, and each other role at its own need',
      rigor: undefined,
      needs: [45, 48, 40, 40, 35],
    },
    { name: 'Light', rigor: Rigor.Light, needs: [45, 48, 35, 48, 35] },
    { name: 'Critical', rigor: Rigor.Critical, needs: [50, 52, 50, 52, 35] },
  ])('lists the roles in order with the needs of $name', ({ rigor, needs }) => {
    expect(picksOf({}, rigor).map((p) => [p.role, p.need])).toEqual([
      ['plan', needs[0]],
      ['plan_review', needs[1]],
      ['implement', needs[2]],
      ['review', needs[3]],
      ['qa', needs[4]],
    ]);
  });

  it.each([
    {
      name: 'Standard: the cheapest scored profile that reaches each need',
      over: {},
      rigor: Rigor.Standard,
      want: {
        plan: 'mid@high',
        plan_review: 'big@high',
        implement: 'mid@high',
        review: 'mid@high',
        qa: 'mid@low',
      },
    },
    {
      name: 'Critical: higher needs, so stronger picks',
      over: {},
      rigor: Rigor.Critical,
      want: {
        plan: 'big@high',
        plan_review: 'big@max',
        implement: 'big@high',
        review: 'big@max',
        qa: 'mid@low',
      },
    },
    {
      name: 'a disabled model is never picked unasked',
      over: { profiles: disabled(testCatalogue(), 'mid') },
      rigor: Rigor.Standard,
      want: {
        plan: 'big@high',
        plan_review: 'big@high',
        implement: 'big@high',
        review: 'big@high',
        qa: 'big@high',
      },
    },
    {
      name: 'a tier override wins for the tier a pick lands in',
      over: { tierOverrides: { balanced: 'small' } },
      rigor: Rigor.Standard,
      want: {
        plan: 'small@high',
        plan_review: 'big@high',
        implement: 'small@high',
        review: 'small@high',
        qa: 'small@high',
      },
    },
    {
      name: 'a global cell override',
      over: {
        playbook: {
          project: null,
          global: {
            rows: [],
            cells: [
              {
                rigor: Rigor.Standard,
                role: 'review' as const,
                personaId: null,
                model: { kind: 'tier' as const, tier: 'capable' as const },
                effort: null,
              },
            ],
          },
        },
      },
      rigor: Rigor.Standard,
      want: {
        plan: 'mid@high',
        plan_review: 'big@high',
        implement: 'mid@high',
        review: 'big@high',
        qa: 'mid@low',
      },
    },
    {
      name: 'no scores: Standard’s rungs, and each other role’s default tier and effort',
      over: { profiles: unscoredCatalogue() },
      rigor: Rigor.Standard,
      want: {
        plan: 'big@high',
        plan_review: 'big@high',
        implement: 'mid@high',
        review: 'big@high',
        qa: 'small@medium',
      },
    },
  ])('picks $name', ({ over, rigor, want }) => {
    expect(shown(over, rigor)).toEqual(want);
  });

  it('prices each pick on the account and carries routing’s reason', () => {
    const [plan] = picksOf();
    expect(plan).toMatchObject({ intelligence: 46, costPerTaskUsd: 1 });
    expect(plan?.profileId).not.toBeNull();
    expect(plan?.reason).toContain('cheapest profile at or above 45 intelligence');
  });

  it('takes the strongest model offered where none reaches the need, and says so', () => {
    const picks = picksOf({ profiles: testCatalogue().filter((p) => p.model === 'small') });
    const implement = picks.find((p) => p.role === 'implement');
    expect(implement).toMatchObject({ model: 'small', effort: 'high' });
    expect(implement?.reason).toContain('none reaches 40 intelligence, so the highest scoring');
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
    const picks = picksOf({ profiles: [] });
    expect(picks.find((p) => p.role === 'qa')).toMatchObject({ profileId: null, model: null });
  });
});
