import { z } from 'zod';
import { SECRET_CHARACTERS } from './accounts';

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
  /** AA's `performance_v3` means by their API name, e.g. `mean_output_tokens_per_second`. */
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
  /** Enabled profiles routing can't use for the Intelligence comparison: AA doesn't list the slug, or lists it without a cost or an Intelligence score. */
  unmeasuredProfiles: z.array(z.string()),
  /** The daemon was started with `TENDB_BENCHMARKS=off`: it reads no key and calls no one. */
  off: z.boolean().default(false),
  /** A sync is running now, so the outcome above is the one before it. */
  syncing: z.boolean().default(false),
});
export type BenchmarkStatusDto = z.infer<typeof BenchmarkStatusDto>;

/** `PUT /benchmarks/key`. The key reaches the Keychain on `security`'s standard input, so it is printable ASCII. */
export const BenchmarkKeyInput = z.strictObject({
  key: z
    .string()
    .trim()
    .min(1)
    .max(8192)
    .regex(SECRET_CHARACTERS, 'printable ASCII with no spaces, double quotes or backslashes'),
});
export type BenchmarkKeyInput = z.infer<typeof BenchmarkKeyInput>;
