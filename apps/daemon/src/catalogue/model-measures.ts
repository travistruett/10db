import type { ModelMeasuresDto } from '@10db/contracts';
import { OpenRouterMeasureKind, type OpenRouterMeasure } from '@10db/db';
import { groupMeasuresByModel } from './openrouter-join';
import type { Catalogue } from './source';

const OFF = "OpenRouter isn't read while 10db runs with TENDB_JUDGE=off or TENDB_BENCHMARKS=off.";
const NO_KEY = 'Add an OpenRouter account for measured speed and eval costs.';
const NO_CATALOGUE = "The model catalogue hasn't been read yet.";
const NO_MATCH = 'OpenRouter lists no model that matches this one.';
const NOT_READ = 'Not read from OpenRouter yet.';
const NO_EVALS = 'OpenRouter has run no evals on this model.';

function empty(accountProvider: string | null, why: string): ModelMeasuresDto {
  return {
    openRouterIds: [],
    accountProvider,
    evals: [],
    speeds: [],
    evalsMissing: why,
    speedsMissing: why,
  };
}

/** Faster first; a provider with no throughput after those that have one. */
function byThroughput(
  a: { tokensPerSecond: number | null },
  b: { tokensPerSecond: number | null },
) {
  return (b.tokensPerSecond ?? -1) - (a.tokensPerSecond ?? -1);
}

/**
 * The stored OpenRouter rows of one model: its OpenRouter benchmark runs and each provider's speed, with why a
 * section is empty. `model` is a catalogue id or an OpenRouter id; rows of exactly that id are taken as they
 * are, otherwise the rows that join to the catalogue model. Off or without a key no row is returned at all,
 * stored ones included, as the model list leaves them out.
 */
export function modelMeasures(input: {
  readonly model: string;
  readonly rows: readonly OpenRouterMeasure[];
  readonly catalogue: Catalogue | null;
  readonly keyed: boolean;
  readonly off: boolean;
  readonly accountProvider: string | null;
}): ModelMeasuresDto {
  const { accountProvider } = input;
  if (input.off) return empty(accountProvider, OFF);
  if (!input.keyed) return empty(accountProvider, NO_KEY);
  const exact = input.rows.filter((row) => row.id === input.model);
  if (exact.length === 0 && input.catalogue === null) return empty(accountProvider, NO_CATALOGUE);
  const rows =
    exact.length > 0
      ? exact
      : (groupMeasuresByModel(input.rows, input.catalogue).get(input.model) ?? []);
  if (rows.length === 0) return empty(accountProvider, NO_MATCH);

  const evals = rows
    .filter((row) => row.kind === OpenRouterMeasureKind.ScoreOpenRouter)
    .map((row) => ({
      benchmark: row.key,
      accuracy: row.accuracy,
      costPerTaskUsd: row.costPerTaskUsd,
      measuredAt: row.measuredAt,
    }))
    .sort((a, b) => a.benchmark.localeCompare(b.benchmark));
  const speeds = rows
    .filter((row) => row.kind === OpenRouterMeasureKind.Speed)
    .map((row) => ({
      provider: row.key,
      tokensPerSecond: row.tokensPerSecond,
      latencyMs: row.latencyMs,
      measuredAt: row.measuredAt,
    }))
    .sort(byThroughput);
  const nothingYet = evals.length === 0 && speeds.length === 0;
  return {
    openRouterIds: [...new Set(rows.map((row) => row.id))].sort(),
    accountProvider,
    evals,
    speeds,
    evalsMissing:
      evals.length > 0 ? null : nothingYet ? NOT_READ : speeds.length > 0 ? NO_EVALS : NOT_READ,
    speedsMissing: speeds.length > 0 ? null : NOT_READ,
  };
}
