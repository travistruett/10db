import {
  mintId,
  ModelStatus,
  ModelTier,
  type ModelProfileDto,
  type ModelSetting,
  type PatternDto,
  type PersonaDto,
  type ProjectId,
  type RiskTag,
  type RoleSettingDto,
  type StepRole,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { chooseModel, type ChooseInput } from './choose-model';
import { NoProfileError } from './router';
import { label, testCatalogue, unscoredCatalogue } from './test-catalogue';

/** What a reason says when no profile has a score to route on. */
const UNSCORED =
  '; no profile has an intelligence score to compare on yet (sync Artificial Analysis to route by score)';
const NOW = '2026-10-17T12:00:00.000Z';
const PROJECT = mintId('Project');
const OTHER_PROJECT = mintId('Project');

/** Two Capable models, the dearer one only in the pool when a test asks for it. */
const peakRows = (): ModelProfileDto[] => unscoredCatalogue({}, ['peak']);
/** Peak, measured: each effort scores two points more and costs a dollar more than the one before. */
const scoredPeak = (): ModelProfileDto[] =>
  peakRows().map((p, i) => ({
    ...p,
    scores: { intelligence: 52 + 2 * i },
    costPerTaskUsd: 8 + i,
  }));

const persona = (extra: Partial<PersonaDto> = {}): PersonaDto => ({
  id: mintId('Persona'),
  key: 'reviewer',
  name: 'Reviewer',
  role: 'review',
  tools: 'read_only',
  instructions: 'x',
  skills: [],
  minimumScore: null,
  modelPin: null,
  archived: false,
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});

const pattern = (
  setting: ModelSetting,
  extra: Partial<Omit<PatternDto, 'id' | 'setting'>> = {},
): PatternDto => ({
  id: mintId('Pattern'),
  projectId: null,
  name: 'a pattern',
  match: { roles: [], riskTags: [], areas: [], retryOnly: false },
  setting,
  position: 0,
  ...extra,
});
const roleSetting = (
  role: StepRole,
  setting: ModelSetting,
  projectId: ProjectId | null,
): RoleSettingDto => ({ role, projectId, setting });

const input = (over: Partial<ChooseInput> = {}): ChooseInput => ({
  def: { role: 'implement', need: 40 },
  persona: undefined,
  task: { riskTags: [], acceptanceCriteria: [], areas: [], modelSetting: null },
  project: { id: PROJECT, budgetCeiling: null },
  profiles: testCatalogue(),
  roleSettings: [],
  patterns: [],
  tierOverrides: {},
  stakes: { retry: false },
  ...over,
});
const task = (
  over: { riskTags?: RiskTag[]; areas?: string[]; modelSetting?: ModelSetting } = {},
) => ({
  riskTags: over.riskTags ?? [],
  acceptanceCriteria: [],
  areas: over.areas ?? [],
  modelSetting: over.modelSetting ?? null,
});
const pick = (over: Partial<ChooseInput> = {}): string | null => {
  const choice = chooseModel(input(over));
  return choice.profile ? label(choice.profile) : null;
};

describe('chooseModel: which setting decides', () => {
  const pinned = persona({ modelPin: { model: 'big', effort: 'max' } });
  const levels = [
    {
      name: "a persona's pin",
      setting: { kind: 'model', model: 'big' } satisfies ModelSetting,
      pinned: true,
    },
    {
      name: "the task's own setting",
      setting: { kind: 'tier', tier: ModelTier.Efficient } satisfies ModelSetting,
    },
    {
      name: "the project's pattern",
      setting: { kind: 'model', model: 'mid' } satisfies ModelSetting,
    },
    { name: 'a global pattern', setting: { kind: 'top_of_tier' } satisfies ModelSetting },
    {
      name: "the project's role setting",
      setting: { kind: 'tier', tier: ModelTier.Capable } satisfies ModelSetting,
    },
    {
      name: 'the global role setting',
      setting: { kind: 'model', model: 'peak' } satisfies ModelSetting,
    },
    { name: 'the default', setting: { kind: 'automatic' } satisfies ModelSetting },
  ];
  const everyLevel = (from: number): Partial<ChooseInput> => ({
    profiles: [...testCatalogue(), ...scoredPeak()],
    persona: from <= 0 ? pinned : undefined,
    task: task(from <= 1 ? { modelSetting: { kind: 'tier', tier: ModelTier.Efficient } } : {}),
    patterns: [
      ...(from <= 2
        ? [pattern({ kind: 'model', model: 'mid' }, { projectId: PROJECT, position: 3 })]
        : []),
      ...(from <= 3 ? [pattern({ kind: 'top_of_tier' }, { position: 0 })] : []),
    ],
    roleSettings: [
      ...(from <= 4
        ? [roleSetting('implement', { kind: 'tier', tier: ModelTier.Capable }, PROJECT)]
        : []),
      ...(from <= 5 ? [roleSetting('implement', { kind: 'model', model: 'peak' }, null)] : []),
    ],
    def: { role: 'implement', need: 25 },
  });

  it.each(levels.map((level, from) => ({ ...level, from })))(
    '$name wins over every level below it',
    ({ from, setting, pinned: isPinned }) => {
      const choice = chooseModel(input(everyLevel(from)));
      expect(choice.setting).toEqual(setting);
      expect(choice.pinned).toBe(isPinned === true);
    },
  );

  it('chooses inside the pool the winning setting names', () => {
    const results = levels.map((_, from) => pick(everyLevel(from)));
    expect(results).toEqual([
      'big@max',
      'small@high',
      'mid@low',
      'small@high',
      'big@high',
      'peak@low',
      'small@high',
    ]);
  });

  it("puts the project's patterns before the global ones, each by position", () => {
    const choice = chooseModel(
      input({
        def: { role: 'implement', need: 20 },
        patterns: [
          pattern({ kind: 'model', model: 'small' }, { name: 'global first', position: 0 }),
          pattern(
            { kind: 'model', model: 'big' },
            { name: 'project second', projectId: PROJECT, position: 2 },
          ),
          pattern(
            { kind: 'model', model: 'mid' },
            { name: 'project first', projectId: PROJECT, position: 1 },
          ),
        ],
      }),
    );
    expect(choice.setting).toEqual({ kind: 'model', model: 'mid' });
    expect(choice.reason).toContain('the pattern "project first"');
  });

  it('puts the project role before the global role, and ignores another project’s rows', () => {
    const settings = [
      roleSetting('implement', { kind: 'tier', tier: ModelTier.Efficient }, null),
      roleSetting('implement', { kind: 'tier', tier: ModelTier.Capable }, OTHER_PROJECT),
    ];
    expect(chooseModel(input({ roleSettings: settings })).setting).toEqual({
      kind: 'tier',
      tier: ModelTier.Efficient,
    });
    const own = [...settings, roleSetting('implement', { kind: 'model', model: 'mid' }, PROJECT)];
    expect(chooseModel(input({ roleSettings: own })).setting).toEqual({
      kind: 'model',
      model: 'mid',
    });
    const elsewhere = [pattern({ kind: 'model', model: 'big' }, { projectId: OTHER_PROJECT })];
    expect(chooseModel(input({ patterns: elsewhere })).setting).toEqual({ kind: 'automatic' });
  });

  it('names the setting that chose the model in its reason', () => {
    expect(
      chooseModel(input({ task: task({ modelSetting: { kind: 'model', model: 'mid' } }) })).reason,
    ).toMatch(/^the task's own setting: /);
    expect(
      chooseModel(
        input({ roleSettings: [roleSetting('implement', { kind: 'model', model: 'mid' }, null)] }),
      ).reason,
    ).toMatch(/^the role's setting: /);
    expect(chooseModel(input()).reason).toMatch(/^by score: /);
  });
});

describe('chooseModel: patterns match on role, risk, area and retry', () => {
  const high = pattern(
    { kind: 'tier', tier: ModelTier.Capable },
    {
      match: {
        roles: ['review'],
        riskTags: ['security', 'auth'],
        areas: ['billing'],
        retryOnly: false,
      },
    },
  );
  const retryOnly = pattern(
    { kind: 'tier', tier: ModelTier.Capable },
    { match: { roles: [], riskTags: [], areas: [], retryOnly: true } },
  );
  it.each([
    {
      name: 'every dimension matches',
      p: high,
      role: 'review',
      t: task({ riskTags: ['auth'], areas: ['billing', 'ui'] }),
      applies: true,
    },
    {
      name: 'the role differs',
      p: high,
      role: 'qa',
      t: task({ riskTags: ['auth'], areas: ['billing'] }),
      applies: false,
    },
    {
      name: 'no risk tag matches',
      p: high,
      role: 'review',
      t: task({ riskTags: ['migration'], areas: ['billing'] }),
      applies: false,
    },
    {
      name: 'the task is in no named area',
      p: high,
      role: 'review',
      t: task({ riskTags: ['auth'], areas: ['ui'] }),
      applies: false,
    },
    {
      name: 'a retry-only pattern, first run',
      p: retryOnly,
      role: 'review',
      t: task(),
      applies: false,
    },
    {
      name: 'a retry-only pattern, on a retry',
      p: retryOnly,
      role: 'review',
      t: task(),
      applies: true,
      retry: true,
    },
    {
      name: 'an empty match is any step',
      p: pattern({ kind: 'tier', tier: ModelTier.Capable }),
      role: 'qa',
      t: task(),
      applies: true,
    },
  ] as const)('$name', ({ p, role, t, applies, ...rest }) => {
    const choice = chooseModel(
      input({
        def: { role, need: 20 },
        task: t,
        patterns: [p],
        stakes: { retry: 'retry' in rest },
      }),
    );
    expect(choice.setting.kind).toBe(applies ? 'tier' : 'automatic');
  });
});

describe('chooseModel: a setting the account cannot honour', () => {
  const ghost: ModelSetting = { kind: 'model', model: 'ghost' };
  const retired = unscoredCatalogue().map((p) =>
    p.model === 'mid' ? { ...p, status: ModelStatus.Retired, tier: null, enabled: false } : p,
  );
  const take = (over: Partial<ChooseInput>) =>
    chooseModel(input({ profiles: unscoredCatalogue(), ...over }));

  it.each([
    { name: 'the task', over: { task: task({ modelSetting: ghost }) } },
    { name: 'a pattern', over: { patterns: [pattern(ghost)] } },
    {
      name: 'the project role',
      over: { roleSettings: [roleSetting('implement', ghost, PROJECT)] },
    },
    { name: 'the global role', over: { roleSettings: [roleSetting('implement', ghost, null)] } },
  ])('takes the role’s tier choice when $name names a model the account lacks', ({ over }) => {
    const choice = take(over);
    expect(label(choice.profile ?? failed())).toBe('mid@high');
    expect(choice.setting).toEqual(ghost);
    expect(choice.reason).toContain('ghost is not offered by this account, so the balanced tier');
  });

  it('takes the tier’s choice for a persona pin the account lacks, and says so', () => {
    const choice = take({
      persona: persona({ modelPin: { model: 'ghost', effort: 'high' } }),
      def: { role: 'review', need: 48 },
    });
    expect(label(choice.profile ?? failed())).toBe('big@high');
    expect(choice.pinned).toBe(false);
    expect(choice.reason).toContain('reviewer pins ghost, which this account does not offer');
  });

  it('keeps a pin whose model is offered at another effort, at the nearest one', () => {
    const choice = take({ persona: persona({ modelPin: { model: 'mid', effort: 'max' } }) });
    expect(choice.pinned).toBe(true);
    expect(label(choice.profile ?? failed())).toBe('mid@max');
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
        roleSettings: [roleSetting(role, setting, null)],
      }),
    ).toBe(want);
  });

  it('runs a scored top of tier at the cheapest effort of the dearest model that clears the need', () => {
    const profiles = [...testCatalogue(), ...scoredPeak()];
    expect(
      pick({
        profiles,
        def: { role: 'review', need: 54 },
        roleSettings: [roleSetting('review', { kind: 'top_of_tier' }, null)],
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
        roleSettings: [roleSetting('implement', { kind: 'top_of_tier' }, null)],
      }),
    ).toBe(want);
  });

  it('runs a scored tier on the cheapest of its models that clears the need', () => {
    expect(
      pick({
        def: { role: 'implement', need: 40 },
        roleSettings: [roleSetting('implement', { kind: 'tier', tier: 'capable' }, null)],
      }),
    ).toBe('big@high');
  });

  it('takes the highest scoring of a tier no model of reaches the need', () => {
    const choice = chooseModel(
      input({
        def: { role: 'implement', need: 90 },
        roleSettings: [roleSetting('implement', { kind: 'tier', tier: 'efficient' }, null)],
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
        roleSettings: [roleSetting('qa', { kind: 'tier', tier: 'efficient' }, null)],
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
      name: 'a migration implement',
      role: 'implement',
      riskTags: ['migration'],
      want: 'peak@xhigh',
    },
    { name: 'a security review', role: 'review', riskTags: ['security'], want: 'peak@xhigh' },
    { name: 'a QA step', role: 'qa', riskTags: ['migration'], want: 'small@medium' },
  ] as const)(
    'sends $name to the top of the capable tier, one effort up, under a floor',
    ({ role, riskTags, want }) => {
      expect(
        pick({
          profiles: [...unscoredCatalogue(), ...peakRows()],
          def: { role, need: 40 },
          task: task({ riskTags: [...riskTags] }),
        }),
      ).toBe(want);
    },
  );

  it('says which default chose the model, and names a floor', () => {
    expect(chooseModel(input({ profiles: unscoredCatalogue() })).reason).toBe(
      `by role default: the cheapest model of the balanced tier${UNSCORED}`,
    );
    expect(
      chooseModel(
        input({
          profiles: [...unscoredCatalogue(), ...peakRows()],
          def: { role: 'review', need: 48 },
          task: task({ riskTags: ['security'] }),
        }),
      ).reason,
    ).toBe(
      `by role default: the top model of the capable tier, one effort up (floor: security-sensitive review)${UNSCORED}`,
    );
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
        roleSettings: [roleSetting('implement', { kind: 'tier', tier: 'balanced' }, null)],
      }),
    ).toBe('big@high');
    expect(
      pick({
        profiles,
        def: { role: 'plan', need: 45 },
        tierOverrides: { capable: 'big' },
        roleSettings: [roleSetting('plan', { kind: 'top_of_tier' }, null)],
      }),
    ).toBe('peak@high');
    expect(
      pick({
        profiles,
        tierOverrides: overrides,
        roleSettings: [roleSetting('implement', { kind: 'model', model: 'small' }, null)],
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

describe('chooseModel: score, floor and budget', () => {
  it('routes by score across everything on offer when nothing sets a model', () => {
    expect(pick()).toBe('mid@high');
  });

  it('raises a scored step to a persona’s minimum score', () => {
    expect(
      pick({ def: { role: 'review', need: 48 }, persona: persona({ minimumScore: 52 }) }),
    ).toBe('big@max');
  });

  it('flags a choice over the budget ceiling as the router does', () => {
    const choice = chooseModel(
      input({ def: { role: 'review', need: 48 }, project: { id: PROJECT, budgetCeiling: 1.5 } }),
    );
    expect(label(choice.profile ?? failed())).toBe('big@high');
    expect(choice.overBudget).toBe(true);
  });

  it('keeps a choice inside the ceiling when a pool has one', () => {
    const choice = chooseModel(
      input({
        def: { role: 'implement', need: 20 },
        project: { id: PROJECT, budgetCeiling: 0.5 },
        roleSettings: [roleSetting('implement', { kind: 'tier', tier: 'balanced' }, null)],
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
        project: { id: PROJECT, budgetCeiling: 1.05 },
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
  it('routes by score for a step, which refuses a need nothing reaches', () => {
    expect(() =>
      chooseModel(input({ profiles: lowScores, def: { role: 'plan', need: 99 } })),
    ).toThrow(NoProfileError);
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
        roleSettings: [roleSetting('plan', { kind: 'model', model: 'small' }, null)],
      }),
    );
    expect(label(choice.profile ?? failed())).toBe('small@high');
  });
});

describe('chooseModel: a persona pin the account lacks', () => {
  const profiles = [...testCatalogue(), ...scoredPeak()];
  const securityReview = {
    def: { role: 'review', need: 48 } as const,
    task: task({ riskTags: ['security'] }),
    persona: persona({ modelPin: { model: 'ghost', effort: 'high' } }),
    profiles,
  };
  it('takes the role tier’s automatic choice, not the seeded pattern’s', () => {
    const highRisk = pattern({ kind: 'top_of_tier' }, { name: 'High-risk work' });
    const withPattern = chooseModel(input({ ...securityReview, patterns: [highRisk] }));
    const without = chooseModel(input(securityReview));
    expect(label(withPattern.profile ?? failed())).toBe('big@max');
    expect(label(without.profile ?? failed())).toBe('big@max');
    expect(withPattern.setting).toEqual({ kind: 'automatic' });
    expect(withPattern.reason).toContain('reviewer pins ghost, which this account does not offer');
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
