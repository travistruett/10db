import {
  Effort,
  isModelTier,
  mintId,
  ModelStatus,
  ModelTier,
  type AccountModelDto,
  type ModelProfileDto,
  type ModelSetting,
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

function profileStep(profile: ModelProfileDto, over: Partial<WorkstreamStep> = {}): WorkstreamStep {
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

function planned(name: string, over: Partial<WorkstreamStep> = {}): WorkstreamStep {
  return profileStep(profileOf(name), over);
}

const context = (over: Partial<StepContext> = {}): StepContext => ({
  task: { modelSetting: null, effortPin: null },
  project: { budgetCeiling: null },
  tierOverrides: {},
  effort: null,
  fallback: null,
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

  it('re-resolves a step the account cannot run as planned to an offered profile, says why, and keeps what the step was for', () => {
    const rows: {
      name: string;
      rows: AccountModelDto[];
      step: WorkstreamStep;
      want: string;
      says: RegExp;
      keeps?: Partial<WorkstreamStep>;
    }[] = [
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
        name: 'a refused model takes the tier’s next model when the tier has one, over a cheaper tier',
        rows: [row('big', { unusable: true }), row('mid'), row('peak')],
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
      {
        name: 'a running step keeps its role, persona and progress when it moves',
        rows: [row('small'), row('mid')],
        step: planned('big@high', { status: 'running', attempts: 2, personaName: 'Ada' }),
        want: '',
        says: /big is not offered by Bedrock/,
        keeps: { role: 'implement', status: 'running', attempts: 2, personaName: 'Ada' },
      },
    ];
    for (const { name, rows: listed, step, want, says, keeps } of rows) {
      const { rows: offered, profiles } = offering(listed);
      const out = resolveStep(step, ACCOUNT, profiles, offered, context());
      expect.soft(ran(out), `${name}: runs`).toMatch(new RegExp(`^${want}`));
      expect.soft(out.reason, `${name}: reason`).toMatch(says);
      expect
        .soft(out.profileId, `${name}: profile`)
        .toBe(profiles.find((p) => label(p) === ran(out))?.id);
      expect.soft(out.setting, `${name}: setting`).not.toBeNull();
      expect.soft(isModelTier(out.model), `${name}: a model, not a tier`).toBe(false);
      if (keeps) expect.soft(out, `${name}: keeps`).toMatchObject(keeps);
    }
  });

  it('names in the reason where a re-resolved step’s setting came from and the tier it was resolved in', () => {
    const ELSEWHERE = 'big is not offered by Bedrock, so the step was resolved again: ';
    const ROUTED =
      'by the rigor’s fallback rung: the cheapest model of the balanced tier; no profile has an intelligence score to compare on yet (sync Artificial Analysis to route by score)';
    const apex: ModelProfileDto[] = everything
      .filter((p) => p.model === 'peak')
      .map((p) => ({ ...p, id: mintId('ModelProfile'), model: 'apex', tier: ModelTier.Frontier }));
    const apexHigh = apex.find((p) => p.effort === 'high');
    if (!apexHigh) throw new Error('no apex@high');
    const frontierRows = [row('big'), row('apex', { unusable: true })];
    const refusedRows = [row('small'), row('mid'), row('big', { unusable: true }), row('peak')];
    const movedRows = [row('small'), row('mid')];
    const rows: {
      name: string;
      rows: AccountModelDto[];
      profiles: ModelProfileDto[];
      step: WorkstreamStep;
      over: Partial<StepContext>;
      model?: string;
      setting?: ModelSetting;
      /** The whole reason, or the parts it contains. */
      reason: string | string[];
    }[] = [
      {
        name: 'the task’s own setting',
        rows: movedRows,
        profiles: offering(movedRows).profiles,
        step: planned('big@high', { setting: tier(ModelTier.Balanced) }),
        over: { task: { modelSetting: tier(ModelTier.Balanced), effortPin: null } },
        reason: `${ELSEWHERE}the task's own setting: ${ROUTED}`,
      },
      {
        name: 'the setting the step was planned with',
        rows: movedRows,
        profiles: offering(movedRows).profiles,
        step: planned('big@high', { setting: tier(ModelTier.Balanced) }),
        over: {},
        reason: `${ELSEWHERE}${ROUTED}`,
      },
      {
        name: 'a refused model’s tier, whatever the setting, which the step keeps',
        rows: refusedRows,
        profiles: offering(refusedRows).profiles,
        step: planned('big@high', { setting: { kind: 'automatic' } }),
        over: { plannedTier: ModelTier.Capable },
        model: 'peak',
        setting: { kind: 'automatic' },
        reason:
          "big is marked unusable on Bedrock, so the step was resolved again: the refused model's tier (capable): by the rigor’s fallback rung: the cheapest model of the capable tier; no profile has an intelligence score to compare on yet (sync Artificial Analysis to route by score)",
      },
      {
        name: 'a refused Frontier pick, which falls back to the next model the account runs',
        rows: frontierRows,
        profiles: offeredProfiles([...everything, ...apex], frontierRows, 'claude'),
        step: { ...profileStep(apexHigh), setting: tier(ModelTier.Frontier) },
        over: { plannedTier: ModelTier.Frontier },
        model: 'big',
        reason: [
          'apex is marked unusable on Bedrock, so the step was resolved again',
          "the refused model's tier (frontier)",
          'the cheapest model of the capable tier',
        ],
      },
    ];
    for (const { name, rows: listed, profiles, step, over, model, setting, reason } of rows) {
      const out = resolveStep(step, ACCOUNT, profiles, listed, context(over));
      if (model !== undefined) expect.soft(out.model, `${name}: model`).toBe(model);
      if (setting !== undefined) expect.soft(out.setting, `${name}: setting`).toEqual(setting);
      if (typeof reason === 'string') expect.soft(out.reason, `${name}: reason`).toBe(reason);
      else for (const part of reason) expect.soft(out.reason, `${name}: reason`).toContain(part);
    }
  });

  it('names the tier and no profile when no model is offered', () => {
    const rows: { name: string; rows: AccountModelDto[]; setting: ModelSetting }[] = [
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
    ];
    for (const { name, rows: listed, setting } of rows) {
      const { rows: offered, profiles } = offering(listed);
      const out = resolveStep(
        planned('mid@high', { setting }),
        ACCOUNT,
        profiles,
        offered,
        context(),
      );
      expect.soft(isModelTier(out.model), `${name}: a tier`).toBe(true);
      expect.soft(out.profileId, `${name}: profile`).toBeNull();
      expect.soft(out.reason, `${name}: reason`).toMatch(/no model offered/);
    }
  });

  it('releases a held model the account has lost, and keeps one still offered at another effort held', () => {
    const lost = offering([row('small'), row('mid')]);
    const released = resolveStep(
      planned('big@high', { pinned: true, setting: { kind: 'model', model: 'big' } }),
      ACCOUNT,
      lost.profiles,
      lost.rows,
      context(),
    );
    expect.soft(released.pinned, 'lost: pinned').toBe(false);
    expect
      .soft(released.reason, 'lost: reason')
      .toMatch(/big is not offered by this account, so the balanced tier/);

    const kept = offering([row('big', { efforts: [Effort.High] })]);
    const held = resolveStep(
      planned('big@max', { pinned: true, setting: { kind: 'model', model: 'big' } }),
      ACCOUNT,
      kept.profiles,
      kept.rows,
      context({ effort: Effort.Max }),
    );
    expect.soft(held.pinned, 'other effort: pinned').toBe(true);
    expect.soft(ran(held), 'other effort: runs').toBe('big@high');
  });

  it('launches a tier override only when it is offered, or typed on a gateway that lists no models', () => {
    const rows: {
      name: string;
      rows: AccountModelDto[];
      overrides: Partial<Record<ModelTier, string>>;
      setting: ModelSetting;
      gateway?: boolean;
      want: string;
      profile: boolean;
    }[] = [
      {
        name: 'an override naming the model the account has marked unusable launches the tier’s automatic choice',
        rows: [row('big', { unusable: true }), row('peak')],
        overrides: { capable: 'big' },
        setting: tier(ModelTier.Capable),
        want: 'peak',
        profile: true,
      },
      {
        name: 'an override naming a model absent from a list the account has launches the tier’s automatic choice',
        rows: [row('big'), row('peak')],
        overrides: { capable: 'ghost' },
        setting: tier(ModelTier.Capable),
        want: 'big',
        profile: true,
      },
      {
        name: 'a model typed against a tier on a gateway that lists none is launched',
        rows: [],
        overrides: { balanced: 'my-gateway/model' },
        setting: tier(ModelTier.Balanced),
        gateway: true,
        want: 'my-gateway/model',
        profile: false,
      },
    ];
    for (const { name, rows: listed, overrides, setting, gateway, want, profile } of rows) {
      const { rows: offered, profiles } = gateway ? { rows: [], profiles: [] } : offering(listed);
      const step = gateway
        ? planned('mid@high', { model: ModelTier.Balanced, profileId: null, setting })
        : planned('mid@high', { setting });
      const out = resolveStep(
        step,
        gateway ? { label: 'Gateway' } : ACCOUNT,
        profiles,
        offered,
        context({ tierOverrides: overrides }),
      );
      expect.soft(out.model, `${name}: model`).toBe(want);
      expect.soft(out.profileId !== null, `${name}: has a profile`).toBe(profile);
    }
  });
});
