import {
  AccountKind,
  mintId,
  ModelProfileDto,
  ModelStatus,
  ModelTier,
  type AccountId,
  type AccountModelDto,
  type SupportedAccountKind,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { readModelsDevFixture } from '../../test/models-dev-fixture';
import { buildModelRows, type ModelRowAccount } from './model-rows';
import { parseCatalogue } from './source';

const CATALOGUE = parseCatalogue(readModelsDevFixture());
const AT = '2026-11-06T10:00:00.000Z';

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
    scores: { intelligence: null, coding: null, agentic: null },
    costPerTaskUsd: null,
    outputTokensPerSecond: null,
    source: 'aa',
    indexVersion: null,
    measuredAt: null,
    enabled: false,
    maker: 'anthropic',
    family: 'claude-opus',
    tier: ModelTier.Strongest,
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
    inputPrice: null,
    outputPrice: null,
    lastSeenAt: AT,
    ...over,
  };
}

const scored = (intelligence: number | null, coding: number | null) => ({
  intelligence,
  coding,
  agentic: null,
});

describe('buildModelRows', () => {
  it('merges every effort of a model and every account offering it into one row', () => {
    const rows = buildModelRows({
      catalogue: CATALOGUE,
      accounts: [subscription, bedrock],
      profiles: [
        profile({
          effort: 'low',
          scores: scored(30, 28),
          outputTokensPerSecond: 90,
          stepsRun: 2,
          createdAt: '2026-11-05T10:00:00.000Z',
        }),
        profile({
          effort: 'high',
          scores: scored(40, 41),
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
        tier: 'strongest',
        status: 'current',
        availableOn: [subscription.id, bedrock.id],
        providers: ['bedrock', 'claude_subscription'],
        inputPrice: 5,
        outputPrice: 25,
        // The strongest scored effort's scores and speed, not an average or a mix of efforts.
        intelligence: 40,
        coding: 41,
        outputTokensPerSecond: 60,
        stepsRun: 5,
        firstSeenAt: '2026-11-01T10:00:00.000Z',
      },
    ]);
  });

  it('shows no score as null, never as zero', () => {
    const [row] = buildModelRows({
      catalogue: CATALOGUE,
      accounts: [subscription],
      profiles: [profile({ scores: scored(null, null) })],
      offers: [offer(subscription.id)],
    });
    expect(row).toMatchObject({
      intelligence: null,
      coding: null,
      outputTokensPerSecond: null,
    });
  });

  it('scores a model from its strongest effort even when the strongest by speed has none', () => {
    const [row] = buildModelRows({
      catalogue: CATALOGUE,
      accounts: [subscription],
      profiles: [
        profile({ effort: 'low', scores: scored(null, null), outputTokensPerSecond: 200 }),
        profile({ effort: 'high', scores: scored(35, null), outputTokensPerSecond: 50 }),
      ],
      offers: [offer(subscription.id)],
    });
    expect(row).toMatchObject({ intelligence: 35, coding: null, outputTokensPerSecond: 50 });
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
        accounts: [subscription],
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
      const rows = buildModelRows({ catalogue: CATALOGUE, accounts, profiles, offers }).filter(
        (r) => only === undefined || r.model === only,
      );
      expect(rows).toHaveLength(expected.length);
      expected.forEach((want, i) => {
        expect(rows[i]).toMatchObject(want);
      });
    });
  });

  it('lists a model offered with no catalogue at all as Unknown rather than guessing it runs', () => {
    const [row] = buildModelRows({
      catalogue: null,
      accounts: [bedrock],
      profiles: [],
      offers: [offer(bedrock.id, { model: 'openai.gpt-6.1-sol', launchId: 'openai.gpt-6.1-sol' })],
    });
    expect(row).toMatchObject({ status: 'unknown', name: 'openai.gpt-6.1-sol', maker: null });
  });
});
