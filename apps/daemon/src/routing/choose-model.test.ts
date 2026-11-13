import type { Effort } from '@10db/contracts';
import {
  mintId,
  ModelStatus,
  ModelTier,
  type ModelProfileDto,
  type ModelSetting,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { chooseModel, type ChooseInput } from './choose-model';
import { ROLE_DEFAULT } from './role-defaults';
import { label, testCatalogue, unscoredCatalogue } from './test-catalogue';

/** What a reason says when no profile has a score to route on. */
const UNSCORED =
  '; no profile has an intelligence score to compare on yet (sync Artificial Analysis to route by score)';
const NOW = '2026-10-17T12:00:00.000Z';

/** Two Capable models, the dearer one only in the pool when a test asks for it. */
const peakRows = (): ModelProfileDto[] => unscoredCatalogue({}, ['peak']);
/** Peak, measured: each effort scores two points more and costs a dollar more than the one before. */
const scoredPeak = (): ModelProfileDto[] =>
  peakRows().map((p, i) => ({
    ...p,
    scores: { intelligence: 52 + 2 * i },
    costPerTaskUsd: 8 + i,
  }));

/** The rung a cell would fall back to for the role: its default tier and effort. */
const rungOf = (role: ChooseInput['def']['role']): NonNullable<ChooseInput['fallback']> => ({
  tier: ROLE_DEFAULT[role].tier,
  top: false,
  effort: ROLE_DEFAULT[role].effort,
});

const input = (over: Partial<ChooseInput> = {}): ChooseInput => {
  const def = over.def ?? { role: 'implement', need: 40 };
  return {
    def,
    requirements: [{ kind: 'automatic' }],
    effort: null,
    fallback: rungOf(def.role),
    pinned: false,
    task: { modelSetting: null, effortPin: null },
    project: { budgetCeiling: null },
    profiles: testCatalogue(),
    tierOverrides: {},
    ...over,
  };
};
const task = (over: { modelSetting?: ModelSetting; effortPin?: Effort } = {}) => ({
  modelSetting: over.modelSetting ?? null,
  effortPin: over.effortPin ?? null,
});
const pick = (over: Partial<ChooseInput> = {}): string | null => {
  const choice = chooseModel(input(over));
  return choice.profile ? label(choice.profile) : null;
};

describe('chooseModel: a setting the account cannot honour', () => {
  const ghost: ModelSetting = { kind: 'model', model: 'ghost' };
  const retired = unscoredCatalogue().map((p) =>
    p.model === 'mid' ? { ...p, status: ModelStatus.Retired, tier: null, enabled: false } : p,
  );
  const take = (over: Partial<ChooseInput>) =>
    chooseModel(input({ profiles: unscoredCatalogue(), ...over }));

  it.each([
    { name: 'the task', over: { task: task({ modelSetting: ghost }) } },
    { name: 'a requirement', over: { requirements: [ghost] } },
  ])('takes the role’s tier choice when $name names a model the account lacks', ({ over }) => {
    const choice = take(over);
    expect(label(choice.profile ?? failed())).toBe('mid@high');
    expect(choice.setting).toEqual(ghost);
    expect(choice.reason).toContain('ghost is not offered by this account, so the balanced tier');
  });

  it('keeps a cell’s one model at the nearest effort it offers, and holds it against a retry', () => {
    const choice = take({
      requirements: [{ kind: 'model', model: 'mid' }],
      effort: 'max',
      fallback: { tier: 'balanced', top: false, effort: 'max' },
      pinned: true,
    });
    expect(choice.pinned).toBe(true);
    expect(label(choice.profile ?? failed())).toBe('mid@max');
  });

  it('does not hold a retry on a cell’s model the account lacks', () => {
    const choice = take({ requirements: [ghost], pinned: true });
    expect(choice.pinned).toBe(false);
    expect(label(choice.profile ?? failed())).toBe('mid@high');
  });

  it('takes the tier’s choice for a model its maker has retired', () => {
    const choice = take({
      profiles: retired,
      def: { role: 'implement', need: 40 },
      task: task({ modelSetting: { kind: 'model', model: 'mid' } }),
    });
    expect(label(choice.profile ?? failed())).toBe('big@high');
    expect(choice.reason).toContain('mid is not offered by this account');
  });

  it('never throws', () => {
    expect(() => take({ profiles: [], task: task({ modelSetting: ghost }) })).not.toThrow();
  });
});

describe('chooseModel: unknown models', () => {
  const house = unscoredCatalogue({}, ['small']).map((p) => ({
    ...p,
    model: 'house',
    tier: null,
    status: ModelStatus.Unknown,
    enabled: false,
  }));
  const profiles = [...unscoredCatalogue(), ...house];

  it('never picks one automatically', () => {
    const picked = (['plan', 'implement', 'qa'] as const).map((role) =>
      pick({ profiles, def: { role, need: 20 } }),
    );
    expect(picked.every((p) => p !== null && !p.startsWith('house'))).toBe(true);
    expect(pick({ profiles: house })).toBeNull();
  });

  it('honours one the builder names, while the account offers it', () => {
    expect(
      pick({ profiles, task: task({ modelSetting: { kind: 'model', model: 'house' } }) }),
    ).toBe('house@high');
  });
});

describe('chooseModel: a tier and the top of it', () => {
  const both = [...unscoredCatalogue(), ...peakRows()];
  it.each([
    {
      name: 'a tier runs its cheapest model',
      setting: { kind: 'tier', tier: 'capable' },
      role: 'implement',
      want: 'big@high',
    },
    {
      name: 'a tier runs the role’s effort',
      setting: { kind: 'tier', tier: 'efficient' },
      role: 'qa',
      want: 'small@medium',
    },
    {
      name: 'top of tier runs the dearest model of the role’s tier',
      setting: { kind: 'top_of_tier' },
      role: 'plan',
      want: 'peak@high',
    },
    {
      name: 'top of tier with one model in the tier',
      setting: { kind: 'top_of_tier' },
      role: 'implement',
      want: 'mid@high',
    },
    {
      name: 'top of tier on QA',
      setting: { kind: 'top_of_tier' },
      role: 'qa',
      want: 'small@medium',
    },
  ] as const)('$name', ({ setting, role, want }) => {
    expect(
      pick({
        profiles: both,
        def: { role, need: 40 },
        requirements: [setting],
      }),
    ).toBe(want);
  });

  it('runs a scored top of tier at the cheapest effort of the dearest model that clears the need', () => {
    const profiles = [...testCatalogue(), ...scoredPeak()];
    expect(
      pick({
        profiles,
        def: { role: 'review', need: 54 },
        requirements: [{ kind: 'top_of_tier' }],
      }),
    ).toBe('peak@medium');
  });

  it.each([
    { name: 'a small need stays in the tier it lands in', need: 25, want: 'small@high' },
    { name: 'a larger need takes its tier to the top', need: 40, want: 'mid@high' },
    {
      name: 'a need only the capable tier meets takes it to the dearest model',
      need: 54,
      want: 'peak@medium',
    },
  ])('takes a scored top of tier to the tier the step lands in: $name', ({ need, want }) => {
    const profiles = [...testCatalogue(), ...scoredPeak()];
    expect(
      pick({
        profiles,
        def: { role: 'implement', need },
        requirements: [{ kind: 'top_of_tier' }],
      }),
    ).toBe(want);
  });

  it('runs a scored tier on the cheapest of its models that clears the need', () => {
    expect(
      pick({
        def: { role: 'implement', need: 40 },
        requirements: [{ kind: 'tier', tier: 'capable' }],
      }),
    ).toBe('big@high');
  });

  it('takes the highest scoring of a tier no model of reaches the need', () => {
    const choice = chooseModel(
      input({
        def: { role: 'implement', need: 90 },
        requirements: [{ kind: 'tier', tier: 'efficient' }],
      }),
    );
    expect(label(choice.profile ?? failed())).toBe('small@high');
    expect(choice.reason).toContain('none reaches 90 intelligence, so the highest scoring');
  });

  it('moves to the nearest tier when the account offers none in the one asked for', () => {
    const noFast = unscoredCatalogue({}, ['mid', 'big']);
    const choice = chooseModel(
      input({
        profiles: noFast,
        def: { role: 'qa', need: 20 },
        requirements: [{ kind: 'tier', tier: 'efficient' }],
      }),
    );
    expect(label(choice.profile ?? failed())).toBe('mid@medium');
    expect(choice.reason).toContain('no efficient model is offered, so the balanced tier');
  });
});

describe('chooseModel: a role with no setting and no score', () => {
  const some = (...models: NonNullable<Parameters<typeof unscoredCatalogue>[1]>[number][]) =>
    unscoredCatalogue({}, models);
  it.each([
    { name: 'plan on the cheapest strongest model', role: 'plan', want: 'big@high' },
    { name: 'plan review on the cheapest strongest model', role: 'plan_review', want: 'big@high' },
    { name: 'review on the cheapest strongest model', role: 'review', want: 'big@high' },
    { name: 'implement on the balanced', role: 'implement', want: 'mid@high' },
    { name: 'QA on the fast', role: 'qa', want: 'small@medium' },
  ] as const)('runs $name', ({ role, want }) => {
    expect(
      pick({ profiles: [...unscoredCatalogue(), ...peakRows()], def: { role, need: 40 } }),
    ).toBe(want);
  });

  it.each([
    {
      name: 'the strongest is the strongest the account offers',
      role: 'review',
      models: ['small', 'mid'],
      want: 'mid@high',
    },
    {
      name: 'fast rises to the next model when none is fast',
      role: 'qa',
      models: ['mid', 'big'],
      want: 'mid@medium',
    },
    {
      name: 'balanced prefers the stronger neighbour',
      role: 'implement',
      models: ['small', 'big'],
      want: 'big@high',
    },
    {
      name: 'plan runs on the one model offered',
      role: 'plan',
      models: ['small'],
      want: 'small@high',
    },
    {
      name: 'QA runs on the one model offered',
      role: 'qa',
      models: ['small'],
      want: 'small@medium',
    },
  ] as const)('$name', ({ role, models, want }) => {
    expect(pick({ profiles: some(...models), def: { role, need: 40 } })).toBe(want);
  });

  it('takes the nearest effort a model offers, the higher on a tie', () => {
    const profiles = unscoredCatalogue().filter((p) => label(p) !== 'mid@high');
    expect(pick({ profiles })).toBe('mid@xhigh');
  });

  it('leaves out a model switched off for routing', () => {
    const off = unscoredCatalogue({}, ['small', 'mid', 'big']).map((p) =>
      p.model === 'big' ? { ...p, enabled: false } : p,
    );
    expect(pick({ profiles: off, def: { role: 'review', need: 48 } })).toBe('mid@high');
  });

  it.each([
    {
      name: 'Careful’s cells, a tier at the role default one effort up',
      fallback: { tier: 'balanced', top: false, effort: 'xhigh' },
      role: 'implement',
      want: 'mid@xhigh',
    },
    {
      name: 'Critical’s cells, the top of Capable and Frontier one effort up',
      fallback: { tier: 'capable', top: true, effort: 'xhigh' },
      role: 'review',
      want: 'peak@xhigh',
    },
    {
      name: 'a cell with a fallback rung on a tier no model of is offered',
      fallback: { tier: 'efficient', top: false, effort: 'medium' },
      role: 'qa',
      want: 'small@medium',
    },
  ] as const)('runs the cell’s fallback rung for $name', ({ fallback, role, want }) => {
    expect(
      pick({
        profiles: [...unscoredCatalogue(), ...peakRows()],
        def: { role, need: 40 },
        fallback,
      }),
    ).toBe(want);
  });

  it('says which rung chose the model', () => {
    expect(chooseModel(input({ profiles: unscoredCatalogue() })).reason).toBe(
      `by role default: the cheapest model of the balanced tier${UNSCORED}`,
    );
    expect(
      chooseModel(
        input({
          profiles: [...unscoredCatalogue(), ...peakRows()],
          def: { role: 'review', need: 48 },
          fallback: { tier: 'capable', top: true, effort: 'xhigh' },
        }),
      ).reason,
    ).toBe(`by role default: the top model of the capable tier${UNSCORED}`);
  });
});

describe('chooseModel: the account’s tier override', () => {
  const profiles = [...unscoredCatalogue(), ...peakRows()];
  it('swaps the tier’s automatic choice for the model the account names', () => {
    const choice = chooseModel(
      input({ profiles, def: { role: 'review', need: 48 }, tierOverrides: { capable: 'peak' } }),
    );
    expect(label(choice.profile ?? failed())).toBe('peak@high');
    expect(choice.reason).toContain("the account's capable model");
  });

  it('applies to a tier setting but not to top of tier or a named model', () => {
    const overrides = { capable: 'peak', balanced: 'big' } as const;
    expect(
      pick({
        profiles,
        tierOverrides: overrides,
        requirements: [{ kind: 'tier', tier: 'balanced' }],
      }),
    ).toBe('big@high');
    expect(
      pick({
        profiles,
        def: { role: 'plan', need: 45 },
        tierOverrides: { capable: 'big' },
        requirements: [{ kind: 'top_of_tier' }],
      }),
    ).toBe('peak@high');
    expect(
      pick({
        profiles,
        tierOverrides: overrides,
        requirements: [{ kind: 'model', model: 'small' }],
      }),
    ).toBe('small@high');
  });

  it('launches the model it names when no profile describes it', () => {
    const choice = chooseModel(input({ profiles, tierOverrides: { balanced: 'ghost' } }));
    expect(choice.profile).toBeNull();
    expect(choice.model).toBe('ghost');
  });

  it('is ignored when the model it names is retired', () => {
    const retired = profiles.map((p) =>
      p.model === 'big' ? { ...p, status: ModelStatus.Retired, tier: null, enabled: false } : p,
    );
    expect(
      pick({
        profiles: retired,
        def: { role: 'review', need: 48 },
        tierOverrides: { capable: 'big' },
      }),
    ).toBe('peak@high');
  });
});

describe('chooseModel: nothing to choose from', () => {
  it.each([
    { name: 'no profile at all', profiles: [] },
    {
      name: 'only a model no tier ranks',
      profiles: unscoredCatalogue().map((p) => ({ ...p, tier: null, enabled: false })),
    },
  ])('names the tier and no profile with $name, and does not throw', ({ profiles }) => {
    const choice = chooseModel(input({ profiles, def: { role: 'review', need: 48 } }));
    expect(choice.profile).toBeNull();
    expect(choice.tier).toBe(ModelTier.Capable);
    expect(choice.reason).toBe('no model offered for the capable tier');
    expect(choice.setting).toEqual({ kind: 'automatic' });
  });

  it('keeps the setting that decided, so a later list can re-resolve it', () => {
    const choice = chooseModel(
      input({
        profiles: [],
        task: task({ modelSetting: { kind: 'tier', tier: ModelTier.Efficient } }),
      }),
    );
    expect(choice.setting).toEqual({ kind: 'tier', tier: ModelTier.Efficient });
    expect(choice.tier).toBe(ModelTier.Efficient);
    expect(choice.reason).toBe("the task's own setting: no model offered for the efficient tier");
  });
});

describe('chooseModel: score and budget', () => {
  it('routes by score across everything on offer when nothing sets a model', () => {
    expect(pick()).toBe('mid@high');
  });

  it('flags a choice over the budget ceiling as the router does', () => {
    const choice = chooseModel(
      input({ def: { role: 'review', need: 48 }, project: { budgetCeiling: 1.5 } }),
    );
    expect(label(choice.profile ?? failed())).toBe('big@high');
    expect(choice.overBudget).toBe(true);
  });

  it('keeps a choice inside the ceiling when a pool has one', () => {
    const choice = chooseModel(
      input({
        def: { role: 'implement', need: 20 },
        project: { budgetCeiling: 0.5 },
        requirements: [{ kind: 'tier', tier: 'balanced' }],
      }),
    );
    expect(label(choice.profile ?? failed())).toBe('mid@low');
    expect(choice.overBudget).toBe(false);
  });

  it.each([
    { name: 'a Bedrock copy 10% dearer than the maker’s', price: 5.5, over: true },
    { name: 'an account that pays the maker’s price', price: 5, over: false },
    { name: 'a subscription, which has no price', price: null, over: false },
  ])('counts what the account pays against the ceiling for $name', ({ price, over }) => {
    const choice = chooseModel(
      input({
        project: { budgetCeiling: 1.05 },
        accountModels: [
          {
            accountId: mintId('Account'),
            model: 'mid',
            family: null,
            launchId: 'mid',
            efforts: [],
            unusable: false,
            wordingMarkEndsAt: null,
            inputPrice: price === null ? null : price / 5,
            outputPrice: price,
            lastSeenAt: NOW,
          },
        ],
      }),
    );
    expect(label(choice.profile ?? failed())).toBe('mid@high');
    expect(choice.overBudget).toBe(over);
    expect(choice.reason.includes('over the budget ceiling of $1.05')).toBe(over);
  });
});

function failed(): never {
  throw new Error('expected a profile');
}

describe('chooseModel: a conversation that must not refuse', () => {
  const lowScores = testCatalogue().filter((p) => p.model !== 'big');
  it('takes the strongest offered for a step, when no model reaches its need, and says so', () => {
    const choice = chooseModel(input({ profiles: lowScores, def: { role: 'plan', need: 99 } }));
    expect(label(choice.profile ?? failed())).toBe('mid@high');
    expect(choice.reason).toContain('none reaches 99 intelligence, so the highest scoring');
  });

  it.each([
    { name: 'a need nothing reaches', profiles: lowScores, need: 99, want: 'mid@high' },
    {
      name: 'scores that would pick a cheaper model',
      profiles: testCatalogue(),
      need: 20,
      want: 'big@high',
    },
  ])(
    'chooses the role’s tier by default effort, without scores, for $name',
    ({ profiles, need, want }) => {
      const choice = chooseModel(input({ profiles, def: { role: 'plan', need }, byScore: false }));
      expect(label(choice.profile ?? failed())).toBe(want);
      expect(choice.reason).toContain('by role default: the cheapest model of the');
    },
  );

  it('still honours the role’s setting', () => {
    const choice = chooseModel(
      input({
        byScore: false,
        def: { role: 'plan', need: 99 },
        requirements: [{ kind: 'model', model: 'small' }],
      }),
    );
    expect(label(choice.profile ?? failed())).toBe('small@high');
  });
});

describe('chooseModel: the account’s override after a scored choice', () => {
  const profiles = [...testCatalogue(), ...scoredPeak()];
  it('swaps the model a scored Automatic choice landed on for its tier’s override', () => {
    const choice = chooseModel(
      input({ profiles, def: { role: 'review', need: 48 }, tierOverrides: { capable: 'peak' } }),
    );
    expect(label(choice.profile ?? failed())).toBe('peak@low');
    expect(choice.reason).toContain("the account's capable model");
  });

  it('leaves a scored choice alone when its tier has no override', () => {
    expect(
      pick({ profiles, def: { role: 'review', need: 48 }, tierOverrides: { efficient: 'small' } }),
    ).toBe('big@high');
  });

  it('launches an override that has no profile, as a gateway with no list does', () => {
    const choice = chooseModel(
      input({
        profiles,
        def: { role: 'review', need: 48 },
        tierOverrides: { capable: 'gateway-model' },
      }),
    );
    expect(choice.profile).toBeNull();
    expect(choice.model).toBe('gateway-model');
    expect(choice.tier).toBe(ModelTier.Capable);
    expect(choice.reason).toContain("the account's capable model gateway-model");
  });
});

describe('chooseModel: the strongest requirement decides', () => {
  const profiles = [...testCatalogue(), ...scoredPeak()];
  const settings = {
    automatic: { kind: 'automatic' },
    'tier efficient': { kind: 'tier', tier: 'efficient' },
    'tier balanced': { kind: 'tier', tier: 'balanced' },
    'tier capable': { kind: 'tier', tier: 'capable' },
    'top of capable': { kind: 'top_of_tier', tier: 'capable' },
    'top of any tier': { kind: 'top_of_tier' },
    'one model': { kind: 'model', model: 'mid' },
  } as const satisfies Record<string, ModelSetting>;
  const names = Object.keys(settings) as (keyof typeof settings)[];
  const scoreOf = (setting: ModelSetting): number => {
    const choice = chooseModel(input({ profiles, requirements: [setting] }));
    return choice.profile?.scores.intelligence ?? -1;
  };
  const pairs = names.flatMap((a) => names.map((b) => ({ a, b })));

  it.each(pairs)(
    'of $a and $b, the one that scores higher on its own wins, in either order',
    ({ a, b }) => {
      const [first, second] = [settings[a], settings[b]];
      const stronger = Math.max(scoreOf(first), scoreOf(second));
      for (const requirements of [
        [first, second],
        [second, first],
      ])
        expect(chooseModel(input({ profiles, requirements })).profile?.scores.intelligence).toBe(
          stronger,
        );
    },
  );

  it('takes the first of two requirements that choose the same model', () => {
    const choice = chooseModel(
      input({ profiles, requirements: [{ kind: 'tier', tier: 'capable' }, { kind: 'automatic' }] }),
    );
    expect(choice.setting).toEqual({ kind: 'tier', tier: 'capable' });
  });

  it('names the setting that won, so a later list can resolve it again', () => {
    const choice = chooseModel(
      input({ profiles, requirements: [{ kind: 'automatic' }, { kind: 'tier', tier: 'capable' }] }),
    );
    expect(choice.setting).toEqual({ kind: 'tier', tier: 'capable' });
    expect(label(choice.profile ?? failed())).toBe('big@high');
  });

  it.each([
    {
      name: 'unscored, the higher rung wins whatever it costs',
      profiles: unscoredCatalogue(),
      requirements: [
        { kind: 'tier', tier: 'balanced' },
        { kind: 'tier', tier: 'capable' },
      ],
      want: 'big@high',
    },
    {
      name: 'unscored, at one rung the dearer model wins',
      profiles: [...unscoredCatalogue(), ...peakRows()],
      requirements: [
        { kind: 'tier', tier: 'capable' },
        { kind: 'top_of_tier', tier: 'capable' },
      ],
      want: 'peak@high',
    },
    {
      name: 'unscored, one model against its tier by the higher rung',
      profiles: [...unscoredCatalogue(), ...peakRows()],
      requirements: [
        { kind: 'model', model: 'small' },
        { kind: 'tier', tier: 'balanced' },
      ],
      want: 'mid@high',
    },
  ] as const)('$name', ({ profiles: offered, requirements, want }) => {
    expect(
      pick({
        profiles: offered,
        requirements: [...requirements],
        def: { role: 'review', need: 48 },
        fallback: rungOf('review'),
      }),
    ).toBe(want);
  });
});

describe('chooseModel: the task’s own pin beats every requirement', () => {
  const profiles = [...testCatalogue(), ...scoredPeak()];
  it('runs the task’s setting alone, however strong the requirements are', () => {
    const choice = chooseModel(
      input({
        profiles,
        requirements: [
          { kind: 'tier', tier: 'capable' },
          { kind: 'top_of_tier', tier: 'capable' },
        ],
        task: task({ modelSetting: { kind: 'tier', tier: 'efficient' } }),
      }),
    );
    expect(label(choice.profile ?? failed())).toBe('small@high');
    expect(choice.reason).toMatch(/^the task's own setting: /);
  });

  it('puts the account’s refusal of a model before the task’s setting', () => {
    const choice = chooseModel(
      input({
        profiles,
        requirements: [{ kind: 'tier', tier: 'capable' }],
        task: task({ modelSetting: { kind: 'tier', tier: 'efficient' } }),
        startOverTier: ModelTier.Balanced,
      }),
    );
    expect(label(choice.profile ?? failed())).toBe('mid@high');
    expect(choice.reason).toContain("the refused model's tier (balanced)");
  });

  it('runs the task’s effort pin over a cell’s effort', () => {
    expect(
      pick({
        profiles,
        requirements: [{ kind: 'model', model: 'mid' }],
        effort: 'high',
        task: task({ effortPin: 'low' }),
      }),
    ).toBe('mid@low');
  });
});

describe('chooseModel: a fixed effort', () => {
  /** An offer shaped like a Codex plan's: one model at three efforts, one at two, neither with Max. */
  const codex = unscoredCatalogue({}, ['mid', 'big']).filter(
    (p) => p.effort !== 'max' && p.effort !== 'xhigh' && !(p.model === 'big' && p.effort === 'low'),
  );
  it.each([
    { name: 'an effort the model offers', effort: 'medium', want: 'mid@medium' },
    {
      name: 'an effort above what it offers snaps down to its highest',
      effort: 'max',
      want: 'mid@high',
    },
    { name: 'the lowest it offers', effort: 'low', want: 'mid@low' },
  ] as const)('$name', ({ effort, want }) => {
    expect(
      pick({
        profiles: codex,
        requirements: [{ kind: 'tier', tier: 'balanced' }],
        effort,
        fallback: { tier: 'balanced', top: false, effort },
      }),
    ).toBe(want);
  });

  it('snaps a model that lacks the effort to its nearest, and routes among those profiles by score', () => {
    expect(pick({ effort: 'low', def: { role: 'implement', need: 40 } })).toBe('big@high');
    expect(pick({ effort: 'high', def: { role: 'implement', need: 40 } })).toBe('mid@high');
  });

  it('falls back to the effort of the rung', () => {
    const at = (effort: Effort) => ({ tier: 'balanced', top: false, effort }) as const;
    expect(pick({ profiles: unscoredCatalogue() })).toBe('mid@high');
    expect(pick({ profiles: unscoredCatalogue(), fallback: at('low') })).toBe('mid@low');
    expect(pick({ profiles: unscoredCatalogue(), fallback: at('xhigh') })).toBe('mid@xhigh');
  });

  it('lets the task’s own effort decide alone, even below the rung', () => {
    expect(pick({ profiles: unscoredCatalogue(), task: task({ effortPin: 'low' }) })).toBe(
      'mid@low',
    );
  });

  it('keeps a fixed effort for the scored profiles while the rung carries its own', () => {
    expect(pick({ effort: 'low', def: { role: 'implement', need: 40 } })).toBe('big@high');
    expect(
      pick({
        profiles: unscoredCatalogue(),
        effort: 'low',
        fallback: { tier: 'balanced', top: false, effort: 'xhigh' },
      }),
    ).toBe('mid@xhigh');
  });
});

describe('chooseModel: no model reaches the need', () => {
  it('takes the strongest offered and says that none reached it', () => {
    const choice = chooseModel(input({ def: { role: 'implement', need: 90 } }));
    expect(label(choice.profile ?? failed())).toBe('big@max');
    expect(choice.reason).toContain('none reaches 90 intelligence, so the highest scoring');
  });
});

describe('chooseModel: the top of a named tier', () => {
  const ladder = unscoredCatalogue({}, ['small', 'mid', 'big', 'peak', 'apex']);
  it.each([
    {
      name: 'a named Capable stays in Capable',
      setting: { kind: 'top_of_tier', tier: 'capable' },
      want: 'peak@high',
    },
    {
      name: 'a named Frontier is Frontier’s model',
      setting: { kind: 'top_of_tier', tier: 'frontier' },
      want: 'apex@high',
    },
    {
      name: 'no tier takes the dearest of the capable span',
      setting: { kind: 'top_of_tier' },
      want: 'apex@high',
    },
  ] as const)('$name', ({ setting, want }) => {
    expect(
      pick({ profiles: ladder, def: { role: 'review', need: 40 }, requirements: [setting] }),
    ).toBe(want);
  });
});

describe('chooseModel: the strongest of several requirements', () => {
  it('keeps a Capable override naming a model no profile describes over an automatic pick below it', () => {
    const choice = chooseModel(
      input({
        requirements: [{ kind: 'automatic' }, { kind: 'tier', tier: 'capable' }],
        tierOverrides: { capable: 'house-model' },
      }),
    );
    expect(choice.model).toBe('house-model');
    expect(choice.profile).toBeNull();
  });

  it('keeps a profile-less choice in a lower tier below one with a profile in a higher', () => {
    const choice = chooseModel(
      input({
        requirements: [
          { kind: 'tier', tier: 'efficient' },
          { kind: 'tier', tier: 'balanced' },
        ],
        tierOverrides: { efficient: 'house-model' },
      }),
    );
    expect(choice.profile ? label(choice.profile) : choice.model).toBe('mid@high');
  });
});

describe('chooseModel: when a result is held against a retry', () => {
  const mid = { kind: 'model', model: 'mid' } as const;
  it.each([
    { name: 'the cell’s one model is what runs', over: { requirements: [mid] }, want: true },
    {
      name: 'the task’s own setting decides instead',
      over: { requirements: [mid], task: task({ modelSetting: mid }) },
      want: false,
    },
    {
      name: 'a refused model’s tier decides instead',
      over: { requirements: [mid], startOverTier: ModelTier.Balanced },
      want: false,
    },
  ])('$name: $want', ({ over, want }) => {
    expect(chooseModel(input({ ...over, pinned: true })).pinned).toBe(want);
  });
});
