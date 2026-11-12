import { mintId, type FlowDto, type PersonaDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FLOWS } from './catalogue';
import { planSteps, type PlanInput } from './plan-steps';
import { testCatalogue, unscoredCatalogue } from './test-catalogue';

const NOW = '2026-10-17T12:00:00.000Z';
const flow = (name: string, steps?: FlowDto['steps']): FlowDto => {
  const def = DEFAULT_FLOWS.find((f) => f.name === name);
  return {
    id: mintId('Flow'),
    name,
    steps:
      steps ??
      (def?.steps ?? []).map((s) => ({ ...s, skip: s.skip ?? [], persona: s.persona ?? null })),
    createdAt: NOW,
    updatedAt: NOW,
  };
};
const persona = (
  key: string,
  role: PersonaDto['role'],
  extra: Partial<PersonaDto> = {},
): PersonaDto => ({
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
  ...extra,
});
const defaults = [
  persona('planner', 'plan'),
  persona('plan-reviewer', 'plan_review'),
  persona('implementer', 'implement'),
  persona('reviewer', 'review'),
  persona('qa', 'qa'),
];
const project = { id: mintId('Project'), budgetCeiling: null } as const;
const task = (riskTags: ('security' | 'migration')[] = [], criteria = 1) => ({
  riskTags,
  acceptanceCriteria: Array.from({ length: criteria }, (_, i) => `c${String(i)}`),
  areas: [],
  modelSetting: null,
});
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  flow: flow('standard'),
  task: task(),
  project,
  personas: defaults,
  bindings: [],
  profiles: testCatalogue(),
  roleSettings: [],
  patterns: [],
  tierOverrides: {},
  ...over,
});
const summary = (plan: ReturnType<typeof planSteps>) =>
  plan.steps.map((s) => `${s.role}:${s.personaName}:${s.model}@${s.effort}`);

describe('planSteps', () => {
  it.each([
    {
      name: 'standard: implement then review',
      over: {},
      want: ['implement:implementer:mid@high', 'review:reviewer:big@high'],
    },
    {
      name: 'full on a small, safe task skips the plan, the plan review and QA',
      over: { flow: flow('full') },
      want: ['implement:implementer:mid@high', 'review:reviewer:big@high'],
    },
    {
      name: 'full on a large security task keeps every step and raises the reviews',
      over: { flow: flow('full'), task: task(['security'], 4) },
      want: [
        'plan:planner:mid@high',
        'plan_review:plan-reviewer:big@max',
        'implement:implementer:mid@high',
        'review:reviewer:big@max',
        'qa:qa:mid@low',
      ],
    },
    {
      name: 'full drops a plan review when the plan step was skipped',
      over: { flow: flow('full'), task: task(['security']) },
      want: ['implement:implementer:mid@high', 'review:reviewer:big@max'],
    },
    {
      name: 'a migration floors the implement step, which mid already clears on intelligence',
      over: { flow: flow('quick'), task: task(['migration']) },
      want: ['implement:implementer:mid@high'],
    },
  ])('$name', ({ over, want }) => {
    expect(summary(planSteps(input(over)))).toEqual(want);
  });

  const measured = (scores: { intelligence: number | null }, costPerTaskUsd: number | null) => ({
    scores,
    costPerTaskUsd,
  });
  const chosenBy = (reason: string) =>
    reason.startsWith('by role default:')
      ? 'default'
      : reason.startsWith('by score:')
        ? 'score'
        : reason;
  it.each([
    {
      name: 'no scores: every step on its role default',
      profiles: unscoredCatalogue(),
      want: [
        'plan:big@high:default',
        'implement:mid@high:default',
        'review:big@high:default',
        'qa:small@medium:default',
      ],
    },
    {
      name: 'scores but no costs: every step on its role default',
      profiles: unscoredCatalogue({
        'mid@high': measured({ intelligence: 46 }, null),
        'big@high': measured({ intelligence: 51 }, null),
      }),
      want: [
        'plan:big@high:default',
        'implement:mid@high:default',
        'review:big@high:default',
        'qa:small@medium:default',
      ],
    },
    {
      name: 'partial: two profiles measured, every step routed among them by score',
      profiles: unscoredCatalogue({
        'mid@high': measured({ intelligence: 46 }, 0.75),
        'big@high': measured({ intelligence: 51 }, 2.5),
      }),
      want: [
        'plan:mid@high:score',
        'implement:mid@high:score',
        'review:big@high:score',
        'qa:mid@high:score',
      ],
    },
    {
      name: 'full scores: by need, cost and budget',
      profiles: testCatalogue(),
      want: [
        'plan:mid@high:score',
        'implement:mid@high:score',
        'review:big@high:score',
        'qa:mid@low:score',
      ],
    },
  ])('routes with $name', ({ profiles, want }) => {
    const plan = planSteps(input({ flow: flow('full'), task: task([], 4), profiles }));
    expect(plan.steps.map((s) => `${s.role}:${s.model}@${s.effort}:${chosenBy(s.reason)}`)).toEqual(
      want,
    );
  });

  it('starts each step pending', () => {
    const plan = planSteps(input());
    expect(plan.steps.map((s) => [s.status, s.attempts, s.startedAt, s.result])).toEqual([
      ['pending', 0, null, null],
      ['pending', 0, null, null],
    ]);
  });

  it('uses a step’s own persona over the team’s binding', () => {
    const sec = persona('security-reviewer', 'review');
    const plan = planSteps(
      input({
        flow: flow('two-reviews', [
          { role: 'implement', need: 40, skip: [], persona: null },
          { role: 'review', need: 48, skip: [], persona: null },
          { role: 'review', need: 48, skip: [], persona: 'security-reviewer' },
        ]),
        personas: [...defaults, sec],
      }),
    );
    expect(plan.steps.map((s) => s.personaName)).toEqual([
      'implementer',
      'reviewer',
      'security-reviewer',
    ]);
  });

  it('uses the persona the team binds to a role, and its pin over the router', () => {
    const pinned = persona('opus-reviewer', 'review', {
      modelPin: { model: 'big', effort: 'max' },
    });
    const plan = planSteps(
      input({
        personas: [...defaults, pinned],
        bindings: [{ role: 'review', personaId: pinned.id }],
      }),
    );
    expect(plan.steps[1]).toMatchObject({
      personaId: pinned.id,
      model: 'big',
      effort: 'max',
      pinned: true,
      reason: 'pinned by opus-reviewer',
    });
  });

  it('raises a step to the persona’s minimum score', () => {
    const strict = persona('reviewer', 'review', { minimumScore: 52 });
    const plan = planSteps(
      input({ personas: [...defaults.filter((p) => p.key !== 'reviewer'), strict] }),
    );
    expect(plan.steps[1]).toMatchObject({ model: 'big', effort: 'max' });
    expect(plan.steps[1]?.reason).toContain('floor: reviewer minimum');
  });

  it('runs the role’s default when a step names a persona that is gone or archived', () => {
    const plan = planSteps(
      input({
        flow: flow('ghost', [
          { role: 'implement', need: 40, skip: [], persona: null },
          { role: 'review', need: 48, skip: [], persona: 'old-reviewer' },
        ]),
      }),
    );
    expect(plan.steps[1]?.personaName).toBe('reviewer');
  });

  it('runs a role with no persona as a bare step', () => {
    const plan = planSteps(input({ flow: flow('quick'), personas: [] }));
    expect(plan.steps[0]).toMatchObject({
      personaId: null,
      personaName: 'Implementer',
      tools: 'edit',
    });
  });

  it('says which source chose a model without scores, and runs a role default unpinned', () => {
    const plan = planSteps(input({ profiles: unscoredCatalogue() }));
    expect(plan.steps.map((s) => [s.model, s.effort, s.pinned, s.profileId === null])).toEqual([
      ['mid', 'high', false, false],
      ['big', 'high', false, false],
    ]);
    expect(plan.steps[0]?.reason).toBe(
      'by role default: the cheapest model of the balanced tier; no profile has an intelligence score to compare on yet (sync Artificial Analysis to route by score)',
    );
    expect(plan.steps[1]?.reason).toBe(
      'by role default: the cheapest model of the strongest tier; no profile has an intelligence score to compare on yet (sync Artificial Analysis to route by score)',
    );
    expect(plan.overBudget).toEqual([]);
  });

  it('raises a role default under a floor', () => {
    const plan = planSteps(
      input({
        flow: flow('full'),
        task: task(['security', 'migration'], 4),
        profiles: unscoredCatalogue(),
      }),
    );
    expect(summary(plan)).toEqual([
      'plan:planner:big@high',
      'plan_review:plan-reviewer:big@xhigh',
      'implement:implementer:big@xhigh',
      'review:reviewer:big@xhigh',
      'qa:qa:small@medium',
    ]);
    expect(plan.steps[3]?.reason).toContain('(floor: security-sensitive review)');
  });

  it('names the tier on each step when the account offers nothing, and does not throw', () => {
    const plan = planSteps(input({ profiles: [] }));
    expect(
      plan.steps.map((s) => [s.role, s.model, s.profileId, s.setting, s.reason, s.pinned]),
    ).toEqual([
      [
        'implement',
        'balanced',
        null,
        { kind: 'automatic' },
        'no model offered for the balanced tier',
        false,
      ],
      [
        'review',
        'strongest',
        null,
        { kind: 'automatic' },
        'no model offered for the strongest tier',
        false,
      ],
    ]);
  });

  it('records the setting that chose each step, so a later list can choose again', () => {
    const plan = planSteps(
      input({
        roleSettings: [
          { role: 'review', projectId: null, setting: { kind: 'tier', tier: 'fast' } },
        ],
      }),
    );
    expect(plan.steps.map((s) => s.setting)).toEqual([
      { kind: 'automatic' },
      { kind: 'tier', tier: 'fast' },
    ]);
    expect(plan.steps[1]?.model).toBe('small');
  });

  it('lists the steps no profile within the ceiling can run', () => {
    const plan = planSteps(input({ project: { ...project, budgetCeiling: 1.5 } }));
    expect(plan.overBudget).toEqual([1]);
    expect(plan.steps.map((s) => s.overBudget)).toEqual([false, true]);
  });
});
