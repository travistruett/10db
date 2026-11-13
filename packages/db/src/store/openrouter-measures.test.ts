import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  endpointStatsReadAt,
  listOpenRouterMeasures,
  replaceEndpointStats,
  replaceOpenRouterScores,
  type OpenRouterScoreInput,
} from './openrouter-measures';
import { createTestStore } from './test-support';
import type { Store } from './store';

let store: Store;
let close: () => void;

beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

const aaScore = (id: string, intelligence: number): OpenRouterScoreInput => ({
  id,
  source: 'aa',
  intelligence,
  coding: null,
  agentic: null,
  benchmark: null,
  accuracy: null,
  costPerTaskUsd: null,
});
const ownScore = (
  id: string,
  benchmark: string | null,
  accuracy: number,
): OpenRouterScoreInput => ({
  id,
  source: 'openrouter',
  intelligence: null,
  coding: null,
  agentic: null,
  benchmark,
  accuracy,
  costPerTaskUsd: 0.5,
});

const shape = (rows: ReturnType<typeof listOpenRouterMeasures>) =>
  rows.map((r) => `${r.id}|${r.kind}|${r.key}`);

describe('replaceOpenRouterScores', () => {
  it('keeps only the second set when scores are replaced twice', () => {
    store.write((ctx) => {
      replaceOpenRouterScores(
        ctx,
        [aaScore('acme/a', 10), ownScore('acme/a', 'gpqa', 0.4)],
        '2026-01-01T00:00:00.000Z',
      );
    });
    store.write((ctx) => {
      replaceOpenRouterScores(ctx, [aaScore('acme/b', 20)], '2026-01-02T00:00:00.000Z');
    });
    expect(shape(listOpenRouterMeasures(store.db))).toEqual(['acme/b|score_aa|']);
  });

  it('keeps two benchmarks of one model as two rows, and a null benchmark under the empty key', () => {
    store.write((ctx) => {
      replaceOpenRouterScores(
        ctx,
        [
          ownScore('acme/a', 'gpqa', 0.4),
          ownScore('acme/a', 'tau', 0.6),
          ownScore('acme/a', null, 0.7),
        ],
        '2026-01-01T00:00:00.000Z',
      );
    });
    expect(shape(listOpenRouterMeasures(store.db)).sort()).toEqual([
      'acme/a|score_openrouter|',
      'acme/a|score_openrouter|gpqa',
      'acme/a|score_openrouter|tau',
    ]);
  });

  it('leaves speed rows alone', () => {
    store.write((ctx) => {
      replaceEndpointStats(
        ctx,
        'acme/a',
        [{ provider: 'Alpha', tokensPerSecond: 50, latencyMs: 300 }],
        '2026-01-01T00:00:00.000Z',
      );
      replaceOpenRouterScores(ctx, [aaScore('acme/a', 10)], '2026-01-02T00:00:00.000Z');
    });
    expect(shape(listOpenRouterMeasures(store.db)).sort()).toEqual([
      'acme/a|score_aa|',
      'acme/a|speed|Alpha',
    ]);
  });

  it('stores every field and the time', () => {
    store.write((ctx) => {
      replaceOpenRouterScores(ctx, [ownScore('acme/a', 'gpqa', 0.4)], '2026-01-01T00:00:00.000Z');
    });
    expect(listOpenRouterMeasures(store.db)).toEqual([
      {
        id: 'acme/a',
        kind: 'score_openrouter',
        key: 'gpqa',
        intelligence: null,
        coding: null,
        agentic: null,
        accuracy: 0.4,
        costPerTaskUsd: 0.5,
        tokensPerSecond: null,
        latencyMs: null,
        measuredAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });
});

describe('replaceEndpointStats', () => {
  it('replaces one id and leaves another id alone, and keeps a null speed null', () => {
    store.write((ctx) => {
      replaceEndpointStats(
        ctx,
        'acme/a',
        [{ provider: 'Alpha', tokensPerSecond: 50, latencyMs: 300 }],
        '2026-01-01T00:00:00.000Z',
      );
      replaceEndpointStats(
        ctx,
        'acme/b',
        [{ provider: 'Alpha', tokensPerSecond: 70, latencyMs: 200 }],
        '2026-01-01T00:00:00.000Z',
      );
    });
    store.write((ctx) => {
      replaceEndpointStats(
        ctx,
        'acme/a',
        [{ provider: 'Beta', tokensPerSecond: null, latencyMs: null }],
        '2026-01-02T00:00:00.000Z',
      );
    });
    const rows = listOpenRouterMeasures(store.db);
    expect(shape(rows).sort()).toEqual(['acme/a|speed|Beta', 'acme/b|speed|Alpha']);
    expect(rows.find((r) => r.id === 'acme/a')).toMatchObject({
      tokensPerSecond: null,
      latencyMs: null,
    });
    expect(rows.find((r) => r.id === 'acme/b')).toMatchObject({ tokensPerSecond: 70 });
  });

  it('answers each id with the time its stats were read', () => {
    store.write((ctx) => {
      replaceEndpointStats(
        ctx,
        'acme/a',
        [{ provider: 'Alpha', tokensPerSecond: 1, latencyMs: 1 }],
        '2026-01-01T00:00:00.000Z',
      );
      replaceEndpointStats(
        ctx,
        'acme/b',
        [{ provider: 'Alpha', tokensPerSecond: 1, latencyMs: 1 }],
        '2026-01-02T00:00:00.000Z',
      );
    });
    expect([...endpointStatsReadAt(store.db)]).toEqual([
      ['acme/a', '2026-01-01T00:00:00.000Z'],
      ['acme/b', '2026-01-02T00:00:00.000Z'],
    ]);
  });
});
