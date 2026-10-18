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

  it('throws UnmeasuredError when no profile has any score to compare on', () => {
    const unmeasured = testCatalogue(
      Object.fromEntries(
        ['small@low', 'small@high', 'mid@low', 'mid@high', 'big@high', 'big@max'].map((k) => [
          k,
          { scores: { intelligence: null, coding: null, agentic: null } },
        ]),
      ),
    );
    expect(() => route({ ...at('implement', 40), profiles: unmeasured })).toThrow(UnmeasuredError);
    expect(() => route({ ...at('review', 1), profiles: unmeasured })).toThrow(UnmeasuredError);
  });
});

describe('route when AA lacks the role’s score', () => {
  const withoutCoding = (labels: string[]) =>
    testCatalogue(
      Object.fromEntries(
        labels.map((k) => [k, { scores: { intelligence: 46, coding: null, agentic: 40 } }]),
      ),
    );

  it('compares on the role’s own score when every costed profile has it', () => {
    const choice = route({ ...at('implement', 45), profiles: testCatalogue() });
    expect(choice.score).toBe('coding');
    expect(label(choice.profile)).toBe('big@high');
    expect(choice.reason).toBe('cheapest profile at or above 45 coding');
  });

  it('compares every candidate on intelligence when one enabled profile lacks the score', () => {
    const profiles = testCatalogue({
      'big@max': { scores: { intelligence: 56, coding: null, agentic: 50 } },
    });
    const choice = route({ ...at('implement', 45), profiles });
    expect(choice.score).toBe('intelligence');
    expect(label(choice.profile)).toBe('mid@high');
    expect(choice.reason).toBe(
      'cheapest profile at or above 45 intelligence (AA gives no coding score; compared on intelligence)',
    );
  });

  it('names the floor and the budget after the fallback note', () => {
    const profiles = testCatalogue({
      'big@max': { scores: { intelligence: 56, coding: null, agentic: 50 } },
    });
    const choice = route({
      ...at('implement', 40, { floor: { minimum: 52, why: 'security-sensitive' }, ceiling: 3 }),
      profiles,
    });
    expect(choice.reason).toBe(
      'cheapest profile at or above 52 intelligence (AA gives no coding score; compared on intelligence) (floor: security-sensitive); over the budget ceiling of $3',
    );
  });

  it('falls back for QA on the agentic score the same way', () => {
    const profiles = testCatalogue({
      'mid@low': { scores: { intelligence: 38, coding: 36, agentic: null } },
    });
    const choice = route({ ...at('qa', 40), profiles });
    expect(choice.score).toBe('intelligence');
    expect(choice.reason).toContain('AA gives no agentic score; compared on intelligence');
  });

  it('is not stopped by a disabled profile that has the score', () => {
    const profiles = testCatalogue({
      'mid@low': { scores: { intelligence: 38, coding: null, agentic: 30 } },
      'big@max': { enabled: false },
    });
    expect(route({ ...at('implement', 40), profiles }).score).toBe('intelligence');
  });

  it('ignores an uncosted profile that lacks the score', () => {
    const profiles = testCatalogue({
      'mid@low': { scores: { intelligence: 38, coding: null, agentic: 30 }, costPerTaskUsd: null },
    });
    expect(route({ ...at('implement', 40), profiles }).score).toBe('coding');
  });

  it('uses the intelligence-only catalogue throughout', () => {
    const profiles = withoutCoding([
      'small@low',
      'small@high',
      'mid@low',
      'mid@high',
      'big@high',
      'big@max',
    ]);
    const choice = route({ ...at('implement', 40), profiles });
    expect(choice.score).toBe('intelligence');
    expect(label(choice.profile)).toBe('small@low');
  });

  it('is not stopped by a disabled profile that lacks the score but has intelligence', () => {
    const profiles = testCatalogue({
      'mid@low': { enabled: false, scores: { intelligence: 38, coding: null, agentic: 30 } },
    });
    expect(route({ ...at('implement', 40), profiles }).score).toBe('coding');
  });

  it('keeps the role’s score when the only profile without it has no intelligence either', () => {
    const profiles = testCatalogue({
      'big@max': { scores: { intelligence: null, coding: 54, agentic: null } },
    });
    const choice = route({ ...at('qa', 35), profiles });
    expect(choice.score).toBe('agentic');
    expect(choice.reason).toBe('cheapest profile at or above 35 agentic');
  });

  it('falls back when a costed profile has intelligence but not the role’s score', () => {
    const profiles = testCatalogue({
      'big@max': { scores: { intelligence: 56, coding: null, agentic: 50 } },
    });
    expect(route({ ...at('implement', 40), profiles }).score).toBe('intelligence');
  });

  it('throws UnmeasuredError naming the kind it tried when no profile has any usable score', () => {
    const profiles = testCatalogue(
      Object.fromEntries(
        ['small@low', 'small@high', 'mid@low', 'mid@high', 'big@high', 'big@max'].map((k) => [
          k,
          { scores: { intelligence: null, coding: null, agentic: null } },
        ]),
      ),
    );
    expect.assertions(2);
    try {
      route({ ...at('qa', 1), profiles });
    } catch (error) {
      expect(error).toBeInstanceOf(UnmeasuredError);
      expect(error instanceof UnmeasuredError && error.kind).toBe('agentic');
    }
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

  it('escalates a step routed on intelligence by fallback up intelligence', () => {
    const noCoding = profiles.map((p) => ({ ...p, scores: { ...p.scores, coding: null } }));
    const from = stepOn('mid@low', { score: 'intelligence', need: 30 });
    const result = escalateStep(from, { ...input(), profiles: noCoding });
    expect(result.escalated).toBe(true);
    expect(`${result.step.model}@${result.step.effort}`).toBe('mid@high');
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
