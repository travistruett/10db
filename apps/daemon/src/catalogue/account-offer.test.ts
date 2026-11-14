import { AccountKind, type Effort, type AgentAccountKind } from '@10db/contracts';
import type { NewAccountModel } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { readModelsDevFixture } from '../../test/models-dev-fixture';
import type { SeenModel } from '../sessions';
import { offerFromList } from './account-offer';
import { parseCatalogue, type Catalogue, type CatalogueModel } from './source';

const fixture = parseCatalogue(readModelsDevFixture());
const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The fixture with one entry changed. */
const changed = (provider: string, id: string, patch: Partial<CatalogueModel>): Catalogue => ({
  ...fixture,
  providers: {
    ...fixture.providers,
    [provider]: {
      models: (fixture.providers[provider]?.models ?? []).map((m) =>
        m.id === id ? { ...m, ...patch } : m,
      ),
    },
  },
});

/** The fixture with its Bedrock copies moved to another region prefix. */
const inRegion = (prefix: string): Catalogue => ({
  ...fixture,
  providers: {
    ...fixture.providers,
    'amazon-bedrock': {
      models: (fixture.providers['amazon-bedrock']?.models ?? []).map((m) => ({
        ...m,
        id: m.id.replace(/^us\./, prefix),
      })),
    },
  },
});

const seen = (id: string, resolvedId: string | null, efforts: Effort[] = ALL): SeenModel => ({
  id,
  resolvedId,
  efforts,
});

const row = (
  model: string,
  launchId: string,
  family: string | null,
  prices: [number, number] | null,
  efforts: Effort[] = ALL,
): NewAccountModel => ({
  model,
  launchId,
  family,
  efforts,
  inputPrice: prices?.[0] ?? null,
  outputPrice: prices?.[1] ?? null,
});

interface Case {
  name: string;
  kind: AgentAccountKind;
  models: SeenModel[];
  catalogue?: Catalogue;
  expected: NewAccountModel[];
}

const { ClaudeSubscription, AnthropicApiKey, Bedrock, Gateway, CodexSignin } = AccountKind;

const BEDROCK_HAIKU_5_5 = row(
  'claude-haiku-5-5',
  'us.anthropic.claude-haiku-5-5',
  'claude-haiku',
  [0.11, 0.55],
);
const BEDROCK_LIST = [
  seen('us.anthropic.claude-opus-5-5', 'us.anthropic.claude-opus-5-5'),
  seen('haiku', 'us.anthropic.claude-haiku-4-5-20251001-v1:0', []),
];
const BEDROCK_OPUS = row(
  'claude-opus-5-5',
  'us.anthropic.claude-opus-5-5',
  'claude-opus',
  [4.4, 22],
);
const BEDROCK_HAIKU_4_5 = row(
  'claude-haiku-4-5-20251001',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'claude-haiku',
  [1.1, 5.5],
  [],
);

const CASES: Case[] = [
  {
    name: 'a subscription: an alias joins by the concrete model it stands for, and a flat-rate plan has no price',
    kind: ClaudeSubscription,
    models: [seen('opus', 'claude-opus-5-5'), seen('claude-fable-5-1', 'claude-fable-5-1')],
    expected: [
      row('claude-opus-5-5', 'claude-opus-5-5', 'claude-opus', null),
      row('claude-fable-5-1', 'claude-fable-5-1', 'claude-fable', null),
    ],
  },
  {
    name: 'an API key: the maker list price',
    kind: AnthropicApiKey,
    models: [seen('sonnet', 'claude-sonnet-5-5')],
    expected: [row('claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet', [2, 10])],
  },
  {
    name: 'a ChatGPT plan: flat-rate, launched by the name it lists, with the efforts it reports',
    kind: CodexSignin,
    models: [seen('gpt-6-astra', null, ['low', 'max'])],
    expected: [row('gpt-6-astra', 'gpt-6-astra', 'gpt-astra', null, ['low', 'max'])],
  },
  {
    name: 'a gateway: the maker price for a model with an entry, none and no family for one without',
    kind: Gateway,
    models: [seen('claude-opus-5-5', 'claude-opus-5-5'), seen('house-model', 'house-model')],
    expected: [
      row('claude-opus-5-5', 'claude-opus-5-5', 'claude-opus', [4, 20]),
      row('house-model', 'house-model', null, null),
    ],
  },
  {
    name: 'a row with no resolved model beside resolved ones is dropped, not kept under its alias',
    kind: ClaudeSubscription,
    models: [seen('sonnet', null), seen('opus', 'claude-opus-5-5')],
    expected: [row('claude-opus-5-5', 'claude-opus-5-5', 'claude-opus', null)],
  },
  {
    name: 'a model named twice: once, the first row kept',
    kind: ClaudeSubscription,
    models: [
      seen('claude-sonnet-5-5', 'claude-sonnet-5-5', ['low']),
      seen('sonnet', 'claude-sonnet-5-5'),
    ],
    expected: [row('claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet', null, ['low'])],
  },
  {
    name: 'Bedrock: its own prices, and a newer model of a family the list holds, from the efforts the catalogue names',
    kind: Bedrock,
    models: BEDROCK_LIST,
    expected: [BEDROCK_OPUS, BEDROCK_HAIKU_4_5, BEDROCK_HAIKU_5_5],
  },
  ...['eu.', 'global.'].map((prefix): Case => ({
    name: `Bedrock: the addition follows the account's own ${prefix} prefix`,
    kind: Bedrock,
    models: [
      seen(`${prefix}anthropic.claude-opus-5-5`, `${prefix}anthropic.claude-opus-5-5`),
      seen('haiku', `${prefix}anthropic.claude-haiku-4-5-20251001-v1:0`, []),
    ],
    catalogue: inRegion(prefix),
    expected: [
      row('claude-opus-5-5', `${prefix}anthropic.claude-opus-5-5`, 'claude-opus', [4.4, 22]),
      row(
        'claude-haiku-4-5-20251001',
        `${prefix}anthropic.claude-haiku-4-5-20251001-v1:0`,
        'claude-haiku',
        [1.1, 5.5],
        [],
      ),
      { ...BEDROCK_HAIKU_5_5, launchId: `${prefix}anthropic.claude-haiku-5-5` },
    ],
  })),
  {
    name: 'Bedrock: a newer model whose maker entry is deprecated is not added',
    kind: Bedrock,
    models: BEDROCK_LIST,
    catalogue: changed('anthropic', 'claude-haiku-5-5', { deprecated: true }),
    expected: [BEDROCK_OPUS, BEDROCK_HAIKU_4_5],
  },
  {
    name: 'Bedrock: a family whose newest model the list already holds gets no addition',
    kind: Bedrock,
    models: [
      ...BEDROCK_LIST,
      seen('us.anthropic.claude-haiku-5-5', 'us.anthropic.claude-haiku-5-5', ['low']),
    ],
    expected: [BEDROCK_OPUS, BEDROCK_HAIKU_4_5, { ...BEDROCK_HAIKU_5_5, efforts: ['low'] }],
  },
  {
    name: 'Bedrock: a newer model that models.dev calls deprecated is not added',
    kind: Bedrock,
    models: BEDROCK_LIST,
    catalogue: changed('amazon-bedrock', 'us.anthropic.claude-haiku-5-5', { deprecated: true }),
    expected: [BEDROCK_OPUS, BEDROCK_HAIKU_4_5],
  },
  {
    name: 'Bedrock: a model with no efforts in the catalogue is added with none reported',
    kind: Bedrock,
    models: BEDROCK_LIST,
    catalogue: changed('amazon-bedrock', 'us.anthropic.claude-haiku-5-5', { efforts: [] }),
    expected: [BEDROCK_OPUS, BEDROCK_HAIKU_4_5, { ...BEDROCK_HAIKU_5_5, efforts: [] }],
  },
  {
    name: 'Bedrock: a list with no region prefix of its own gets no addition',
    kind: Bedrock,
    models: [
      seen('claude-opus-5-5', 'claude-opus-5-5'),
      seen('claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001'),
    ],
    expected: [
      row('claude-opus-5-5', 'claude-opus-5-5', 'claude-opus', null),
      row('claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001', 'claude-haiku', null),
    ],
  },
  {
    name: 'Bedrock: a model of another maker is listed with its own entry',
    kind: Bedrock,
    models: [seen('openai.gpt-6.1-sol', 'openai.gpt-6.1-sol')],
    expected: [row('openai.gpt-6.1-sol', 'openai.gpt-6.1-sol', 'gpt-sol', [2.2, 11])],
  },
  {
    name: 'a Claude subscription never gets a Bedrock addition',
    kind: ClaudeSubscription,
    models: [seen('haiku', 'claude-haiku-4-5-20251001')],
    expected: [row('claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001', 'claude-haiku', null)],
  },
];

describe('offerFromList', () => {
  it.each(CASES)('offers $name', ({ kind, models, catalogue, expected }) => {
    expect(offerFromList(kind, models, catalogue ?? fixture)).toEqual(expected);
  });
});
