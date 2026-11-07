import { Provider } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { readModelsDevFixture } from '../../test/models-dev-fixture';
import { joinModel } from './join';
import { parseCatalogue, type Catalogue } from './source';

const fixture = parseCatalogue(readModelsDevFixture());

/** The fixture without the maker's own entry for `id`, as when models.dev lists a model only under Bedrock. */
const withoutMakerEntry = (id: string): Catalogue => ({
  ...fixture,
  providers: {
    ...fixture.providers,
    anthropic: {
      models: (fixture.providers['anthropic']?.models ?? []).filter((m) => m.id !== id),
    },
  },
});

interface Case {
  name: string;
  id: string;
  provider: Provider;
  catalogue?: Catalogue;
  /** The provider and ID of the entry it joins to; null when it joins to nothing. */
  expected: [string, string] | null;
}

const { Claude, Codex } = Provider;

const CASES: Case[] = [
  {
    name: 'an exact ID',
    id: 'claude-opus-5-5',
    provider: Claude,
    expected: ['anthropic', 'claude-opus-5-5'],
  },
  {
    name: 'an exact ID with dots',
    id: 'gpt-6.1-sol',
    provider: Codex,
    expected: ['openai', 'gpt-6.1-sol'],
  },
  {
    name: 'dots written as hyphens',
    id: 'gpt-6-1-sol',
    provider: Codex,
    expected: ['openai', 'gpt-6.1-sol'],
  },
  {
    name: 'hyphens written as dots',
    id: 'claude-opus-5.5',
    provider: Claude,
    expected: ['anthropic', 'claude-opus-5-5'],
  },
  {
    name: 'a different case',
    id: 'Claude-Opus-5-5',
    provider: Claude,
    expected: ['anthropic', 'claude-opus-5-5'],
  },
  {
    name: 'a vendor prefix',
    id: 'anthropic/claude-opus-5-5',
    provider: Claude,
    expected: ['anthropic', 'claude-opus-5-5'],
  },
  {
    name: 'a vendor prefix and dots',
    id: 'anthropic/claude-opus-5.5',
    provider: Claude,
    expected: ['anthropic', 'claude-opus-5-5'],
  },
  {
    name: 'a Bedrock region prefix',
    id: 'us.anthropic.claude-opus-5-5',
    provider: Claude,
    expected: ['anthropic', 'claude-opus-5-5'],
  },
  {
    name: 'another Bedrock region prefix',
    id: 'global.anthropic.claude-haiku-5-5',
    provider: Claude,
    expected: ['anthropic', 'claude-haiku-5-5'],
  },
  {
    name: 'a Bedrock ID with no region',
    id: 'anthropic.claude-sonnet-5-5',
    provider: Claude,
    expected: ['anthropic', 'claude-sonnet-5-5'],
  },
  {
    name: 'a Bedrock version suffix',
    id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    provider: Claude,
    expected: ['anthropic', 'claude-haiku-4-5-20251001'],
  },
  {
    name: 'the Bedrock entry when the maker has none',
    id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    provider: Claude,
    catalogue: withoutMakerEntry('claude-haiku-4-5-20251001'),
    expected: ['amazon-bedrock', 'us.anthropic.claude-haiku-4-5-20251001-v1:0'],
  },
  {
    name: 'another maker model on Bedrock, by its own Bedrock entry',
    id: 'openai.gpt-6.1-sol',
    provider: Claude,
    expected: ['amazon-bedrock', 'openai.gpt-6.1-sol'],
  },
  { name: 'a Claude Code alias', id: 'sonnet', provider: Claude, expected: null },
  {
    name: 'a name that is only part of an ID',
    id: 'claude-opus',
    provider: Claude,
    expected: null,
  },
  {
    name: 'an ID with a suffix the catalogue lacks',
    id: 'claude-opus-5-5-preview',
    provider: Claude,
    expected: null,
  },
  { name: 'a model of the other maker', id: 'gpt-6-astra', provider: Claude, expected: null },
  { name: 'a model of the other runtime', id: 'claude-opus-5-5', provider: Codex, expected: null },
];

describe('joinModel', () => {
  it.each(CASES)('joins $name', ({ id, provider, catalogue, expected }) => {
    const joined = joinModel(id, provider, catalogue ?? fixture);
    expect(joined === null ? null : [joined.provider, joined.id]).toEqual(expected);
  });
});
