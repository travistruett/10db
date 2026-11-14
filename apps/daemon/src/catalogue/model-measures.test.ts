import type { ModelMeasuresDto } from '@10db/contracts';
import { OpenRouterMeasureKind, type OpenRouterMeasure } from '@10db/db';
import { describe, expect, it } from 'vitest';
import { readModelsDevFixture } from '../../test/models-dev-fixture';
import { modelMeasures } from './model-measures';
import { parseCatalogue } from './source';

const catalogue = parseCatalogue(readModelsDevFixture());
const AT = '2026-11-13T10:00:00.000Z';

const row = (
  over: Partial<OpenRouterMeasure> & Pick<OpenRouterMeasure, 'id'>,
): OpenRouterMeasure => ({
  kind: OpenRouterMeasureKind.Speed,
  key: 'Anthropic',
  intelligence: null,
  coding: null,
  agentic: null,
  accuracy: null,
  costPerTaskUsd: null,
  tokensPerSecond: null,
  latencyMs: null,
  measuredAt: AT,
  ...over,
});
const speed = (id: string, provider: string, tokensPerSecond: number | null) =>
  row({ id, key: provider, tokensPerSecond, latencyMs: 100 });
const evalRow = (id: string, benchmark: string) =>
  row({
    id,
    kind: OpenRouterMeasureKind.ScoreOpenRouter,
    key: benchmark,
    accuracy: 0.5,
    costPerTaskUsd: 0.25,
  });
const relayedRow = (id: string) =>
  row({ id, kind: OpenRouterMeasureKind.ScoreAa, key: '', intelligence: 41 });

const base: Parameters<typeof modelMeasures>[0] = {
  model: 'claude-opus-5-5',
  rows: [],
  catalogue,
  keyed: true,
  off: false,
  accountProvider: null,
};
const run = (over: Partial<typeof base>): ModelMeasuresDto => modelMeasures({ ...base, ...over });

describe('modelMeasures rows', () => {
  it('takes the rows of an OpenRouter id as they are', () => {
    const out = run({
      model: 'anthropic/claude-opus-5.5',
      rows: [
        speed('anthropic/claude-opus-5.5', 'Anthropic', 40),
        speed('openai/gpt-6.1-sol', 'OpenAI', 9),
      ],
    });
    expect(out.openRouterIds).toEqual(['anthropic/claude-opus-5.5']);
    expect(out.speeds.map((s) => s.provider)).toEqual(['Anthropic']);
  });

  it('joins a catalogue id to the rows of a dated permaslug', () => {
    const out = run({ rows: [speed('anthropic/claude-opus-5.5-20261109', 'Anthropic', 40)] });
    expect(out.openRouterIds).toEqual(['anthropic/claude-opus-5.5-20261109']);
    expect(out.speeds).toHaveLength(1);
  });

  it('lists both OpenRouter ids joined to one model, sorted', () => {
    const out = run({
      rows: [
        speed('anthropic/claude-opus-5.5-20261109', 'Anthropic', 40),
        speed('anthropic/claude-opus-5.5', 'Amazon Bedrock', 30),
      ],
    });
    expect(out.openRouterIds).toEqual([
      'anthropic/claude-opus-5.5',
      'anthropic/claude-opus-5.5-20261109',
    ]);
    expect(out.speeds).toHaveLength(2);
  });

  it('joins a router id to nothing', () => {
    const out = run({ rows: [speed('~anthropic/claude-opus-latest', 'Anthropic', 40)] });
    expect(out.openRouterIds).toEqual([]);
    expect(out.speeds).toEqual([]);
    expect(out.speedsMissing).toBe('OpenRouter lists no model that matches this one.');
  });

  it('orders speeds fastest first, a missing throughput last', () => {
    const out = run({
      rows: [
        speed('anthropic/claude-opus-5.5', 'Slow', 10),
        speed('anthropic/claude-opus-5.5', 'None', null),
        speed('anthropic/claude-opus-5.5', 'Fast', 90),
      ],
    });
    expect(out.speeds.map((s) => s.provider)).toEqual(['Fast', 'Slow', 'None']);
  });

  it('returns an eval row and a speed row of one model together', () => {
    const out = run({
      rows: [
        speed('anthropic/claude-opus-5.5', 'Anthropic', 40),
        evalRow('anthropic/claude-opus-5.5', 'terminal'),
        relayedRow('anthropic/claude-opus-5.5'),
      ],
      accountProvider: 'Anthropic',
    });
    expect(out.evals).toEqual([
      { benchmark: 'terminal', accuracy: 0.5, costPerTaskUsd: 0.25, measuredAt: AT },
    ]);
    expect(out.speeds).toEqual([
      { provider: 'Anthropic', tokensPerSecond: 40, latencyMs: 100, measuredAt: AT },
    ]);
    expect(out.evalsMissing).toBeNull();
    expect(out.speedsMissing).toBeNull();
    expect(out.accountProvider).toBe('Anthropic');
  });
});

describe('modelMeasures reasons', () => {
  const stored = [speed('anthropic/claude-opus-5.5', 'Anthropic', 40)];
  it.each([
    {
      name: 'off, even with stored rows',
      input: { off: true, rows: stored },
      both: "OpenRouter isn't read while 10db runs with TENDB_JUDGE=off or TENDB_BENCHMARKS=off.",
    },
    {
      name: 'no key, even with stored rows',
      input: { keyed: false, rows: stored },
      both: 'Add an OpenRouter account for measured speed and eval costs.',
    },
    {
      name: 'no catalogue and no exact rows',
      input: { catalogue: null, rows: stored },
      both: "The model catalogue hasn't been read yet.",
    },
    {
      name: 'no join and no rows',
      input: { rows: [] },
      both: 'OpenRouter lists no model that matches this one.',
    },
  ])('says why both sections are empty: $name', ({ input, both }) => {
    const out = run(input);
    expect(out.evals).toEqual([]);
    expect(out.speeds).toEqual([]);
    expect(out.evalsMissing).toBe(both);
    expect(out.speedsMissing).toBe(both);
    expect(out.openRouterIds).toEqual([]);
  });

  it('names the joined ids but no section when only relayed scores are stored', () => {
    const out = run({ rows: [relayedRow('anthropic/claude-opus-5.5')] });
    expect(out.openRouterIds).toEqual(['anthropic/claude-opus-5.5']);
    expect(out.evalsMissing).toBe('Not read from OpenRouter yet.');
    expect(out.speedsMissing).toBe('Not read from OpenRouter yet.');
  });

  it('keeps exact rows when the catalogue is missing', () => {
    const out = run({ catalogue: null, model: 'anthropic/claude-opus-5.5', rows: stored });
    expect(out.speeds).toHaveLength(1);
  });

  it('says OpenRouter ran no evals when speeds are stored and evals are not', () => {
    const out = run({ rows: stored });
    expect(out.evalsMissing).toBe('OpenRouter has run no evals on this model.');
    expect(out.speedsMissing).toBeNull();
  });

  it('says speeds are not read yet when only evals are stored', () => {
    const out = run({ rows: [evalRow('anthropic/claude-opus-5.5', 'terminal')] });
    expect(out.speedsMissing).toBe('Not read from OpenRouter yet.');
    expect(out.evalsMissing).toBeNull();
  });
});
