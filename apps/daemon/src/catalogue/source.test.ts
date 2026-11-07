import { describe, expect, it } from 'vitest';
import { readModelsDevFixture as readFixture } from '../../test/models-dev-fixture';
import { CatalogueError, parseCatalogue } from './source';

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'claude-x',
  name: 'Claude X',
  family: 'claude-x',
  release_date: '2026-01-01',
  cost: { input: 1, output: 5 },
  ...over,
});
const doc = (models: Record<string, unknown>, provider = 'anthropic') => ({
  [provider]: { models },
});

describe('parseCatalogue', () => {
  const fixture = parseCatalogue(readFixture());
  const find = (provider: string, id: string) =>
    fixture.providers[provider]?.models.find((m) => m.id === id);

  it('keeps only the providers 10db reaches', () => {
    expect(Object.keys(fixture.providers)).toEqual([
      'anthropic',
      'openai',
      'amazon-bedrock',
      'openrouter',
    ]);
    expect(fixture.skipped).toBe(0);
  });

  it('reads the real entries: prices, family, date, and extra cost keys ignored', () => {
    expect(find('anthropic', 'claude-opus-5-5')).toEqual({
      provider: 'anthropic',
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      maker: 'anthropic',
      family: 'claude-opus',
      releaseDate: '2026-09-22',
      deprecated: false,
      inputPrice: 4,
      outputPrice: 20,
    });
    expect(find('openai', 'gpt-6.1-terra')).toMatchObject({ inputPrice: 1, outputPrice: 5 });
  });

  it.each([
    ['anthropic', 'claude-opus-5-5', 'anthropic'],
    ['openai', 'gpt-6-luna', 'openai'],
    ['amazon-bedrock', 'us.anthropic.claude-opus-5-5', 'anthropic'],
    ['amazon-bedrock', 'openai.gpt-6.1-sol', 'openai'],
    ['openrouter', 'anthropic/claude-opus-5.5', 'anthropic'],
  ])('%s %s has the maker %s', (provider, id, maker) => {
    expect(find(provider, id)?.maker).toBe(maker);
  });

  it('keeps an entry with no cost, as unpriced, and one with no family, as familyless', () => {
    expect(find('openrouter', 'openrouter/fusion')).toMatchObject({
      family: null,
      inputPrice: null,
      outputPrice: null,
    });
    expect(find('openai', 'gpt-image-1.5')).toMatchObject({ deprecated: true, outputPrice: null });
    expect(find('openrouter', 'unbiased/pareto-26.9')).toMatchObject({
      family: null,
      outputPrice: 7.5,
    });
  });

  it('marks a deprecated entry', () => {
    expect(find('openai', 'o1')?.deprecated).toBe(true);
  });

  it('skips and counts an entry that is malformed, keeping the rest', () => {
    const parsed = parseCatalogue(
      doc({
        good: entry(),
        noId: entry({ id: undefined }),
        textPrice: entry({ id: 'y', cost: { input: 1, output: 'free' } }),
        notAnObject: 'nope',
      }),
    );
    expect(parsed.providers['anthropic']?.models.map((m) => m.id)).toEqual(['claude-x']);
    expect(parsed.skipped).toBe(3);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'models'],
    ['no provider 10db reaches', { deepinfra: { models: {} } }],
    ['a provider with no model list', { anthropic: { models: 'nope' } }],
  ])('rejects a document that is %s', (_name, raw) => {
    expect(() => parseCatalogue(raw)).toThrow(CatalogueError);
  });

  describe('hash', () => {
    const hashOf = (over: Record<string, unknown>) => parseCatalogue(doc({ a: entry(over) })).hash;

    it('is the same for the same document, whatever the order of its models', () => {
      const one = parseCatalogue(doc({ a: entry({ id: 'a' }), b: entry({ id: 'b' }) }));
      const two = parseCatalogue(doc({ b: entry({ id: 'b' }), a: entry({ id: 'a' }) }));
      expect(one.hash).toBe(two.hash);
    });

    it.each([
      ['the name', { name: 'Renamed' }],
      ['the release date', { release_date: '2026-02-02' }],
      ['a cache price', { cost: { input: 1, output: 5, cache_read: 0.1 } }],
      ['a field 10db does not read', { limit: { context: 1 } }],
    ])('does not move when only %s changes', (_name, over) => {
      expect(hashOf(over)).toBe(hashOf({}));
    });

    it.each([
      ['the id', { id: 'claude-y' }],
      ['the output price', { cost: { input: 1, output: 6 } }],
      ['the input price', { cost: { input: 2, output: 5 } }],
      ['the status', { status: 'deprecated' }],
      ['the family', { family: 'claude-z' }],
    ])('moves when %s changes', (_name, over) => {
      expect(hashOf(over)).not.toBe(hashOf({}));
    });
  });
});
