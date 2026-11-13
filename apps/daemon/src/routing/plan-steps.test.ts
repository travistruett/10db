import { mintId, Rigor, type KindDto, type PersonaDto, type TaskKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { planSteps, type PlanInput } from './plan-steps';
import type { PlaybookScopes } from './playbook';
import { testCatalogue, unscoredCatalogue } from './test-catalogue';

const NOW = '2026-10-17T12:00:00.000Z';
const persona = (key: string, role: PersonaDto['role']): PersonaDto => ({
  id: mintId('Persona'),
  key,
  name: key,
  role,
  tools: role === 'implement' ? 'edit' : 'read_only',
  instructions: `${key} instructions`,
  skills: [],
  minimumScore: null,
  modelPin: null,
  archived: false,
  createdAt: NOW,
  updatedAt: NOW,
});
const defaults = [
  persona('planner', 'plan'),
  persona('plan-reviewer', 'plan_review'),
  persona('implementer', 'implement'),
  persona('reviewer', 'review'),
  persona('qa', 'qa'),
];
const empty: PlaybookScopes = { project: null, global: { rows: [], cells: [] } };
const kind = (key: string, fields: Partial<KindDto> = {}): KindDto => ({
  id: mintId('Kind'),
  key,
  label: key,
  description: '',
  minimumRigor: null,
  alwaysReviewed: false,
  failsAtLimit: false,
  ownCopy: false,
  toInbox: false,
  addsSteps: [],
  overrides: {},
  position: 0,
  ...fields,
});
const taskKinds = (...keys: string[]): TaskKind[] => keys.map((key) => ({ key, source: 'agent' }));
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  rigor: Rigor.Standard,
  task: { modelSetting: null, effortPin: null },
  taskKinds: [],
  kinds: [],
  playbook: empty,
  project: { budgetCeiling: null },
  personas: defaults,
  profiles: testCatalogue(),
  tierOverrides: {},
  ...over,
});
const summary = (plan: ReturnType<typeof planSteps>) =>
  plan.steps.map((s) => `${s.role}:${s.personaName}:${s.model}@${s.effort}`);

describe('planSteps: a plan per rigor on a scored account', () => {
  it.each([
    { rigor: Rigor.Light, want: ['implement:implementer:mid@low'] },
    {
      rigor: Rigor.Standard,
      want: ['implement:implementer:mid@high', 'review:reviewer:mid@high'],
    },
    {
      rigor: Rigor.Careful,
      want: ['plan:planner:mid@high', 'implement:implementer:mid@high', 'review:reviewer:big@high'],
    },
    {
      rigor: Rigor.Critical,
      want: [
        'plan:planner:big@high',
        'plan_review:plan-reviewer:big@max',
        'implement:implementer:big@high',
        'review:reviewer:big@max',
        'qa:qa:mid@low',
      ],
    },
  ])('$rigor', ({ rigor, want }) => {
    const plan = planSteps(input({ rigor }));
    expect(summary(plan)).toEqual(want);
    expect(plan.rigor).toBe(rigor);
  });

  it('puts a migration’s plan review and Frontier review on a Careful task', () => {
    const migration = kind('migration', {
      minimumRigor: Rigor.Careful,
      addsSteps: ['plan_review'],
      overrides: {
        plan_review: { personaId: null, model: { kind: 'tier', tier: 'capable' }, effort: 'high' },
        review: { personaId: null, model: { kind: 'tier', tier: 'capable' }, effort: 'high' },
      },
    });
    const plan = planSteps(
      input({ rigor: Rigor.Careful, kinds: [migration], taskKinds: taskKinds('migration') }),
    );
    expect(summary(plan)).toEqual([
      'plan:planner:mid@high',
      // The kind fixes the effort at high, so the review step routes among the high profiles.
      'plan_review:plan-reviewer:big@high',
      'implement:implementer:mid@high',
      'review:reviewer:big@high',
    ]);
  });

  it('starts each step pending, with the need its cell gave it', () => {
    const plan = planSteps(input());
    expect(plan.steps.map((s) => [s.status, s.attempts, s.startedAt, s.result, s.need])).toEqual([
      ['pending', 0, null, null, 40],
      ['pending', 0, null, null, 40],
    ]);
  });
});

describe('planSteps: without scores each cell runs its fallback rung', () => {
  const chosenBy = (reason: string) =>
    reason.startsWith('by the rigor’s fallback rung:') ? 'default' : reason;
  it.each([
    {
      rigor: Rigor.Standard,
      want: ['implement:mid@high:default', 'review:big@high:default'],
    },
    {
      rigor: Rigor.Careful,
      want: ['plan:big@xhigh:default', 'implement:mid@xhigh:default', 'review:big@xhigh:default'],
    },
    {
      rigor: Rigor.Critical,
      want: [
        'plan:big@xhigh:default',
        'plan_review:big@xhigh:default',
        'implement:big@xhigh:default',
        'review:big@xhigh:default',
        'qa:big@high:default',
      ],
    },
  ])('$rigor', ({ rigor, want }) => {
    const plan = planSteps(input({ rigor, profiles: unscoredCatalogue() }));
    expect(plan.steps.map((s) => `${s.role}:${s.model}@${s.effort}:${chosenBy(s.reason)}`)).toEqual(
      want,
    );
  });
});

describe('planSteps: who plays a step', () => {
  it('uses the persona a cell names', () => {
    const strict = persona('strict-reviewer', 'review');
    const plan = planSteps(
      input({
        personas: [...defaults, strict],
        playbook: {
          project: null,
          global: {
            rows: [],
            cells: [
              {
                rigor: Rigor.Standard,
                role: 'review',
                personaId: strict.id,
                model: null,
                effort: null,
              },
            ],
          },
        },
      }),
    );
    expect(plan.steps.map((s) => s.personaName)).toEqual(['implementer', 'strict-reviewer']);
  });

  it.each([
    { name: 'gone', personaId: mintId('Persona') },
    { name: 'of another role', personaId: defaults[0]?.id ?? mintId('Persona') },
  ])('runs the role’s own persona when a cell’s is $name', ({ personaId }) => {
    const plan = planSteps(
      input({
        playbook: {
          project: null,
          global: {
            rows: [],
            cells: [
              { rigor: Rigor.Standard, role: 'review', personaId, model: null, effort: null },
            ],
          },
        },
      }),
    );
    expect(plan.steps[1]?.personaName).toBe('reviewer');
  });

  it('runs a role with no persona as a bare step', () => {
    const plan = planSteps(input({ rigor: Rigor.Light, personas: [] }));
    expect(plan.steps[0]).toMatchObject({
      personaId: null,
      personaName: 'Implementer',
      tools: 'edit',
    });
  });
});

describe('planSteps: what a step records', () => {
  it('names the tier on each step when the account offers nothing, and does not throw', () => {
    const plan = planSteps(input({ profiles: [] }));
    expect(
      plan.steps.map((s) => [s.role, s.model, s.profileId, s.setting, s.reason, s.pinned]),
    ).toEqual([
      [
        'implement',
        'balanced',
        null,
        { kind: 'automatic', minimum: 40 },
        'no model offered for the balanced tier',
        false,
      ],
      [
        'review',
        'capable',
        null,
        { kind: 'automatic', minimum: 40 },
        'no model offered for the capable tier',
        false,
      ],
    ]);
  });

  it('records the setting that chose each step, and pins a cell that names one model', () => {
    const plan = planSteps(
      input({
        playbook: {
          project: null,
          global: {
            rows: [],
            cells: [
              {
                rigor: Rigor.Standard,
                role: 'review',
                personaId: null,
                model: { kind: 'model', model: 'small' },
                effort: null,
              },
            ],
          },
        },
      }),
    );
    expect(plan.steps.map((s) => [s.setting, s.pinned])).toEqual([
      [{ kind: 'automatic', minimum: 40 }, false],
      [{ kind: 'model', model: 'small' }, true],
    ]);
    expect(plan.steps[1]?.model).toBe('small');
  });

  it('lists the steps no profile within the ceiling can run', () => {
    const plan = planSteps(input({ project: { budgetCeiling: 0.5 } }));
    expect(plan.overBudget).toEqual([0, 1]);
    expect(plan.steps.map((s) => s.overBudget)).toEqual([true, true]);
  });
});
