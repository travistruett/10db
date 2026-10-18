import type { StepRole, WorkstreamStep } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { escalateStep, NoProfileError, route, UnmeasuredError } from './router';
import { label, testCatalogue } from './test-catalogue';

const none = { minimum: 0, why: null };
const at = (
  role: StepRole,
  need: number,
  opts: { floor?: { minimum: number; why: string }; ceiling?: number | null } = {},
) => ({
  provider: 'claude' as const,
  role,
  need,
  floor: opts.floor ?? none,
  budgetCeiling: opts.ceiling ?? null,
  profiles: testCatalogue(),
});

describe('route', () => {
  it.each([
    {
      name: 'implement on its coding score',
      input: at('implement', 40),
      want: 'mid@high',
      over: false,
    },
    {
      name: 'review on its intelligence score',
      input: at('review', 48),
      want: 'big@high',
      over: false,
    },
    { name: 'QA on its agentic score', input: at('qa', 35), want: 'mid@high', over: false },
    {
      name: 'the floor over a lower need',
      input: at('review', 48, { floor: { minimum: 52, why: 'security-sensitive review' } }),
      want: 'big@max',
      over: false,
    },
    {
      name: 'the cheapest of all for a small need',
      input: at('implement', 15),
      want: 'small@low',
      over: false,
    },
    {
      name: 'the cheapest that meets the need, over budget, when nothing within the ceiling does',
      input: at('implement', 40, { ceiling: 0.5 }),
      want: 'mid@high',
      over: true,
    },
    {
      name: 'a profile exactly at the ceiling',
      input: at('implement', 40, { ceiling: 1 }),
      want: 'mid@high',
      over: false,
    },
  ])('routes $name', ({ input, want, over }) => {
    const choice = route(input);
    expect(label(choice.profile)).toBe(want);
    expect(choice.overBudget).toBe(over);
  });

  it.each([
    {
      name: 'skips a disabled profile',
      overrides: { 'mid@high': { enabled: false } },
      want: 'big@high',
    },
    {
      name: 'breaks a cost tie on speed',
      overrides: { 'big@high': { costPerTaskUsd: 1, outputTokensPerSecond: 80 } },
      want: 'big@high',
    },
    {
      name: 'breaks a cost and speed tie on the lower score',
      overrides: {
        'big@high': {
          costPerTaskUsd: 1,
          outputTokensPerSecond: 70,
          scores: { intelligence: 50, coding: 42, agentic: 45 },
        },
      },
      want: 'big@high',
    },
    {
      name: 'skips a profile with no cost',
      overrides: { 'mid@high': { costPerTaskUsd: null } },
      want: 'big@high',
    },
  ])('$name', ({ overrides, want }) => {
    expect(
      label(route({ ...at('implement', 40), profiles: testCatalogue(overrides) }).profile),
    ).toBe(want);
  });

  it('explains its choice', () => {
    const choice = route(
      at('review', 48, { floor: { minimum: 52, why: 'security-sensitive review' }, ceiling: 3 }),
    );
    expect(choice.reason).toBe(
      'cheapest profile at or above 52 intelligence (floor: security-sensitive review); over the budget ceiling of $3',
    );
  });

  it('throws NoProfileError when measured profiles exist but none reaches the minimum', () => {
    expect(() => route(at('implement', 99))).toThrow(NoProfileError);
  });

  it('throws UnmeasuredError when no profile has the role’s score yet', () => {
    const unmeasured = testCatalogue(
      Object.fromEntries(
        ['small@low', 'small@high', 'mid@low', 'mid@high', 'big@high', 'big@max'].map((k) => [
          k,
          { scores: { intelligence: 1, coding: null, agentic: 1 } },
        ]),
      ),
    );
    expect(() => route({ ...at('implement', 40), profiles: unmeasured })).toThrow(UnmeasuredError);
    expect(label(route({ ...at('review', 1), profiles: unmeasured }).profile)).toBe('small@low');
  });
});

describe('escalateStep', () => {
  const profiles = testCatalogue();
  const stepOn = (name: string, extra: Partial<WorkstreamStep> = {}): WorkstreamStep => {
    const p = profiles.find((x) => label(x) === name);
    if (!p) throw new Error(name);
    return {
      role: 'implement',
      personaId: null,
      personaName: 'Implementer',
      tools: 'edit',
      score: 'coding',
      profileId: p.id,
      model: p.model,
      effort: p.effort,
      need: 40,
      reason: 'cheapest profile at or above 40 coding',
      overBudget: false,
      pinned: false,
      status: 'running',
      attempts: 1,
      startedAt: null,
      sessionFloor: 0,
      result: null,
      ...extra,
    };
  };
  const input = (ceiling: number | null = null) => ({
    provider: 'claude' as const,
    budgetCeiling: ceiling,
    profiles,
    why: 'the gate failed',
  });

  it.each([
    {
      name: 'one profile up its own score',
      from: stepOn('mid@high'),
      ceiling: null,
      want: 'big@high',
      escalated: true,
    },
    {
      name: 'nothing above the top',
      from: stepOn('big@max'),
      ceiling: null,
      want: 'big@max',
      escalated: false,
    },
    {
      name: 'nothing within the ceiling',
      from: stepOn('mid@high'),
      ceiling: 1.5,
      want: 'mid@high',
      escalated: false,
    },
    {
      name: 'nothing for a pinned step',
      from: stepOn('mid@high', { pinned: true }),
      ceiling: null,
      want: 'mid@high',
      escalated: false,
    },
    {
      name: 'nothing when the current profile’s score is no longer measured',
      from: stepOn('big@high', { need: 40 }),
      ceiling: null,
      want: 'big@high',
      escalated: false,
      unmeasured: 'big@high',
    },
    {
      name: 'nothing above the top, whatever the ceiling',
      from: stepOn('big@max'),
      ceiling: 10,
      want: 'big@max',
      escalated: false,
    },
  ])('moves $name', ({ from, ceiling, want, escalated, ...rest }) => {
    const unmeasured = 'unmeasured' in rest ? rest.unmeasured : null;
    const measuredNow = profiles.map((p) =>
      label(p) === unmeasured ? { ...p, scores: { ...p.scores, coding: null } } : p,
    );
    const result = escalateStep(from, { ...input(ceiling), profiles: measuredNow });
    expect(`${result.step.model}@${result.step.effort}`).toBe(want);
    expect(result.escalated).toBe(escalated);
  });

  it('names the unmeasured score and the true limit', () => {
    const dropped = profiles.map((p) =>
      label(p) === 'big@high' ? { ...p, scores: { ...p.scores, coding: null } } : p,
    );
    expect(escalateStep(stepOn('big@high'), { ...input(), profiles: dropped }).step.reason).toBe(
      'kept big@high after the gate failed: its coding score is no longer measured',
    );
    expect(escalateStep(stepOn('big@max'), input(10)).step.reason).toBe(
      'kept big@max after the gate failed: no stronger profile',
    );
  });

  it('says why it moved, or why it could not', () => {
    expect(escalateStep(stepOn('mid@low'), input(1.5)).step.reason).toBe(
      'escalated from mid@low after the gate failed',
    );
    expect(escalateStep(stepOn('mid@high'), input(1.5)).step.reason).toBe(
      'kept mid@high after the gate failed: no stronger profile within the budget ceiling of $1.5',
    );
  });
});
