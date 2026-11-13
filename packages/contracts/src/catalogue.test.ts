import { describe, expect, it } from 'vitest';
import {
  AccountModelDto,
  CatalogueStatusDto,
  isPickableModel,
  ModelStatus,
  ModelSettingsInput,
  ModelRowDto,
  ModelSetting,
  PatternDto,
  PatternMatch,
  RoleSettingDto,
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
    { name: 'a tier', value: { kind: 'tier', tier: 'fast' }, ok: true },
    { name: 'top of tier', value: { kind: 'top_of_tier' }, ok: true },
    { name: 'a named model', value: { kind: 'model', model: 'claude-opus-5-5' }, ok: true },
    { name: 'an unknown kind', value: { kind: 'cheapest' }, ok: false },
    { name: 'a tier outside the three', value: { kind: 'tier', tier: 'huge' }, ok: false },
    { name: 'a tier with no tier', value: { kind: 'tier' }, ok: false },
    { name: 'a model with an empty name', value: { kind: 'model', model: '' }, ok: false },
    { name: 'a model with no name', value: { kind: 'model' }, ok: false },
  ])('$name: parses $ok', ({ value, ok }) => {
    expect(ModelSetting.safeParse(value).success).toBe(ok);
  });

  it('keeps the shape it was given', () => {
    expect(ModelSetting.parse({ kind: 'tier', tier: 'strongest' })).toEqual({
      kind: 'tier',
      tier: 'strongest',
    });
  });
});

describe('PatternMatch', () => {
  it('defaults every field, and the defaults mean any', () => {
    expect(PatternMatch.parse({})).toEqual({
      roles: [],
      riskTags: [],
      areas: [],
      retryOnly: false,
    });
  });

  it('rejects a role that is not a step role', () => {
    expect(PatternMatch.safeParse({ roles: ['janitor'] }).success).toBe(false);
  });
});

describe('PatternDto', () => {
  it('parses a pattern with an empty match', () => {
    const parsed = PatternDto.parse({
      id: mintId('Pattern'),
      projectId: null,
      name: 'Migrations',
      match: {},
      setting: { kind: 'top_of_tier' },
      position: 0,
    });
    expect(parsed.match.retryOnly).toBe(false);
  });
});

describe('RoleSettingDto', () => {
  it('pairs a role and a project with a setting', () => {
    const dto = {
      role: 'review',
      projectId: mintId('Project'),
      setting: { kind: 'automatic' },
    };
    expect(RoleSettingDto.parse(dto)).toEqual(dto);
  });
});

describe('the model settings a form sends', () => {
  const automatic = { kind: 'automatic' };
  it.each([
    {
      name: 'a global role set',
      input: { roles: [{ role: 'review', setting: automatic }] },
      ok: true,
    },
    {
      name: 'a global role handed back to 10db’s default',
      input: { roles: [{ role: 'review', setting: null }] },
      ok: true,
    },
    {
      name: 'a global list of patterns',
      input: { patterns: [{ name: 'Risky', setting: automatic }] },
      ok: true,
    },
    {
      name: 'a pattern with a blank name',
      input: { patterns: [{ name: '   ', setting: automatic }] },
      ok: false,
    },
    {
      name: 'a role that is not a step role',
      input: { roles: [{ role: 'janitor', setting: automatic }] },
      ok: false,
    },
    {
      name: 'a role set twice',
      input: {
        roles: [
          { role: 'review', setting: automatic },
          { role: 'review', setting: automatic },
        ],
      },
      ok: false,
    },
  ])('global: $name parses $ok', ({ input, ok }) => {
    expect(ModelSettingsInput.safeParse(input).success).toBe(ok);
  });

  it('lets a project hand a role back to the global setting with null', () => {
    const parsed = ModelSettingsInput.parse({ roles: [{ role: 'review', setting: null }] });
    expect(parsed.roles).toEqual([{ role: 'review', setting: null }]);
    expect(parsed.patterns).toBeUndefined();
  });

  it('fills a pattern’s match and trims its name', () => {
    const parsed = ModelSettingsInput.parse({
      patterns: [{ name: ' Risky ', setting: automatic }],
    });
    expect(parsed.patterns).toEqual([
      {
        name: 'Risky',
        match: { roles: [], riskTags: [], areas: [], retryOnly: false },
        setting: automatic,
      },
    ]);
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
    expect(ModelRowDto.parse(row)).toEqual(row);
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
