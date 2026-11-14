import { Rigor, StepRole } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CELLS, DEFAULT_ROWS, FALLBACK_RUNG } from './playbook-defaults';

describe('the default playbook', () => {
  it.each([
    { rigor: Rigor.Light, steps: ['implement'] },
    { rigor: Rigor.Standard, steps: ['implement', 'review'] },
    { rigor: Rigor.Careful, steps: ['plan', 'implement', 'review'] },
    { rigor: Rigor.Critical, steps: ['plan', 'plan_review', 'implement', 'review', 'qa'] },
  ])('$rigor runs $steps', ({ rigor, steps }) => {
    expect(DEFAULT_ROWS[rigor]).toEqual(steps);
  });

  it.each([
    { rigor: Rigor.Light, role: StepRole.Implement, minimum: 35 },
    { rigor: Rigor.Standard, role: StepRole.Implement, minimum: 40 },
    { rigor: Rigor.Standard, role: StepRole.Review, minimum: 40 },
    { rigor: Rigor.Careful, role: StepRole.Plan, minimum: 45 },
    { rigor: Rigor.Careful, role: StepRole.Implement, minimum: 45 },
    { rigor: Rigor.Careful, role: StepRole.Review, minimum: 48 },
    { rigor: Rigor.Critical, role: StepRole.Plan, minimum: 50 },
    { rigor: Rigor.Critical, role: StepRole.PlanReview, minimum: 52 },
    { rigor: Rigor.Critical, role: StepRole.Implement, minimum: 50 },
    { rigor: Rigor.Critical, role: StepRole.Review, minimum: 52 },
    { rigor: Rigor.Critical, role: StepRole.Qa, minimum: 35 },
  ])('$rigor $role needs at least $minimum, with the role’s own persona and any effort', (c) => {
    expect(DEFAULT_CELLS[c.rigor][c.role]).toEqual({
      personaId: null,
      model: { kind: 'automatic', minimum: c.minimum },
      effort: null,
    });
  });

  it.each(Object.values(Rigor))(
    '%s has a cell and a fallback for exactly the steps it runs',
    (rigor) => {
      const steps = [...DEFAULT_ROWS[rigor]].sort();
      expect(Object.keys(DEFAULT_CELLS[rigor]).sort()).toEqual(steps);
      expect(Object.keys(FALLBACK_RUNG[rigor]).sort()).toEqual(steps);
    },
  );

  it.each([
    {
      rigor: Rigor.Light,
      role: StepRole.Implement,
      want: { tier: 'balanced', top: false, effort: 'high' },
    },
    {
      rigor: Rigor.Standard,
      role: StepRole.Review,
      want: { tier: 'capable', top: false, effort: 'high' },
    },
    {
      rigor: Rigor.Careful,
      role: StepRole.Plan,
      want: { tier: 'capable', top: false, effort: 'xhigh' },
    },
    {
      rigor: Rigor.Careful,
      role: StepRole.Implement,
      want: { tier: 'balanced', top: false, effort: 'xhigh' },
    },
    {
      rigor: Rigor.Critical,
      role: StepRole.Review,
      want: { tier: 'capable', top: true, effort: 'xhigh' },
    },
    {
      rigor: Rigor.Critical,
      role: StepRole.Qa,
      want: { tier: 'capable', top: true, effort: 'high' },
    },
  ])('without scores, $rigor $role runs $want', ({ rigor, role, want }) => {
    expect(FALLBACK_RUNG[rigor][role]).toEqual(want);
  });
});
