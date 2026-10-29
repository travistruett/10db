import { mintId, type FlowDto, type PersonaDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FLOWS } from './catalogue';
import { offeredProfiles } from './offered';
import { planSteps, type PlanInput } from './plan-steps';
import { NoProfileError } from './router';
import { seedCatalogue, testCatalogue } from './test-catalogue';

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
const project = { provider: 'claude', budgetCeiling: null } as const;
const task = (riskTags: ('security' | 'migration')[] = [], criteria = 1) => ({
  riskTags,
  acceptanceCriteria: Array.from({ length: criteria }, (_, i) => `c${String(i)}`),
});
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  flow: flow('standard'),
  task: task(),
  project,
  personas: defaults,
  bindings: [],
  profiles: testCatalogue(),
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
        'qa:qa:mid@high',
      ],
    },
    {
      name: 'full drops a plan review when the plan step was skipped',
      over: { flow: flow('full'), task: task(['security']) },
      want: ['implement:implementer:mid@high', 'review:reviewer:big@max'],
    },
    {
      name: 'a migration raises the implement step',
      over: { flow: flow('quick'), task: task(['migration']) },
      want: ['implement:implementer:big@high'],
    },
  ])('$name', ({ over, want }) => {
    expect(summary(planSteps(input(over)))).toEqual(want);
  });

  const measured = (
    scores: { intelligence: number | null; coding: number | null; agentic: number | null },
    costPerTaskUsd: number | null,
  ) => ({ scores, costPerTaskUsd });
  const chosenBy = (reason: string) =>
    reason.startsWith('by role default:')
      ? 'default'
      : reason.startsWith('by score:')
        ? 'score'
        : reason;
  it.each([
    {
      name: 'no scores: every step on its role default',
      profiles: seedCatalogue(),
      want: [
        'plan:opus@high:default',
        'implement:sonnet@high:default',
        'review:opus@high:default',
        'qa:haiku@medium:default',
      ],
    },
    {
      name: 'scores but no costs: every step on its role default',
      profiles: seedCatalogue({
        'sonnet@high': measured({ intelligence: 46, coding: 42, agentic: 40 }, null),
        'opus@high': measured({ intelligence: 51, coding: 50, agentic: 48 }, null),
      }),
      want: [
        'plan:opus@high:default',
        'implement:sonnet@high:default',
        'review:opus@high:default',
        'qa:haiku@medium:default',
      ],
    },
    {
      name: 'partial: two profiles measured, every step routed among them by score',
      profiles: seedCatalogue({
        'sonnet@high': measured({ intelligence: 46, coding: 42, agentic: null }, 0.75),
        'opus@high': measured({ intelligence: 51, coding: 50, agentic: null }, 2.5),
      }),
      want: [
        'plan:sonnet@high:score',
        'implement:sonnet@high:score',
        'review:opus@high:score',
        'qa:sonnet@high:score',
      ],
    },
    {
      name: 'partial: only an agentic score, so QA routes by score and the rest by role',
      profiles: seedCatalogue({
        'haiku@medium': measured({ intelligence: null, coding: null, agentic: 36 }, 0.08),
      }),
      want: [
        'plan:opus@high:default',
        'implement:sonnet@high:default',
        'review:opus@high:default',
        'qa:haiku@medium:score',
      ],
    },
    {
      name: 'full scores: by need, cost and budget',
      profiles: testCatalogue(),
      want: [
        'plan:mid@high:score',
        'implement:mid@high:score',
        'review:big@high:score',
        'qa:mid@high:score',
      ],
    },
  ])('routes with $name', ({ profiles, want }) => {
    const plan = planSteps(input({ flow: flow('full'), task: task([], 4), profiles }));
    expect(plan.steps.map((s) => `${s.role}:${s.model}@${s.effort}:${chosenBy(s.reason)}`)).toEqual(
      want,
    );
  });

  it('records each step’s score kind and starts it pending', () => {
    const plan = planSteps(input());
    expect(plan.steps.map((s) => [s.score, s.status, s.attempts, s.startedAt, s.result])).toEqual([
      ['coding', 'pending', 0, null, null],
      ['intelligence', 'pending', 0, null, null],
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

  it('routes an implement step on intelligence when AA gives no coding score', () => {
    const noCoding = testCatalogue().map((p) => ({ ...p, scores: { ...p.scores, coding: null } }));
    const plan = planSteps(input({ profiles: noCoding }));
    const implement = plan.steps[0];
    expect(implement).toMatchObject({ role: 'implement', score: 'intelligence', pinned: false });
    expect(implement?.profileId).not.toBeNull();
    expect(implement?.reason).toContain('AA gives no coding score; compared on intelligence');
  });

  it('says which source chose a model without scores, and runs a role default unpinned', () => {
    const plan = planSteps(input({ profiles: seedCatalogue() }));
    expect(plan.steps.map((s) => [s.model, s.effort, s.pinned, s.profileId === null])).toEqual([
      ['sonnet', 'high', false, false],
      ['opus', 'high', false, false],
    ]);
    expect(plan.steps[0]?.reason).toBe(
      'by role default: the balanced model offered; no profile has a coding score to compare on yet (sync Artificial Analysis to route by score)',
    );
    expect(plan.steps[1]?.reason).toBe(
      'by role default: the strongest model offered; no profile has an intelligence score to compare on yet (sync Artificial Analysis to route by score)',
    );
    expect(plan.overBudget).toEqual([]);
  });

  it('raises a role default under a floor', () => {
    const plan = planSteps(
      input({
        flow: flow('full'),
        task: task(['security', 'migration'], 4),
        profiles: seedCatalogue(),
      }),
    );
    expect(summary(plan)).toEqual([
      'plan:planner:opus@high',
      'plan_review:plan-reviewer:opus@xhigh',
      'implement:implementer:opus@xhigh',
      'review:reviewer:opus@xhigh',
      'qa:qa:haiku@medium',
    ]);
    expect(plan.steps[3]?.reason).toContain('(floor: security-sensitive review)');
  });

  it('throws NoProfileError when the account offers none of Claude Code’s models', () => {
    expect(() =>
      planSteps(input({ profiles: offeredProfiles(seedCatalogue(), ['opusplan']) })),
    ).toThrow(NoProfileError);
  });

  it('lists the steps no profile within the ceiling can run', () => {
    const plan = planSteps(input({ project: { ...project, budgetCeiling: 1.5 } }));
    expect(plan.overBudget).toEqual([1]);
    expect(plan.steps.map((s) => s.overBudget)).toEqual([false, true]);
  });
});
