import { mintId, type AccountModelDto, type StepRole, type WorkstreamStep } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { escalateStep, NoProfileError, route, UnmeasuredError } from './router';
import { label, testCatalogue, unscoredCatalogue } from './test-catalogue';

const none = { minimum: 0, why: null };
const at = (
  role: StepRole,
  need: number,
  opts: { floor?: { minimum: number; why: string }; ceiling?: number | null } = {},
) => ({
  role,
  need,
  floor: opts.floor ?? none,
  budgetCeiling: opts.ceiling ?? null,
  profiles: testCatalogue(),
  shortfall: 'refuse' as const,
});

describe('route', () => {
  it.each([
    {
      name: 'implement on intelligence',
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
    { name: 'QA on intelligence', input: at('qa', 35), want: 'mid@low', over: false },
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
          scores: { intelligence: 42 },
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
      'by score: cheapest profile at or above 52 intelligence (floor: security-sensitive review); over the budget ceiling of $3',
    );
  });

  it('throws NoProfileError when measured profiles exist but none reaches the minimum', () => {
    expect(() => route(at('implement', 99))).toThrow(NoProfileError);
  });

  it('takes the highest scoring profile when none reaches the minimum and the caller allows it', () => {
    const choice = route({ ...at('review', 99), shortfall: 'strongest' });
    expect(label(choice.profile)).toBe('big@max');
    expect(choice.reason).toBe('by score: none reaches 99 intelligence, so the highest scoring');
  });

  it('throws UnmeasuredError when no profile has any score to compare on', () => {
    const unmeasured = testCatalogue(
      Object.fromEntries(
        ['small@low', 'small@high', 'mid@low', 'mid@high', 'big@high', 'big@max'].map((k) => [
          k,
          { scores: { intelligence: null } },
        ]),
      ),
    );
    expect(() => route({ ...at('implement', 40), profiles: unmeasured })).toThrow(UnmeasuredError);
    expect(() => route({ ...at('review', 1), profiles: unmeasured })).toThrow(UnmeasuredError);
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
      profileId: p.id,
      model: p.model,
      effort: p.effort,
      need: 40,
      reason: 'by score: cheapest profile at or above 40 intelligence',
      overBudget: false,
      pinned: false,
      status: 'running',
      attempts: 1,
      startedAt: null,
      sessionFloor: 0,
      result: null,
      earlier: [],
      sentBack: 0,
      setting: null,
      ...extra,
    };
  };
  const input = (ceiling: number | null = null) => ({
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
      name: 'the next effort when the current profile’s score is no longer measured',
      from: stepOn('big@high', { need: 40 }),
      ceiling: null,
      want: 'big@max',
      escalated: true,
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
      label(p) === unmeasured ? { ...p, scores: { intelligence: null } } : p,
    );
    const result = escalateStep(from, { ...input(ceiling), profiles: measuredNow });
    expect(`${result.step.model}@${result.step.effort}`).toBe(want);
    expect(result.escalated).toBe(escalated);
  });

  it('names the true limit, with or without a score to compare on', () => {
    const dropped = profiles.map((p) =>
      label(p) === 'big@max' ? { ...p, scores: { intelligence: null } } : p,
    );
    expect(escalateStep(stepOn('big@max'), { ...input(), profiles: dropped }).step.reason).toBe(
      'kept big@max after the gate failed: no stronger model offered',
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

describe('escalateStep without scores', () => {
  const profiles = unscoredCatalogue();
  const stepOn = (name: string): WorkstreamStep => {
    const p = profiles.find((x) => label(x) === name);
    if (!p) throw new Error(name);
    return {
      role: 'implement',
      personaId: null,
      personaName: 'Implementer',
      tools: 'edit',
      profileId: p.id,
      model: p.model,
      effort: p.effort,
      need: 40,
      reason: 'by role default: the balanced model offered',
      overBudget: false,
      pinned: false,
      status: 'running',
      attempts: 1,
      startedAt: null,
      sessionFloor: 0,
      result: null,
      earlier: [],
      sentBack: 0,
      setting: null,
    };
  };
  const escalate = (from: string) =>
    escalateStep(stepOn(from), {
      budgetCeiling: 1,
      profiles,
      why: 'the gate failed',
    });

  it.each([
    { name: 'to the next stronger model', from: 'mid@high', want: 'big@high', escalated: true },
    {
      name: 'to the next effort on the strongest',
      from: 'big@high',
      want: 'big@xhigh',
      escalated: true,
    },
    { name: 'nowhere from the top', from: 'big@max', want: 'big@max', escalated: false },
  ])('climbs the role defaults $name', ({ from, want, escalated }) => {
    const result = escalate(from);
    expect(`${result.step.model}@${result.step.effort}`).toBe(want);
    expect(result.escalated).toBe(escalated);
  });

  it('says the role defaults moved it, or why they could not', () => {
    expect(escalate('mid@high').step).toMatchObject({
      profileId: profiles.find((p) => label(p) === 'big@high')?.id,
      reason:
        'escalated from mid@high after the gate failed: the next stronger model, by role default',
    });
    expect(escalate('big@max').step.reason).toBe(
      'kept big@max after the gate failed: no stronger model offered',
    );
  });
});

describe('escalateStep on a profile it cannot compare', () => {
  const scored = { intelligence: 46 };
  const strong = { intelligence: 52 };
  it.each([
    {
      name: 'a role default whose profile has a score but no cost',
      profiles: unscoredCatalogue({ 'mid@high': { scores: scored } }),
      from: 'mid@high',
      want: 'big@high',
    },
    {
      name: 'a role default after a sync measured only a stronger model',
      profiles: unscoredCatalogue({ 'big@high': { scores: strong, costPerTaskUsd: 2.5 } }),
      from: 'mid@high',
      want: 'big@high',
    },
    {
      name: 'a routed step whose profile lost its score',
      profiles: unscoredCatalogue({
        'mid@high': { scores: { intelligence: null }, costPerTaskUsd: 0.75 },
        'big@high': { scores: strong, costPerTaskUsd: 2.5 },
      }),
      from: 'mid@high',
      want: 'big@high',
    },
  ])('climbs the role defaults from $name', ({ profiles, from, want }) => {
    const here = profiles.find((p) => label(p) === from);
    if (!here) throw new Error(from);
    const step: WorkstreamStep = {
      role: 'implement',
      personaId: null,
      personaName: 'Implementer',
      tools: 'edit',
      profileId: here.id,
      model: here.model,
      effort: here.effort,
      need: 40,
      reason: 'by role default: the balanced model offered',
      overBudget: false,
      pinned: false,
      status: 'running',
      attempts: 1,
      startedAt: null,
      sessionFloor: 0,
      result: null,
      earlier: [],
      sentBack: 0,
      setting: null,
    };
    const result = escalateStep(step, {
      budgetCeiling: null,
      profiles,
      why: 'the gate failed',
    });
    expect(result.escalated).toBe(true);
    expect(`${result.step.model}@${result.step.effort}`).toBe(want);
    expect(result.step.reason).toBe(
      `escalated from ${from} after the gate failed: the next stronger model, by role default`,
    );
  });
});

describe('the budget ceiling on an account that pays per token', () => {
  // `mid` lists at $5 an output token in the test catalogue; mid@high costs $1 a task at that price.
  const account = (outputPrice: number | null, model = 'mid'): AccountModelDto => ({
    accountId: mintId('Account'),
    model,
    family: null,
    launchId: model,
    efforts: [],
    unusable: false,
    wordingMarkEndsAt: null,
    inputPrice: outputPrice === null ? null : outputPrice / 5,
    outputPrice,
    lastSeenAt: '2026-11-08T12:00:00.000Z',
  });
  const profiles = testCatalogue();
  const ceiling = { ceiling: 1.05 };

  it('counts a Bedrock copy that costs 10% more: just under the ceiling at the maker’s price is over', () => {
    const choice = route({ ...at('implement', 40, ceiling), accountModels: [account(5.5)] });
    expect(label(choice.profile)).toBe('mid@high');
    expect(choice.overBudget).toBe(true);
    expect(choice.reason).toContain('over the budget ceiling of $1.05');
    expect(choice.reason).toContain('$1.1 a task');
  });

  it('routes an account that pays the maker’s price exactly as the maker’s figure does', () => {
    const choice = route({ ...at('implement', 40, ceiling), accountModels: [account(5)] });
    expect(label(choice.profile)).toBe('mid@high');
    expect(choice.overBudget).toBe(false);
    expect(choice.reason).toBe(route(at('implement', 40, ceiling)).reason);
  });

  it('keeps the maker’s figure on a subscription, which has no price', () => {
    const choice = route({ ...at('implement', 40, ceiling), accountModels: [account(null)] });
    expect(choice.overBudget).toBe(false);
    expect(choice.reason).toBe(route(at('implement', 40, ceiling)).reason);
  });

  it('keeps the maker’s figure for a model the maker does not price', () => {
    const choice = route({
      ...at('implement', 40, ceiling),
      profiles: testCatalogue({ 'mid@high': { outputPrice: null } }),
      accountModels: [account(5.5)],
    });
    expect(label(choice.profile)).toBe('mid@high');
    expect(choice.overBudget).toBe(false);
  });

  it('prefers a profile that is within the ceiling once the account’s price is counted', () => {
    // big@high costs $2 at the maker's price, but this account's copy is half the price: $1 a task.
    const choice = route({
      ...at('implement', 47, ceiling),
      accountModels: [account(12.5, 'big')],
    });
    expect(label(choice.profile)).toBe('big@high');
    expect(choice.overBudget).toBe(false);
  });

  it('names the cost it compared when the choice is over the ceiling', () => {
    const choice = route({
      ...at('implement', 40, { ceiling: 1.05 }),
      accountModels: [account(7.5)],
    });
    expect(choice.reason).toContain('$1.5 a task');
  });

  it('applies the account’s price when a step climbs a rung', () => {
    const from = profiles.find((p) => label(p) === 'mid@low');
    if (!from) throw new Error('mid@low');
    const step: WorkstreamStep = {
      role: 'implement',
      personaId: null,
      personaName: 'Implementer',
      tools: 'edit',
      profileId: from.id,
      model: from.model,
      effort: from.effort,
      need: 30,
      reason: 'by score',
      overBudget: false,
      pinned: false,
      status: 'running',
      attempts: 1,
      startedAt: null,
      sessionFloor: 0,
      result: null,
      earlier: [],
      sentBack: 0,
      setting: null,
    };
    const base = { budgetCeiling: 1.05, profiles, why: 'the gate failed' };
    expect(escalateStep(step, base).step.effort).toBe('high');
    const result = escalateStep(step, { ...base, accountModels: [account(5.5)] });
    expect(result.escalated).toBe(false);
    expect(result.step.reason).toBe(
      'kept mid@low after the gate failed: no stronger profile within the budget ceiling of $1.05',
    );
  });
});
