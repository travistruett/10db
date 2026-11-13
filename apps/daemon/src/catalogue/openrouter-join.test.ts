import { Provider } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { readModelsDevFixture } from '../../test/models-dev-fixture';
import type { OpenRouterMeasure } from '@10db/db';
import { groupMeasuresByModel, joinOpenRouterId, openRouterProvider } from './openrouter-join';
import { parseCatalogue, type Catalogue } from './source';

const fixture = parseCatalogue(readModelsDevFixture());

/** The fixture with two Anthropic entries that normalise to one ID and match no other way, so neither can be chosen. */
const withTwinEntries = (): Catalogue => {
  const models = fixture.providers['anthropic']?.models ?? [];
  const [first] = models;
  if (!first) throw new Error('the fixture has no Anthropic model');
  return {
    ...fixture,
    providers: {
      ...fixture.providers,
      anthropic: {
        models: [
          ...models,
          { ...first, id: 'claude-twin-1-0' },
          { ...first, id: 'Claude-Twin-1-0' },
        ],
      },
    },
  };
};

describe('openRouterProvider', () => {
  it.each([
    { name: 'anthropic prefix', id: 'anthropic/claude-opus-5.5', expected: Provider.Claude },
    { name: 'openai prefix', id: 'openai/gpt-6.1-sol', expected: Provider.Codex },
    { name: 'another maker', id: 'google/gemini-x', expected: null },
    { name: 'a router', id: '~anthropic/claude-sonnet-latest', expected: null },
    { name: 'no prefix', id: 'claude-opus-5-5', expected: null },
  ])('reads $name', ({ id, expected }) => {
    expect(openRouterProvider(id)).toBe(expected);
  });
});

describe('joinOpenRouterId', () => {
  it.each([
    {
      name: 'an Anthropic id written with dots',
      id: 'anthropic/claude-opus-5.5',
      expected: 'claude-opus-5-5',
    },
    {
      name: 'a dated permaslug',
      id: 'anthropic/claude-opus-5.5-20261109',
      expected: 'claude-opus-5-5',
    },
    { name: 'an OpenAI model', id: 'openai/gpt-6.1-sol', expected: 'gpt-6.1-sol' },
    {
      name: 'a router that follows the newest',
      id: '~anthropic/claude-sonnet-latest',
      expected: null,
    },
    { name: 'another maker', id: 'google/gemini-x', expected: null },
    {
      name: 'an unknown model of a known maker',
      id: 'anthropic/claude-nothing-9.9',
      expected: null,
    },
    { name: 'a near miss, never fuzzy', id: 'anthropic/claude-opus-5.6', expected: null },
  ])('joins $name', ({ id, expected }) => {
    expect(joinOpenRouterId(id, fixture)).toBe(expected);
  });

  it('joins nothing when two entries normalise to the id', () => {
    expect(joinOpenRouterId('anthropic/claude-twin-1.0', withTwinEntries())).toBeNull();
  });
});

describe('groupMeasuresByModel', () => {
  const measure = (id: string): OpenRouterMeasure => ({
    id,
    kind: 'speed',
    key: 'Alpha',
    intelligence: null,
    coding: null,
    agentic: null,
    accuracy: null,
    costPerTaskUsd: null,
    tokensPerSecond: 50,
    latencyMs: 100,
    measuredAt: '2026-11-13T00:00:00.000Z',
  });

  it('groups rows by the catalogue model they join to and drops the rest', () => {
    const grouped = groupMeasuresByModel(
      [
        measure('anthropic/claude-opus-5.5'),
        measure('google/gemini-x'),
        measure('anthropic/claude-opus-5.5'),
      ],
      fixture,
    );
    expect([...grouped.keys()]).toEqual(['claude-opus-5-5']);
    expect(grouped.get('claude-opus-5-5')).toHaveLength(2);
  });

  it('answers nothing without a catalogue', () => {
    expect(groupMeasuresByModel([measure('anthropic/claude-opus-5.5')], null).size).toBe(0);
  });
});
