import {
  Effort,
  isModelTier,
  mintId,
  ModelStatus,
  ModelTier,
  type AccountModelDto,
  type ModelProfileDto,
  type ModelSetting,
  type PatternDto,
  type PersonaDto,
  type WorkstreamStep,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { offeredProfiles } from '../routing';
import { resolveStep, type StepContext } from './resolve-step';

const NOW = '2026-11-07T12:00:00.000Z';

/** Invented models, each with a tier and an output price: never a real model's. */
const MODELS = [
  { model: 'small', tier: ModelTier.Efficient, price: 1 },
  { model: 'mid', tier: ModelTier.Balanced, price: 5 },
  { model: 'big', tier: ModelTier.Capable, price: 25 },
  { model: 'peak', tier: ModelTier.Capable, price: 50 },
] as const;

/** Every model at every effort, ranked and priced but not yet scored: what an account sees before a sync. */
const everything: ModelProfileDto[] = MODELS.flatMap(({ model, tier, price }) =>
  Object.values(Effort).map((effort) => ({
    id: mintId('ModelProfile'),
    provider: 'claude' as const,
    model,
    effort,
    aaSlug: null,
    source: 'aa',
    enabled: true,
    maker: 'test',
    family: `test-${model}`,
    tier,
    status: ModelStatus.Current,
    inputPrice: price / 5,
    outputPrice: price,
    releaseDate: '2026-09-01',
    scores: { intelligence: null },
    costPerTaskUsd: null,
    outputTokensPerSecond: null,
    indexVersion: null,
    measuredAt: null,
    stepsRun: 0,
    firstPassSteps: 0,
    escalations: 0,
    createdAt: NOW,
    updatedAt: NOW,
  })),
);
const label = (p: Pick<ModelProfileDto, 'model' | 'effort'>) => `${p.model}@${p.effort}`;
const row = (model: string, over: Partial<AccountModelDto> = {}): AccountModelDto => ({
  accountId: mintId('Account'),
  model,
  family: null,
  launchId: model,
  efforts: [],
  unusable: false,
  wordingMarkEndsAt: null,
  inputPrice: null,
  outputPrice: null,
  lastSeenAt: NOW,
  ...over,
});
const ACCOUNT = { label: 'Bedrock' };

/** What the account offers, narrowed the way the daemon narrows it before a step starts. */
function offering(rows: readonly AccountModelDto[]) {
  return { rows, profiles: offeredProfiles(everything, rows, 'claude') };
}

const profileOf = (name: string): ModelProfileDto => {
  const found = everything.find((p) => label(p) === name);
  if (!found) throw new Error(name);
  return found;
};

function planned(name: string, over: Partial<WorkstreamStep> = {}): WorkstreamStep {
  const profile = profileOf(name);
  return {
    role: 'implement',
    personaId: null,
    personaName: 'Implementer',
    tools: 'edit',
    profileId: profile.id,
    model: profile.model,
    effort: profile.effort,
    need: 40,
    reason: 'planned',
    overBudget: false,
    pinned: false,
    status: 'pending',
    attempts: 0,
    startedAt: null,
    sessionFloor: 0,
    result: null,
    earlier: [],
    sentBack: 0,
    setting: { kind: 'automatic' },
    ...over,
  };
}

const context = (over: Partial<StepContext> = {}): StepContext => ({
  persona: undefined,
  task: { riskTags: [], acceptanceCriteria: [], areas: [], modelSetting: null },
  project: { id: mintId('Project'), budgetCeiling: null },
  roleSettings: [],
  patterns: [],
  tierOverrides: {},
  ...over,
});

const ran = (step: WorkstreamStep) => `${step.model}@${step.effort}`;
const tier = (t: ModelTier): ModelSetting => ({ kind: 'tier', tier: t });

describe('resolveStep', () => {
  it('keeps a planned model the account still offers, untouched', () => {
    const { rows, profiles } = offering([row('mid'), row('big')]);
    const step = planned('mid@high');
    expect(resolveStep(step, ACCOUNT, profiles, rows, context())).toBe(step);
  });

  it.each<{
    name: string;
    rows: AccountModelDto[];
    step: WorkstreamStep;
    want: string;
    says: RegExp;
  }>([
    {
      name: 'a project moved to an account that lacks the planned model',
      rows: [row('small'), row('mid')],
      step: planned('big@high', { setting: tier(ModelTier.Balanced) }),
      want: 'mid@',
      says: /big is not offered by Bedrock/,
    },
    {
      name: 'a planned model the account has marked unusable, in a tier with another model',
      rows: [row('big', { unusable: true }), row('peak')],
      step: planned('big@high', { setting: tier(ModelTier.Capable) }),
      want: 'peak@',
      says: /big is marked unusable on Bedrock/,
    },
    {
      name: 'a step planned with no model to run, now that the account offers one',
      rows: [row('small'), row('mid'), row('big')],
      step: planned('mid@high', {
        model: ModelTier.Balanced,
        profileId: null,
        setting: tier(ModelTier.Balanced),
      }),
      want: 'mid@',
      says: /no model was chosen/,
    },
    {
      name: 'a planned effort the account does not list for the model',
      rows: [row('big', { efforts: [Effort.High] })],
      step: planned('big@max', { setting: { kind: 'automatic' } }),
      want: 'big@high',
      says: /big at max effort is not offered by Bedrock/,
    },
    {
      name: 'a setting that names a model the new account lacks, which falls to the role’s tier',
      rows: [row('small'), row('mid')],
      step: planned('big@high', { setting: { kind: 'model', model: 'big' } }),
      want: 'mid@',
      says: /big is not offered by Bedrock/,
    },
  ])('re-resolves $name', ({ rows: listed, step, want, says }) => {
    const { rows, profiles } = offering(listed);
    const out = resolveStep(step, ACCOUNT, profiles, rows, context());
    expect(ran(out).startsWith(want)).toBe(true);
    expect(out.reason).toMatch(says);
    expect(out.profileId).toBe(profiles.find((p) => label(p) === ran(out))?.id);
    expect(out.setting).not.toBeNull();
    expect(isModelTier(out.model)).toBe(false);
  });

  describe('the reason names where a re-resolved step’s setting came from', () => {
    const pattern = (name: string, setting: ModelSetting): PatternDto => ({
      id: mintId('Pattern'),
      projectId: null,
      name,
      match: { roles: [], riskTags: [], areas: [], retryOnly: false },
      setting,
      position: 0,
    });
    const ELSEWHERE = 'big is not offered by Bedrock, so the step was resolved again: ';
    const ROUTED =
      'by role default: the cheapest model of the balanced tier; no profile has an intelligence score to compare on yet (sync Artificial Analysis to route by score)';
    it.each<{
      name: string;
      over: Partial<StepContext>;
      setting: ModelSetting;
      source: string;
    }>([
      {
        name: 'the task’s own setting',
        over: {
          task: {
            riskTags: [],
            acceptanceCriteria: [],
            areas: [],
            modelSetting: tier(ModelTier.Balanced),
          },
        },
        setting: tier(ModelTier.Balanced),
        source: "the task's own setting",
      },
      {
        name: 'a pattern that still gives it',
        over: { patterns: [pattern('High-risk work', tier(ModelTier.Balanced))] },
        setting: tier(ModelTier.Balanced),
        source: 'the pattern "High-risk work"',
      },
      {
        name: 'a role setting that still gives it',
        over: {
          roleSettings: [{ role: 'implement', projectId: null, setting: tier(ModelTier.Balanced) }],
        },
        setting: tier(ModelTier.Balanced),
        source: "the role's setting",
      },
      {
        name: 'a setting nothing gives any more',
        over: {},
        setting: tier(ModelTier.Balanced),
        source: 'its planned setting (the balanced tier)',
      },
    ])('for $name', ({ over, setting, source }) => {
      const { rows, profiles } = offering([row('small'), row('mid')]);
      const out = resolveStep(
        planned('big@high', { setting }),
        ACCOUNT,
        profiles,
        rows,
        context(over),
      );
      expect(out.reason).toBe(`${ELSEWHERE}${source}: ${ROUTED}`);
    });
  });

  it('keeps what the step was for when it moves: its role, persona and progress', () => {
    const { rows, profiles } = offering([row('small'), row('mid')]);
    const step = planned('big@high', { status: 'running', attempts: 2, personaName: 'Ada' });
    const out = resolveStep(step, ACCOUNT, profiles, rows, context());
    expect(out).toMatchObject({
      role: 'implement',
      status: 'running',
      attempts: 2,
      personaName: 'Ada',
    });
  });

  it('takes the tier’s next model when the one a step ran on is refused, and the tier has one', () => {
    const { rows, profiles } = offering([row('big', { unusable: true }), row('mid'), row('peak')]);
    const out = resolveStep(
      planned('big@high', { setting: tier(ModelTier.Capable) }),
      ACCOUNT,
      profiles,
      rows,
      context(),
    );
    expect(out.model).toBe('peak');
  });

  it.each<{ name: string; rows: AccountModelDto[]; setting: ModelSetting }>([
    {
      name: 'every model is marked unusable',
      rows: [
        row('small', { unusable: true }),
        row('mid', { unusable: true }),
        row('big', { unusable: true }),
      ],
      setting: { kind: 'automatic' },
    },
    {
      name: 'the tier’s only model is marked unusable',
      rows: [row('mid', { unusable: true })],
      setting: tier(ModelTier.Balanced),
    },
  ])('names the tier and no profile when $name', ({ rows: listed, setting }) => {
    const { rows, profiles } = offering(listed);
    const out = resolveStep(planned('mid@high', { setting }), ACCOUNT, profiles, rows, context());
    expect(isModelTier(out.model)).toBe(true);
    expect(out.profileId).toBeNull();
    expect(out.reason).toMatch(/no model offered/);
  });

  it('re-chooses by the persona’s pin when the pinned model is gone, and says the pin was missed', () => {
    const { rows, profiles } = offering([row('small'), row('mid')]);
    const persona = {
      key: 'ada',
      minimumScore: null,
      modelPin: { model: 'big', effort: 'high' },
    } as unknown as PersonaDto;
    const out = resolveStep(
      planned('big@high', { pinned: true, setting: { kind: 'model', model: 'big' } }),
      ACCOUNT,
      profiles,
      rows,
      context({ persona }),
    );
    expect(out.pinned).toBe(false);
    expect(out.reason).toMatch(/ada pins big, which this account does not offer/);
  });

  it.each<{
    name: string;
    rows: AccountModelDto[];
    overrides: Partial<Record<ModelTier, string>>;
    want: string;
  }>([
    {
      name: 'an override naming the model the account has marked unusable',
      rows: [row('big', { unusable: true }), row('peak')],
      overrides: { capable: 'big' },
      want: 'peak',
    },
    {
      name: 'an override naming a model absent from a list the account has',
      rows: [row('big'), row('peak')],
      overrides: { capable: 'ghost' },
      want: 'big',
    },
  ])(
    'does not launch $name, which is not offered, but the tier’s automatic choice',
    ({ rows: listed, overrides, want }) => {
      const { rows, profiles } = offering(listed);
      const out = resolveStep(
        planned('mid@high', { setting: tier(ModelTier.Capable) }),
        ACCOUNT,
        profiles,
        rows,
        context({ tierOverrides: overrides }),
      );
      expect(out.model).toBe(want);
      expect(out.profileId).not.toBeNull();
    },
  );

  it('keeps a refused model’s step in its tier whatever the setting, and keeps the setting', () => {
    const { rows, profiles } = offering([
      row('small'),
      row('mid'),
      row('big', { unusable: true }),
      row('peak'),
    ]);
    const out = resolveStep(
      planned('big@high', { setting: { kind: 'automatic' } }),
      ACCOUNT,
      profiles,
      rows,
      context({ plannedTier: ModelTier.Capable }),
    );
    expect(out.model).toBe('peak');
    expect(out.setting).toEqual({ kind: 'automatic' });
    expect(out.reason).toBe(
      "big is marked unusable on Bedrock, so the step was resolved again: the refused model's tier (capable): by role default: the cheapest model of the capable tier; no profile has an intelligence score to compare on yet (sync Artificial Analysis to route by score)",
    );
  });

  it('launches a model typed against a tier on a gateway that lists none', () => {
    const profiles: ModelProfileDto[] = [];
    const out = resolveStep(
      planned('mid@high', {
        model: ModelTier.Balanced,
        profileId: null,
        setting: tier(ModelTier.Balanced),
      }),
      { label: 'Gateway' },
      profiles,
      [],
      context({ tierOverrides: { balanced: 'my-gateway/model' } }),
    );
    expect(out.model).toBe('my-gateway/model');
    expect(out.profileId).toBeNull();
  });
});
