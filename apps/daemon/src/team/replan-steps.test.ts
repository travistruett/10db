import { mintId, type StepRole, type WorkstreamStep } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { replanSteps } from './replan-steps';

const AT = '2026-11-13T12:00:00.000Z';
type Kind = 'pending' | 'ran' | 'rejected-before';

/** A step in a stored plan: `ran` has a verdict, and `rejected-before` kept an earlier round. */
const stored = (role: StepRole, kind: Kind = 'pending', label = 'old'): WorkstreamStep => ({
  role,
  personaId: null,
  personaName: label,
  tools: role === 'implement' ? 'edit' : 'read_only',
  profileId: null,
  model: 'sonnet',
  effort: 'medium',
  need: 40,
  reason: label,
  overBudget: false,
  pinned: false,
  status: kind === 'pending' ? 'pending' : 'done',
  attempts: 0,
  startedAt: kind === 'pending' ? null : AT,
  sessionFloor: 0,
  earlier:
    kind === 'rejected-before'
      ? [{ summary: 'notes', verdict: 'reject', sessionId: mintId('Session'), at: AT }]
      : [],
  sentBack: 0,
  setting: null,
  result:
    kind === 'ran'
      ? { summary: 'notes', verdict: 'reject', sessionId: mintId('Session'), at: AT }
      : null,
});
const planned = (...roles: StepRole[]): WorkstreamStep[] =>
  roles.map((role) => stored(role, 'pending', 'new'));

const shape = (steps: readonly WorkstreamStep[]) => steps.map((s) => `${s.role}:${s.personaName}`);

describe('replanSteps: only the steps still to come change', () => {
  it.each([
    {
      name: 'Standard to Careful at Build keeps Review, newly routed, and adds no Plan before it',
      steps: [stored('implement', 'ran'), stored('review')],
      at: 0,
      plan: planned('plan', 'implement', 'review'),
      want: ['implement:old', 'review:new'],
    },
    {
      name: 'Careful to Light at Build drops the Review still to come',
      steps: [stored('plan', 'ran'), stored('implement', 'ran'), stored('review')],
      at: 1,
      plan: planned('implement'),
      want: ['plan:old', 'implement:old'],
    },
    {
      name: 'Light to Critical at Build adds Review and QA',
      steps: [stored('implement', 'ran')],
      at: 0,
      plan: planned('plan', 'plan_review', 'implement', 'review', 'qa'),
      want: ['implement:old', 'review:new', 'qa:new'],
    },
    {
      name: 'to Light at Review has nothing after it, and the current step stays',
      steps: [stored('implement', 'ran'), stored('review', 'ran'), stored('qa')],
      at: 1,
      plan: planned('implement'),
      want: ['implement:old', 'review:old'],
    },
    {
      name: 'a send-back to Build after Review rejected, to Light, keeps the Review that ran and drops QA',
      steps: [stored('implement', 'ran'), stored('review', 'rejected-before'), stored('qa')],
      at: 0,
      plan: planned('implement'),
      want: ['implement:old', 'review:old'],
    },
    {
      name: 'a send-back to Plan after Plan Review rejected keeps that review and re-plans what follows',
      steps: [
        stored('plan', 'ran'),
        stored('plan_review', 'rejected-before'),
        stored('implement'),
        stored('review'),
        stored('qa'),
      ],
      at: 0,
      plan: planned('implement', 'review'),
      want: ['plan:old', 'plan_review:old', 'implement:new', 'review:new'],
    },
    {
      name: 'the same rigor routes the pending steps again and leaves the running one',
      steps: [stored('implement', 'ran'), stored('review')],
      at: 0,
      plan: planned('implement', 'review'),
      want: ['implement:old', 'review:new'],
    },
    {
      name: 'a plan with no step at the index changes nothing',
      steps: [],
      at: 0,
      plan: planned('implement'),
      want: [],
    },
  ])('$name', ({ steps, at, plan, want }) => {
    expect(shape(replanSteps(steps, at, plan))).toEqual(want);
  });

  it('never alters the current step or any before it', () => {
    const steps = [stored('plan', 'ran'), stored('implement', 'ran'), stored('review')];
    const result = replanSteps(steps, 1, planned('implement', 'review', 'qa'));
    expect(result.slice(0, 2)).toEqual(steps.slice(0, 2));
  });
});
