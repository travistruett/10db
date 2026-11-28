import {
  BuilderOwns,
  StepRole,
  Verdict,
  currentStep,
  mintId,
  type BuilderCall,
  type WorkstreamStep,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { planGate } from './plan-approval';

// Whether a plan whose rigor asks for the builder's approval goes ahead without a card: only when the plan
// says its brief needs nothing, a plan review approved it, and that review found no call of the builder's.

const base = currentStep({ steps: [], stepIndex: 0, model: 'm', effort: 'medium' });

function step(
  role: StepRole,
  result: { verdict?: Verdict | null; builderCalls?: BuilderCall[] } | null,
): WorkstreamStep {
  return {
    ...base,
    role,
    result:
      result === null
        ? null
        : {
            summary: 'notes',
            verdict: result.verdict ?? null,
            sessionId: mintId('Session'),
            at: '2026-11-27T00:00:00.000Z',
            ...(result.builderCalls === undefined ? {} : { builderCalls: result.builderCalls }),
          },
  };
}

const money: BuilderCall = { owns: BuilderOwns.Money, call: 'Buy a paid Sentry plan' };
const guard: BuilderCall = { owns: BuilderOwns.Guardrails, call: 'Edits the git guard' };
const build = step(StepRole.Implement, null);
const approved = (calls?: BuilderCall[]) =>
  step(StepRole.PlanReview, {
    verdict: Verdict.Approve,
    ...(calls === undefined ? {} : { builderCalls: calls }),
  });

describe('planGate', () => {
  it.each([
    {
      name: 'a review that approved without saying whether it found calls cards it',
      steps: [step(StepRole.Plan, { builderCalls: [] }), approved(), build],
      asking: false,
      want: {
        kind: 'card',
        reason: "its plan review didn't say whether the plan makes calls of yours",
      },
    },
    {
      name: 'a review that found nothing and said so in an empty list goes ahead',
      steps: [step(StepRole.Plan, { builderCalls: [] }), approved([]), build],
      asking: false,
      want: { kind: 'ahead' },
    },
    {
      name: 'the builder asking to see plans cards it',
      steps: [step(StepRole.Plan, { builderCalls: [] }), approved([]), build],
      asking: true,
      want: { kind: 'card', owns: BuilderOwns.ProductAndTaste },
    },
    {
      name: 'a plan that did not say whether it needs the builder cards it',
      steps: [step(StepRole.Plan, {}), approved(), build],
      asking: false,
      want: { kind: 'card', reason: "the plan didn't say whether its brief needs you" },
    },
    {
      name: 'a brief that names a call cards it as that call',
      steps: [step(StepRole.Plan, { builderCalls: [money] }), approved(), build],
      asking: false,
      want: { kind: 'card', owns: BuilderOwns.Money },
    },
    {
      name: 'a plan with no plan review cards it',
      steps: [step(StepRole.Plan, { builderCalls: [] }), build],
      asking: false,
      want: { kind: 'card', reason: 'no plan review approved it' },
    },
    {
      name: 'a review that found a guardrail change the brief left out cards it',
      steps: [step(StepRole.Plan, { builderCalls: [] }), approved([guard]), build],
      asking: false,
      want: { kind: 'card', owns: BuilderOwns.Guardrails },
    },
    {
      name: 'a review of an earlier plan does not count for the plan made again after it',
      steps: [
        step(StepRole.PlanReview, { verdict: Verdict.Approve }),
        step(StepRole.Plan, { builderCalls: [] }),
        build,
      ],
      asking: false,
      want: { kind: 'card', reason: 'no plan review approved it' },
    },
  ])('$name', ({ steps, asking, want }) => {
    expect(planGate(steps, steps.length - 1, asking)).toMatchObject(want);
  });

  it('names the calls on the card', () => {
    const steps = [step(StepRole.Plan, { builderCalls: [money] }), approved(), build];
    const gate = planGate(steps, 2, false);
    expect(gate.kind === 'card' ? gate.reason : '').toContain('Buy a paid Sentry plan (Money)');
  });
});
