import { describe, expect, it } from 'vitest';
import { mintId } from './ids';
import { currentStep, StepIndexError, WorkstreamStep } from './steps';

const base: WorkstreamStep = {
  role: 'review',
  personaId: mintId('Persona'),
  personaName: 'Reviewer',
  tools: 'read_only',
  score: 'intelligence',
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
  ])('$name', ({ step, ok }) => {
    expect(WorkstreamStep.safeParse(step).success).toBe(ok);
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
      score: 'coding',
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
      score: 'coding',
    };
    expect(
      currentStep({ steps: [implement, base], stepIndex: 1, model: 'a', effort: 'low' }),
    ).toEqual(base);
  });
});
