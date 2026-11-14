import { z } from 'zod';
import { AccountId } from './ids';

/** Which model's stored OpenRouter rows to read, and the account whose provider its speed is marked for. */
export const ModelMeasuresQuery = z.strictObject({
  model: z.string().trim().min(1),
  account: AccountId.optional(),
});
export type ModelMeasuresQuery = z.infer<typeof ModelMeasuresQuery>;

/** One OpenRouter benchmark run on a model: its accuracy and what a task cost. */
export const ModelEvalDto = z.object({
  benchmark: z.string(),
  accuracy: z.number().nullable(),
  costPerTaskUsd: z.number().nullable(),
  measuredAt: z.iso.datetime(),
});
export type ModelEvalDto = z.infer<typeof ModelEvalDto>;

/** One provider's p50 speed and latency for a model, and when it was read. */
export const ProviderSpeedDto = z.object({
  provider: z.string(),
  tokensPerSecond: z.number().nullable(),
  latencyMs: z.number().nullable(),
  measuredAt: z.iso.datetime(),
});
export type ProviderSpeedDto = z.infer<typeof ProviderSpeedDto>;

/** The OpenRouter rows stored for one model, with why a section is empty when it is. */
export const ModelMeasuresDto = z.object({
  /** The OpenRouter ids the rows are joined from, sorted; empty when the model joins to none. */
  openRouterIds: z.array(z.string()),
  /** The provider the account's speed is measured on; null for a gateway or no account. */
  accountProvider: z.string().nullable(),
  evals: z.array(ModelEvalDto),
  /** Fastest p50 first. */
  speeds: z.array(ProviderSpeedDto),
  /** Why `evals` is empty, in the builder's words; null when it isn't. */
  evalsMissing: z.string().nullable(),
  /** Why `speeds` is empty; null when it isn't. */
  speedsMissing: z.string().nullable(),
});
export type ModelMeasuresDto = z.infer<typeof ModelMeasuresDto>;
