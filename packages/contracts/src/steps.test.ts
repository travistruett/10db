import { describe, expect, it } from 'vitest';
import { mintId } from './ids';
import { currentStep, planOf, StepIndexError, WorkstreamStep } from './steps';

const base: WorkstreamStep = {
  role: 'review',
  personaId: mintId('Persona'),
  personaName: 'Reviewer',
  tools: 'read_only',
  profileId: mintId('ModelProfile'),
  model: 'sonnet',
  effort: 'high',
  need: 48,
  reason: 'cheapest profile at or above 48',
  overBudget: false,
  pinned: false,
  status: 'pending',
  attempts: 0,
  startedAt: null,
  sessionFloor: 0,
  result: null,
  earlier: [],
  sentBack: 0,
  setting: null,
};

describe('WorkstreamStep', () => {
  it.each([
    { name: 'a pending step', step: base, ok: true },
    {
      name: 'a review result with a verdict and the session that gave it',
      step: {
        ...base,
        status: 'done',
        result: {
          summary: 'Looks right.',
          verdict: 'approve',
          sessionId: mintId('Session'),
          at: '2026-10-17T12:00:00.000Z',
        },
      },
      ok: true,
    },
    {
      name: 'a summary over 8000 characters',
      step: {
        ...base,
        result: {
          summary: 'x'.repeat(8001),
          verdict: null,
          sessionId: mintId('Session'),
          at: '2026-10-17T12:00:00.000Z',
        },
      },
      ok: false,
    },
    { name: 'a negative attempt count', step: { ...base, attempts: -1 }, ok: false },
    {
      name: 'a step that shipped at the retry limit and names its follow-up task',
      step: {
        ...base,
        shippedAtLimit: { followUpTaskId: mintId('Task'), followUpTitle: 'Resolve the findings' },
      },
      ok: true,
    },
    {
      name: 'a limit shipment that names no follow-up task',
      step: { ...base, shippedAtLimit: { followUpTitle: 'Resolve the findings' } },
      ok: false,
    },
  ])('$name', ({ step, ok }) => {
    expect(WorkstreamStep.safeParse(step).success).toBe(ok);
  });

  it('keeps the limit shipment when it parses', () => {
    const shippedAtLimit = {
      followUpTaskId: mintId('Task'),
      followUpTitle: 'Resolve the findings',
    };
    expect(WorkstreamStep.parse({ ...base, shippedAtLimit }).shippedAtLimit).toEqual(
      shippedAtLimit,
    );
  });
});

describe('currentStep', () => {
  it.each([
    { name: 'an index past the end of the plan', stepIndex: 2 },
    { name: 'a negative index', stepIndex: -1 },
  ])(
    'throws for $name on a non-empty plan instead of falling back to an editing step',
    ({ stepIndex }) => {
      expect(() =>
        currentStep({ steps: [base, base], stepIndex, model: 'a', effort: 'low' }),
      ).toThrow(StepIndexError);
    },
  );

  it('runs a workstream with no stored steps as one pinned implement step on its own model', () => {
    expect(currentStep({ steps: [], stepIndex: 0, model: 'opus', effort: 'high' })).toMatchObject({
      role: 'implement',
      tools: 'edit',
      model: 'opus',
      effort: 'high',
      pinned: true,
    });
  });

  it('returns the stored step at the index', () => {
    const implement: WorkstreamStep = {
      ...base,
      role: 'implement',
      tools: 'edit',
    };
    expect(
      currentStep({ steps: [implement, base], stepIndex: 1, model: 'a', effort: 'low' }),
    ).toEqual(base);
  });
});

describe('planOf', () => {
  const AT = '2026-10-17T12:00:00.000Z';
  const result = (summary: string) => ({
    summary,
    verdict: null,
    sessionId: mintId('Session'),
    at: AT,
  });
  const plan: WorkstreamStep = { ...base, role: 'plan', personaName: 'Planner' };
  const implement: WorkstreamStep = {
    ...base,
    role: 'implement',
    personaName: 'Implementer',
    tools: 'edit',
  };

  it.each([
    { name: 'no steps', steps: [], want: null },
    { name: 'a plan step that has not finished', steps: [plan, implement], want: null },
    {
      name: 'a plan step with its result',
      steps: [{ ...plan, result: result('Plan A') }, implement],
      want: { role: 'plan', personaName: 'Planner', summary: 'Plan A' },
    },
    {
      name: 'a build step that plans first and recorded its plan',
      steps: [{ ...implement, plansFirst: true as const, result: result('Plan B') }],
      want: { role: 'implement', personaName: 'Implementer', summary: 'Plan B' },
    },
    {
      name: 'a build step that plans first and has no plan yet',
      steps: [{ ...implement, plansFirst: true as const }],
      want: null,
    },
    {
      name: 'a build step that does not plan first',
      steps: [{ ...implement, result: result('Not a plan') }],
      want: null,
    },
    {
      name: 'a review result, which is not a plan',
      steps: [implement, { ...base, result: result('Looks right') }],
      want: null,
    },
    {
      name: 'the latest of two plans',
      steps: [
        { ...plan, result: result('Plan A') },
        { ...implement, plansFirst: true as const, result: result('Plan B') },
      ],
      want: { role: 'implement', personaName: 'Implementer', summary: 'Plan B' },
    },
  ])('$name', ({ steps, want }) => {
    expect(planOf(steps)).toEqual(want === null ? null : { ...want, at: AT });
  });
});
