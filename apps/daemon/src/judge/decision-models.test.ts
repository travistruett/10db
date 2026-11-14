import { describe, expect, it } from 'vitest';
import { decisionModelsFrom } from './decision-models';

/** One entry of OpenRouter's `/models` list, shaped as it answered for a decision model. */
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'liquid/d1',
  name: 'Liquid: D1',
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['decisions'] },
  pricing: { prompt: '0.00000002', completion: '0', input_cache_read: '0.000000005' },
  endpoints: ['/api/alpha/decisions'],
  ...over,
});

const list = (...data: unknown[]) => ({ data });

describe('decisionModelsFrom', () => {
  it('reads a decision model with its maker, name and price per million tokens', () => {
    expect(decisionModelsFrom(list(entry()))).toEqual([
      {
        id: 'liquid/d1',
        name: 'D1',
        maker: 'Liquid',
        latest: false,
        inputUsdPerMillion: 0.02,
        outputUsdPerMillion: 0,
        cantCall: null,
      },
    ]);
  });

  it.each([
    {
      case: 'a router that always resolves to the newest model is the latest',
      over: { id: '~typesafe/jev-latest', name: 'TypeSafe: Jev Latest' },
      expected: { latest: true, maker: 'TypeSafe', name: 'Jev Latest' },
    },
    {
      case: 'a name without a maker takes the maker from the id',
      over: { id: 'morph/reflex', name: 'Reflex' },
      expected: { maker: 'morph', name: 'Reflex' },
    },
    {
      case: 'a free model costs nothing',
      over: { id: 'respan/span-01-lite:free', pricing: { prompt: '0', completion: '0' } },
      expected: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
    },
    {
      case: 'a model served only for extractions cannot be called',
      over: { endpoints: ['/api/alpha/extractions'] },
      expected: {
        cantCall:
          "10db can't call this model yet: OpenRouter serves it for extractions, not decisions.",
      },
    },
    {
      case: 'a model that reads no text cannot be called',
      over: {
        architecture: { input_modalities: ['image'], output_modalities: ['decisions'] },
      },
      expected: { cantCall: "10db can't call this model yet: it reads no text." },
    },
    {
      case: 'a list that names no endpoints is read as the decisions endpoint',
      over: { endpoints: undefined },
      expected: { cantCall: null },
    },
  ])('$case', ({ over, expected }) => {
    expect(decisionModelsFrom(list(entry(over)))[0]).toMatchObject(expected);
  });

  it.each([
    [
      'a chat model',
      entry({
        id: 'openai/gpt-6',
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      }),
    ],
    ['an entry with no id', entry({ id: undefined })],
    ['a price that is not a number', entry({ pricing: { prompt: 'variable', completion: '0' } })],
    ['a negative price', entry({ pricing: { prompt: '-1', completion: '-1' } })],
    ['an empty price', entry({ pricing: { prompt: '', completion: '0' } })],
  ])('leaves out %s and keeps the rest', (_name, bad) => {
    expect(decisionModelsFrom(list(bad, entry())).map((m) => m.id)).toEqual(['liquid/d1']);
  });

  it('lists by maker, the latest router first, then by name', () => {
    const models = decisionModelsFrom(
      list(
        entry({ id: 'typesafe/jev-1.14', name: 'TypeSafe: Jev 1.14' }),
        entry({ id: 'liquid/d1', name: 'Liquid: D1' }),
        entry({ id: '~typesafe/jev-latest', name: 'TypeSafe: Jev Latest' }),
        entry({ id: 'typesafe/jev-1.13', name: 'TypeSafe: Jev 1.13' }),
      ),
    );
    expect(models.map((m) => m.id)).toEqual([
      'liquid/d1',
      '~typesafe/jev-latest',
      'typesafe/jev-1.13',
      'typesafe/jev-1.14',
    ]);
  });

  it.each([
    ['a body that is not a list', { models: [] }],
    ['no body', null],
  ])('refuses %s', (_name, body) => {
    expect(() => decisionModelsFrom(body)).toThrow(/OpenRouter's model list/);
  });
});
