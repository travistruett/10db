import { describe, expect, it } from 'vitest';
import {
  AccountModelDto,
  CatalogueStatusDto,
  isPickableModel,
  ModelStatus,
  ModelRowDto,
  ModelSetting,
} from './catalogue';
import { mintId } from './ids';
import { WorkstreamStep } from './steps';

describe('isPickableModel', () => {
  it.each([
    { name: 'a current model', status: ModelStatus.Current, pickable: true },
    {
      name: 'a replaced one, which the list marks',
      status: ModelStatus.Superseded,
      pickable: true,
    },
    {
      name: 'one the catalogue does not know, which the list marks',
      status: ModelStatus.Unknown,
      pickable: true,
    },
    { name: 'one with no status yet', status: null, pickable: true },
    { name: 'one its maker has retired', status: ModelStatus.Retired, pickable: false },
    { name: 'one 10db cannot run', status: ModelStatus.NotRunnable, pickable: false },
  ])('$name: $pickable', ({ status, pickable }) => {
    expect(isPickableModel(status)).toBe(pickable);
  });
});

describe('ModelSetting', () => {
  it.each([
    { name: 'automatic', value: { kind: 'automatic' }, ok: true },
    { name: 'a tier', value: { kind: 'tier', tier: 'efficient' }, ok: true },
    { name: 'top of tier', value: { kind: 'top_of_tier' }, ok: true },
    { name: 'a named model', value: { kind: 'model', model: 'claude-opus-5-5' }, ok: true },
    { name: 'an unknown kind', value: { kind: 'cheapest' }, ok: false },
    { name: 'a tier outside the four', value: { kind: 'tier', tier: 'huge' }, ok: false },
    { name: 'a tier of the three-tier names', value: { kind: 'tier', tier: 'fast' }, ok: false },
    {
      name: 'the strongest tier of the three-tier names',
      value: { kind: 'tier', tier: 'strongest' },
      ok: false,
    },
    { name: 'a tier with no tier', value: { kind: 'tier' }, ok: false },
    { name: 'a model with an empty name', value: { kind: 'model', model: '' }, ok: false },
    { name: 'a model with no name', value: { kind: 'model' }, ok: false },
  ])('$name: parses $ok', ({ value, ok }) => {
    expect(ModelSetting.safeParse(value).success).toBe(ok);
  });

  it('keeps the shape it was given', () => {
    expect(ModelSetting.parse({ kind: 'tier', tier: 'frontier' })).toEqual({
      kind: 'tier',
      tier: 'frontier',
    });
  });
});

describe('AccountModelDto', () => {
  const row = {
    accountId: mintId('Account'),
    model: 'claude-opus-5-5',
    family: 'claude-opus-5-5',
    launchId: 'opus',
    efforts: ['low', 'max'],
    unusable: false,
    wordingMarkEndsAt: null,
    inputPrice: null,
    outputPrice: null,
    lastSeenAt: '2026-11-06T12:00:00.000Z',
  };

  it('accepts a flat-rate account with no price of its own', () => {
    expect(AccountModelDto.parse(row)).toEqual(row);
  });

  it('accepts the price of the account own offer', () => {
    expect(AccountModelDto.parse({ ...row, inputPrice: 3, outputPrice: 15 }).outputPrice).toBe(15);
  });

  it('accepts a model with no family', () => {
    expect(AccountModelDto.parse({ ...row, family: null }).family).toBeNull();
  });

  it.each([
    { name: 'no inputPrice', over: { inputPrice: undefined } },
    { name: 'no outputPrice', over: { outputPrice: undefined } },
    { name: 'a negative inputPrice', over: { inputPrice: -1 } },
    { name: 'a negative outputPrice', over: { outputPrice: -0.5 } },
  ])('rejects $name', ({ over }) => {
    expect(AccountModelDto.safeParse({ ...row, ...over }).success).toBe(false);
  });

  it('rejects an effort 10db does not know', () => {
    expect(AccountModelDto.safeParse({ ...row, efforts: ['ludicrous'] }).success).toBe(false);
  });
});

describe('ModelRowDto', () => {
  it('accepts a model with no tier and no scores', () => {
    const row = {
      model: 'mystery-1',
      name: 'Mystery 1',
      maker: null,
      family: null,
      tier: null,
      status: 'unknown',
      availableOn: [mintId('Account')],
      providers: [],
      inputPrice: null,
      outputPrice: null,
      intelligence: null,
      costPerTaskUsd: null,
      outputTokensPerSecond: null,
      efforts: [],
      stepsRun: 0,
      firstSeenAt: '2026-11-06T12:00:00.000Z',
    };
    expect(ModelRowDto.parse(row)).toMatchObject(row);
  });

  it('reads a row from before the sources existed with null scores and no sources', () => {
    const row = ModelRowDto.parse({
      model: 'mystery-1',
      name: 'Mystery 1',
      maker: null,
      family: null,
      tier: null,
      status: 'unknown',
      availableOn: [],
      providers: [],
      inputPrice: null,
      outputPrice: null,
      intelligence: 40,
      costPerTaskUsd: null,
      outputTokensPerSecond: null,
      efforts: [],
      stepsRun: 0,
      firstSeenAt: null,
    });
    expect(row.coding).toBeNull();
    expect(row.agentic).toBeNull();
    expect(row.speedProvider).toBeNull();
    expect(row.sources).toEqual({
      intelligence: null,
      coding: null,
      agentic: null,
      costPerTask: null,
      speed: null,
    });
  });

  it('accepts a model with no first-seen time: it has no profile to date it by', () => {
    const row = ModelRowDto.shape.firstSeenAt.safeParse(null);
    expect(row.success).toBe(true);
  });

  it('rejects a status outside the five', () => {
    expect(ModelRowDto.shape.status.safeParse('deprecated').success).toBe(false);
  });
});

describe('CatalogueStatusDto', () => {
  it.each([
    { source: 'fetched', ok: true },
    { source: 'stored', ok: true },
    { source: 'snapshot', ok: true },
    { source: 'none', ok: true },
    { source: 'cache', ok: false },
  ])('source $source: parses $ok', ({ source, ok }) => {
    const dto = {
      fetchedAt: '2026-11-06T12:00:00.000Z',
      source,
      models: 12,
      lastAttempt: 'succeeded',
    };
    expect(CatalogueStatusDto.safeParse(dto).success).toBe(ok);
  });

  it.each([
    { lastAttempt: 'not_tried', ok: true },
    { lastAttempt: 'succeeded', ok: true },
    { lastAttempt: 'failed', ok: true },
    { lastAttempt: 'off', ok: true },
    { lastAttempt: 'running', ok: false },
  ])('last attempt $lastAttempt: parses $ok', ({ lastAttempt, ok }) => {
    const dto = { fetchedAt: null, source: 'none', models: 0, lastAttempt };
    expect(CatalogueStatusDto.safeParse(dto).success).toBe(ok);
  });

  it('describes a daemon with no catalogue', () => {
    const dto = { fetchedAt: null, source: 'none', models: 0, lastAttempt: 'failed' };
    expect(CatalogueStatusDto.parse(dto)).toEqual(dto);
  });
});

describe('WorkstreamStep setting', () => {
  const stored = {
    role: 'implement',
    personaId: null,
    personaName: 'Implementer',
    tools: 'edit',
    // Steps planned while routing kept a score kind per role still carry it; it is dropped on reading.
    score: 'coding',
    profileId: null,
    model: 'sonnet',
    effort: 'high',
    need: 40,
    reason: 'cheapest',
    overBudget: false,
    pinned: false,
    status: 'pending',
    attempts: 0,
    startedAt: null,
    sessionFloor: 0,
    result: null,
  };

  it('parses a stored step with no setting to null', () => {
    expect(WorkstreamStep.parse(stored).setting).toBeNull();
  });

  it('keeps a setting a step was planned with', () => {
    const setting = { kind: 'model', model: 'opus' };
    expect(WorkstreamStep.parse({ ...stored, setting }).setting).toEqual(setting);
  });
});
