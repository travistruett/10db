import { z } from 'zod';
import { ScoreKind } from './states';

/**
 * One model from Artificial Analysis's free list, as 10db stores it locally. It is shown
 * only with AA's attribution and never leaves the machine.
 */
export const AaModelDto = z.object({
  slug: z.string().min(1),
  name: z.string(),
  creator: z.string(),
  releaseDate: z.string().nullable(),
  indexVersion: z.string().nullable(),
  /** AA's evaluation indexes by their API name, e.g. `artificial_analysis_intelligence_index`. */
  evaluations: z.record(z.string(), z.number().nullable()),
  costPerTaskUsd: z.number().nullable(),
  pricing: z.record(z.string(), z.number().nullable()),
  performance: z.record(z.string(), z.number().nullable()),
  fetchedAt: z.iso.datetime(),
});
export type AaModelDto = z.infer<typeof AaModelDto>;

export const BenchmarkStatusDto = z.object({
  keyConfigured: z.boolean(),
  /** The last attempt, and the last attempt that stored data; the daily sync runs from the second. */
  lastSyncAt: z.iso.datetime().nullable(),
  lastSuccessAt: z.iso.datetime().nullable(),
  outcome: z.enum(['ok', 'no_key', 'unauthorized', 'rate_limited', 'failed']).nullable(),
  message: z.string().nullable(),
  models: z.int().min(0),
  /** AA's Intelligence Index version (major.minor) from the latest successful sync. */
  indexVersion: z.string().nullable().default(null),
  /** Enabled profiles routing can't use at all: AA doesn't list the slug, or lists it without a cost or an Intelligence score. */
  unmeasuredProfiles: z.array(z.string()),
  /** Enabled profiles routing can use that AA gave no score of some kind, with the kinds missing. */
  missingScores: z
    .array(z.object({ profile: z.string(), kinds: z.array(z.enum(ScoreKind)) }))
    .default([]),
});
export type BenchmarkStatusDto = z.infer<typeof BenchmarkStatusDto>;
