import {
  AccountKind,
  mintId,
  ModelProfileDto,
  ModelStatus,
  ModelTier,
  type AccountId,
  type AccountModelDto,
  type Effort,
  type SupportedAccountKind,
} from '@10db/contracts';
import type { OpenRouterMeasure } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { readModelsDevFixture } from '../../test/models-dev-fixture';
import { buildModelRows, type ModelRowAccount } from './model-rows';
import { parseCatalogue } from './source';

const CATALOGUE = parseCatalogue(readModelsDevFixture());
const AT = '2026-11-06T10:00:00.000Z';
const NOW = new Date('2026-11-13T12:00:00.000Z');

const account = (kind: SupportedAccountKind, archived = false): ModelRowAccount => ({
  id: mintId('Account'),
  kind,
  archived,
});
const subscription = account(AccountKind.ClaudeSubscription);
const bedrock = account(AccountKind.Bedrock);
const claudeNoList = account(AccountKind.AnthropicApiKey);

function profile(over: Partial<ModelProfileDto>): ModelProfileDto {
  return ModelProfileDto.parse({
    id: mintId('ModelProfile'),
    provider: 'claude',
    model: 'claude-opus-5-5',
    effort: 'high',
    aaSlug: null,
    scores: { intelligence: null },
    costPerTaskUsd: null,
    outputTokensPerSecond: null,
    source: 'aa',
    indexVersion: null,
    measuredAt: null,
    enabled: false,
    maker: 'anthropic',
    family: 'claude-opus',
    tier: ModelTier.Capable,
    status: ModelStatus.Current,
    inputPrice: 5,
    outputPrice: 25,
    releaseDate: '2026-10-01',
    stepsRun: 0,
    firstPassSteps: 0,
    escalations: 0,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  });
}

function offer(accountId: AccountId, over: Partial<AccountModelDto> = {}): AccountModelDto {
  return {
    accountId,
    model: 'claude-opus-5-5',
    family: 'claude-opus',
    launchId: 'claude-opus-5-5',
    efforts: ['high'],
    unusable: false,
    wordingMarkEndsAt: null,
    inputPrice: null,
    outputPrice: null,
    lastSeenAt: AT,
    ...over,
  };
}

const scored = (intelligence: number | null) => ({ intelligence });

describe('buildModelRows', () => {
  it('merges every effort of a model and every account offering it into one row', () => {
    const rows = buildModelRows({
      now: NOW,
      catalogue: CATALOGUE,
      accounts: [subscription, bedrock],
      profiles: [
        profile({
          effort: 'low',
          scores: scored(30),
          outputTokensPerSecond: 90,
          stepsRun: 2,
          createdAt: '2026-11-05T10:00:00.000Z',
        }),
        profile({
          effort: 'high',
          scores: scored(40),
          outputTokensPerSecond: 60,
          stepsRun: 3,
          createdAt: '2026-11-01T10:00:00.000Z',
        }),
      ],
      offers: [
        offer(subscription.id),
        offer(bedrock.id, { launchId: 'us.anthropic.claude-opus-5-5', inputPrice: 5.5 }),
      ],
    });
    expect(rows).toEqual([
      {
        model: 'claude-opus-5-5',
        name: CATALOGUE.providers['anthropic']?.models.find((m) => m.id === 'claude-opus-5-5')
          ?.name,
        maker: 'anthropic',
        family: 'claude-opus',
        tier: 'capable',
        status: 'current',
        availableOn: [subscription.id, bedrock.id],
        providers: ['bedrock', 'claude_subscription'],
        inputPrice: 5,
        outputPrice: 25,
        // The strongest scored effort's scores and speed, not an average or a mix of efforts.
        intelligence: 40,
        costPerTaskUsd: null,
        outputTokensPerSecond: 60,
        coding: null,
        agentic: null,
        speedProvider: null,
        // Artificial Analysis is the only source until the others are joined in.
        sources: {
          intelligence: 'aa',
          coding: null,
          agentic: null,
          costPerTask: null,
          speed: 'aa',
        },
        efforts: [
          expect.objectContaining({ effort: 'high', intelligence: 40 }),
          expect.objectContaining({ effort: 'low', intelligence: 30 }),
        ],
        stepsRun: 5,
        firstSeenAt: '2026-11-01T10:00:00.000Z',
      },
    ]);
  });

  describe('with measures from OpenRouter', () => {
    const measure = (over: Partial<OpenRouterMeasure>): OpenRouterMeasure => ({
      id: 'anthropic/claude-opus-5.5',
      kind: 'speed',
      key: '',
      intelligence: null,
      coding: null,
      agentic: null,
      accuracy: null,
      costPerTaskUsd: null,
      tokensPerSecond: null,
      latencyMs: null,
      measuredAt: '2026-11-13T08:00:00.000Z',
      ...over,
    });
    const rowsWith = (openRouter: OpenRouterMeasure[], asked?: ModelRowAccount) =>
      buildModelRows({
        now: NOW,
        catalogue: CATALOGUE,
        accounts: [subscription, bedrock],
        profiles: [
          profile({ effort: 'high', scores: scored(null), outputTokensPerSecond: 20 }),
          profile({ effort: 'max', scores: scored(null), outputTokensPerSecond: 20 }),
        ],
        offers: [offer(subscription.id), offer(bedrock.id)],
        openRouter: new Map([['claude-opus-5-5', openRouter]]),
        ...(asked === undefined ? {} : { account: asked }),
      })[0];

    it('shows the score OpenRouter relays on the Max effort alone, and names it', () => {
      const row = rowsWith([
        measure({ kind: 'score_aa', intelligence: 55, coding: 31, agentic: 22 }),
      ]);
      expect(row?.efforts.map((e) => [e.effort, e.intelligence, e.sources.intelligence])).toEqual([
        ['max', 55, 'aa_via_openrouter'],
        ['high', null, null],
      ]);
      expect(row).toMatchObject({ intelligence: 55, coding: 31, agentic: 22 });
      expect(row?.sources).toMatchObject({
        intelligence: 'aa_via_openrouter',
        coding: 'aa_via_openrouter',
        agentic: 'aa_via_openrouter',
      });
    });

    it('shows the speed on the provider of the asked account', () => {
      const row = rowsWith(
        [
          measure({ key: 'Amazon Bedrock', tokensPerSecond: 90 }),
          measure({ key: 'Anthropic', tokensPerSecond: 60 }),
        ],
        bedrock,
      );
      expect(row).toMatchObject({
        outputTokensPerSecond: 90,
        speedProvider: 'Amazon Bedrock',
        sources: { speed: 'openrouter' },
      });
      expect(row?.efforts.map((e) => e.outputTokensPerSecond)).toEqual([90]);
    });

    it('takes the median across providers when no account is asked, and the speed AA gives with none fresh', () => {
      expect(
        rowsWith([
          measure({ key: 'A', tokensPerSecond: 10 }),
          measure({ key: 'B', tokensPerSecond: 30 }),
        ]),
      ).toMatchObject({ outputTokensPerSecond: 20, speedProvider: null });
      expect(
        rowsWith([
          measure({ key: 'A', tokensPerSecond: 99, measuredAt: '2026-11-10T00:00:00.000Z' }),
        ]),
      ).toMatchObject({ outputTokensPerSecond: 20, sources: { speed: 'aa' } });
    });
  });

  it('shows no score as null, never as zero', () => {
    const [row] = buildModelRows({
      now: NOW,
      catalogue: CATALOGUE,
      accounts: [subscription],
      profiles: [profile({ scores: scored(null) })],
      offers: [offer(subscription.id)],
    });
    expect(row).toMatchObject({
      intelligence: null,
      outputTokensPerSecond: null,
    });
  });

  it('scores a model from its strongest effort even when the strongest by speed has none', () => {
    const [row] = buildModelRows({
      now: NOW,
      catalogue: CATALOGUE,
      accounts: [subscription],
      profiles: [
        profile({ effort: 'low', scores: scored(null), outputTokensPerSecond: 200 }),
        profile({ effort: 'high', scores: scored(35), outputTokensPerSecond: 50 }),
      ],
      offers: [offer(subscription.id)],
    });
    expect(row).toMatchObject({ intelligence: 35, outputTokensPerSecond: 50 });
  });

  it.each([
    {
      name: 'the strongest scored effort when it has one',
      low: { speed: 200, scores: scored(null) },
      high: { speed: 50, scores: scored(35) },
      expected: 50,
    },
    {
      name: 'another effort when the strongest scored one has none',
      low: { speed: 120, scores: scored(null) },
      high: { speed: null, scores: scored(35) },
      expected: 120,
    },
    {
      name: 'nothing when no effort has one',
      low: { speed: null, scores: scored(null) },
      high: { speed: null, scores: scored(35) },
      expected: null,
    },
  ])('takes speed from $name', ({ low, high, expected }) => {
    const [row] = buildModelRows({
      now: NOW,
      catalogue: CATALOGUE,
      accounts: [subscription],
      profiles: [
        profile({ effort: 'low', scores: low.scores, outputTokensPerSecond: low.speed }),
        profile({ effort: 'high', scores: high.scores, outputTokensPerSecond: high.speed }),
      ],
      offers: [offer(subscription.id)],
    });
    expect(row?.outputTokensPerSecond).toBe(expected);
  });

  describe('efforts and cost per task', () => {
    const priced = (effort: Effort, intelligence: number | null, cost: number | null) =>
      profile({ effort, scores: scored(intelligence), costPerTaskUsd: cost });
    const efforts = (rows: ReturnType<typeof buildModelRows>) =>
      rows[0]?.efforts.map((e) => `${e.effort}:${String(e.costPerTaskUsd)}`);
    const listed = (accountId: AccountId, over: Partial<AccountModelDto> = {}) =>
      offer(accountId, { efforts: [], ...over });

    it('lists the efforts strongest first and takes the row’s cost from the first', () => {
      const rows = buildModelRows({
        now: NOW,
        catalogue: CATALOGUE,
        accounts: [subscription],
        profiles: [
          priced('low', 30, 0.5),
          priced('max', null, null),
          priced('high', 40, 2),
          priced('medium', null, null),
        ],
        offers: [listed(subscription.id)],
      });
      expect(rows[0]).toMatchObject({ intelligence: 40, costPerTaskUsd: 2 });
      // Unscored efforts go last, highest effort first.
      expect(efforts(rows)).toEqual(['high:2', 'low:0.5', 'max:null', 'medium:null']);
    });

    it('ties on Intelligence by the cheaper cost, then the higher effort', () => {
      const rows = buildModelRows({
        now: NOW,
        catalogue: CATALOGUE,
        accounts: [subscription],
        profiles: [priced('high', 40, 3), priced('medium', 40, 1), priced('max', 40, 3)],
        offers: [listed(subscription.id)],
      });
      expect(efforts(rows)).toEqual(['medium:1', 'max:3', 'high:3']);
    });

    it('scales every cost to an account that prices its own copy 10% above the maker', () => {
      const rows = buildModelRows({
        now: NOW,
        catalogue: CATALOGUE,
        accounts: [bedrock],
        profiles: [priced('low', 30, 1), priced('high', 40, 2)],
        offers: [listed(bedrock.id, { outputPrice: 27.5 })],
        account: bedrock,
      });
      expect(rows[0]?.costPerTaskUsd).toBeCloseTo(2.2, 10);
      expect(rows[0]?.efforts.map((e) => e.costPerTaskUsd)).toEqual([
        expect.closeTo(2.2, 10),
        expect.closeTo(1.1, 10),
      ]);
    });

    it('narrows a row to the efforts the account lists, and its Intelligence follows', () => {
      const rows = buildModelRows({
        now: NOW,
        catalogue: CATALOGUE,
        accounts: [subscription],
        profiles: [priced('low', 30, 0.5), priced('high', 40, 2)],
        offers: [listed(subscription.id, { efforts: ['low'] })],
        account: subscription,
      });
      expect(efforts(rows)).toEqual(['low:0.5']);
      expect(rows[0]).toMatchObject({ intelligence: 30, costPerTaskUsd: 0.5 });
    });

    it('shows no efforts, and dashes, when the efforts an account lists match no profile', () => {
      const rows = buildModelRows({
        now: NOW,
        catalogue: CATALOGUE,
        accounts: [subscription],
        profiles: [priced('high', 40, 2)],
        offers: [listed(subscription.id, { efforts: ['low'] })],
        account: subscription,
      });
      expect(rows[0]).toMatchObject({ efforts: [], intelligence: null, costPerTaskUsd: null });
    });

    it('keeps the maker’s efforts and costs for a model the account does not offer', () => {
      // The account lists another model, narrowed to one effort and priced; this model is not in its list.
      const rows = buildModelRows({
        now: NOW,
        catalogue: CATALOGUE,
        accounts: [bedrock],
        profiles: [priced('low', 30, 1), priced('high', 40, 2)],
        offers: [listed(bedrock.id, { model: 'other-model', efforts: ['low'], outputPrice: 27.5 })],
        account: bedrock,
      });
      expect(efforts(rows.filter((r) => r.model === 'claude-opus-5-5'))).toEqual([
        'high:2',
        'low:1',
      ]);
    });

    it('keeps the maker’s cost where the account’s offer of the model is marked unusable', () => {
      const rows = buildModelRows({
        now: NOW,
        catalogue: CATALOGUE,
        accounts: [bedrock],
        profiles: [priced('low', 30, 1), priced('high', 40, 2)],
        offers: [listed(bedrock.id, { unusable: true, outputPrice: 27.5 })],
        account: bedrock,
      });
      expect(efforts(rows)).toEqual(['high:2', 'low:1']);
    });
  });

  describe('which models are listed, and with what status', () => {
    it.each([
      {
        name: 'a seeded alias with no catalogue fields and no offer is not listed',
        profiles: [
          profile({
            model: 'opus',
            maker: null,
            family: null,
            tier: null,
            status: null,
            inputPrice: null,
            outputPrice: null,
            releaseDate: null,
          }),
        ],
        offers: [] as AccountModelDto[],
        accounts: [subscription],
        expected: [],
      },
      {
        name: 'a described profile that no account offers any more is not listed',
        profiles: [profile({ tier: null, status: null })],
        offers: [] as AccountModelDto[],
        accounts: [],
        expected: [],
      },
      {
        name: 'an archived account does not offer',
        profiles: [profile({ tier: null, status: null })],
        offers: [offer(subscription.id)],
        accounts: [{ ...subscription, archived: true }],
        expected: [],
      },
      {
        name: 'a model the catalogue lacks is listed Unknown with no maker',
        profiles: [
          profile({
            model: 'house-model',
            maker: null,
            family: null,
            tier: null,
            status: ModelStatus.Unknown,
            inputPrice: null,
            outputPrice: null,
            releaseDate: null,
          }),
        ],
        offers: [offer(subscription.id, { model: 'house-model', family: null })],
        accounts: [subscription],
        expected: [{ model: 'house-model', name: 'house-model', maker: null, status: 'unknown' }],
      },
      {
        name: 'a model only an account with no list yet offers is unconfirmed, shown Unknown',
        profiles: [profile({ model: 'claude-sonnet-5-5', tier: null, status: null })],
        // The subscription has a real list that lacks the model; the API-key account has none yet.
        offers: [offer(subscription.id)],
        accounts: [subscription, claudeNoList],
        expected: [
          {
            model: 'claude-sonnet-5-5',
            status: 'unknown',
            availableOn: [claudeNoList.id],
            providers: ['anthropic_api_key'],
          },
        ],
        // The opus profile's row is not part of this case's rows.
        only: 'claude-sonnet-5-5',
      },
      {
        name: 'accounts with no list yet, none of their maker having one, offer its models with the profile status',
        profiles: [profile({})],
        offers: [] as AccountModelDto[],
        accounts: [subscription, claudeNoList],
        expected: [
          {
            model: 'claude-opus-5-5',
            status: 'current',
            tier: 'capable',
            availableOn: [subscription.id, claudeNoList.id],
            providers: ['anthropic_api_key', 'claude_subscription'],
          },
        ],
      },
      {
        name: 'an account with no list does not offer a model the catalogue lacks',
        profiles: [profile({ model: 'house-model', tier: null, status: null })],
        offers: [] as AccountModelDto[],
        accounts: [subscription],
        expected: [],
      },
      {
        name: 'a model another maker makes, offered on Bedrock, is Not runnable and has no price',
        profiles: [] as ModelProfileDto[],
        offers: [
          offer(bedrock.id, { model: 'openai.gpt-6.1-sol', launchId: 'openai.gpt-6.1-sol' }),
        ],
        accounts: [bedrock],
        expected: [
          {
            model: 'openai.gpt-6.1-sol',
            status: 'not_runnable',
            tier: null,
            maker: 'openai',
            inputPrice: null,
            outputPrice: null,
            availableOn: [bedrock.id],
            // No profile dates it, and the account's last read says nothing of when it first appeared.
            firstSeenAt: null,
          },
        ],
      },
      {
        name: 'an account that marks an offer unusable is not an account it is available on',
        profiles: [profile({})],
        offers: [offer(subscription.id, { unusable: true })],
        accounts: [subscription],
        expected: [{ model: 'claude-opus-5-5', availableOn: [], status: 'current' }],
      },
    ])('$name', ({ profiles, offers, accounts, expected, ...rest }) => {
      const only = 'only' in rest ? rest.only : undefined;
      const rows = buildModelRows({
        now: NOW,
        catalogue: CATALOGUE,
        accounts,
        profiles,
        offers,
      }).filter((r) => only === undefined || r.model === only);
      expect(rows).toHaveLength(expected.length);
      expected.forEach((want, i) => {
        expect(rows[i]).toMatchObject(want);
      });
    });
  });

  it('lists a model offered with no catalogue at all as Unknown rather than guessing it runs', () => {
    const [row] = buildModelRows({
      now: NOW,
      catalogue: null,
      accounts: [bedrock],
      profiles: [],
      offers: [offer(bedrock.id, { model: 'openai.gpt-6.1-sol', launchId: 'openai.gpt-6.1-sol' })],
    });
    expect(row).toMatchObject({
      status: 'unknown',
      name: 'openai.gpt-6.1-sol',
      maker: null,
      firstSeenAt: null,
    });
  });
});
