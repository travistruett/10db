import { asc, eq, inArray, and } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export const OpenRouterMeasureKind = {
  ScoreAa: 'score_aa',
  ScoreOpenRouter: 'score_openrouter',
  Speed: 'speed',
} as const;
export type OpenRouterMeasureKind =
  (typeof OpenRouterMeasureKind)[keyof typeof OpenRouterMeasureKind];

/** One score row as the sync reads it: an index set from Artificial Analysis, or one OpenRouter benchmark. */
export interface OpenRouterScoreInput {
  readonly id: string;
  readonly source: 'aa' | 'openrouter';
  readonly intelligence: number | null;
  readonly coding: number | null;
  readonly agentic: number | null;
  readonly benchmark: string | null;
  readonly accuracy: number | null;
  readonly costPerTaskUsd: number | null;
}

/** One provider's p50 speed and latency for a model. */
export interface EndpointStatInput {
  readonly provider: string;
  readonly tokensPerSecond: number | null;
  readonly latencyMs: number | null;
}

export interface OpenRouterMeasure {
  readonly id: string;
  readonly kind: OpenRouterMeasureKind;
  readonly key: string;
  readonly intelligence: number | null;
  readonly coding: number | null;
  readonly agentic: number | null;
  readonly accuracy: number | null;
  readonly costPerTaskUsd: number | null;
  readonly tokensPerSecond: number | null;
  readonly latencyMs: number | null;
  readonly measuredAt: string;
}

const SCORE_KINDS = [OpenRouterMeasureKind.ScoreAa, OpenRouterMeasureKind.ScoreOpenRouter];

const NO_NUMBERS = {
  intelligence: null,
  coding: null,
  agentic: null,
  accuracy: null,
  costPerTaskUsd: null,
  tokensPerSecond: null,
  latencyMs: null,
} as const;

/** Replaces every score row with this read's, in one transaction; speed rows stay. A repeated key keeps the last. */
export function replaceOpenRouterScores(
  ctx: WriteContext,
  rows: readonly OpenRouterScoreInput[],
  at: string,
): void {
  ctx.tx
    .delete(schema.openrouterMeasures)
    .where(inArray(schema.openrouterMeasures.kind, SCORE_KINDS))
    .run();
  for (const row of rows) {
    const aa = row.source === 'aa';
    const values: typeof schema.openrouterMeasures.$inferInsert = {
      ...NO_NUMBERS,
      id: row.id,
      kind: aa ? OpenRouterMeasureKind.ScoreAa : OpenRouterMeasureKind.ScoreOpenRouter,
      key: aa ? '' : (row.benchmark ?? ''),
      ...(aa
        ? { intelligence: row.intelligence, coding: row.coding, agentic: row.agentic }
        : { accuracy: row.accuracy, costPerTaskUsd: row.costPerTaskUsd }),
      measuredAt: at,
    };
    ctx.tx
      .insert(schema.openrouterMeasures)
      .values(values)
      .onConflictDoUpdate({
        target: [
          schema.openrouterMeasures.id,
          schema.openrouterMeasures.kind,
          schema.openrouterMeasures.key,
        ],
        set: values,
      })
      .run();
  }
}

/** Replaces one model's speed rows; another model's, and every score row, stay. */
export function replaceEndpointStats(
  ctx: WriteContext,
  id: string,
  stats: readonly EndpointStatInput[],
  at: string,
): void {
  ctx.tx
    .delete(schema.openrouterMeasures)
    .where(
      and(
        eq(schema.openrouterMeasures.id, id),
        eq(schema.openrouterMeasures.kind, OpenRouterMeasureKind.Speed),
      ),
    )
    .run();
  for (const stat of stats) {
    const values: typeof schema.openrouterMeasures.$inferInsert = {
      ...NO_NUMBERS,
      id,
      kind: OpenRouterMeasureKind.Speed,
      key: stat.provider,
      tokensPerSecond: stat.tokensPerSecond,
      latencyMs: stat.latencyMs,
      measuredAt: at,
    };
    ctx.tx
      .insert(schema.openrouterMeasures)
      .values(values)
      .onConflictDoUpdate({
        target: [
          schema.openrouterMeasures.id,
          schema.openrouterMeasures.kind,
          schema.openrouterMeasures.key,
        ],
        set: values,
      })
      .run();
  }
}

export function listOpenRouterMeasures(db: DbReader): OpenRouterMeasure[] {
  return db
    .select()
    .from(schema.openrouterMeasures)
    .orderBy(
      asc(schema.openrouterMeasures.id),
      asc(schema.openrouterMeasures.kind),
      asc(schema.openrouterMeasures.key),
    )
    .all();
}

/** When each model's speed was last read. A model whose read held no provider has no row, so no time. */
export function endpointStatsReadAt(db: DbReader): ReadonlyMap<string, string> {
  const times = new Map<string, string>();
  for (const row of db
    .select({ id: schema.openrouterMeasures.id, at: schema.openrouterMeasures.measuredAt })
    .from(schema.openrouterMeasures)
    .where(eq(schema.openrouterMeasures.kind, OpenRouterMeasureKind.Speed))
    .orderBy(asc(schema.openrouterMeasures.id), asc(schema.openrouterMeasures.measuredAt))
    .all())
    times.set(row.id, row.at);
  return times;
}
