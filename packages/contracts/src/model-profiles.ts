import { z } from 'zod';
import { ModelProfileId } from './ids';
import { Effort, ProfileSource, Provider } from './states';

/** One Artificial Analysis index per score kind, 0–100; null when nobody has measured it. */
export const ProfileScores = z.object({
  intelligence: z.number().min(0).max(100).nullable(),
  coding: z.number().min(0).max(100).nullable(),
  agentic: z.number().min(0).max(100).nullable(),
});
export type ProfileScores = z.infer<typeof ProfileScores>;

/** One point on the model-and-effort frontier (spec §4 `model_profiles`). */
export const ModelProfileDto = z.object({
  id: ModelProfileId,
  provider: z.enum(Provider),
  model: z.string().min(1),
  effort: z.enum(Effort),
  /** The AA entry this profile is measured by; null for one AA doesn't list. */
  aaSlug: z.string().min(1).nullable(),
  scores: ProfileScores,
  costPerTaskUsd: z.number().nonnegative().nullable(),
  outputTokensPerSecond: z.number().nonnegative().nullable(),
  source: z.enum(ProfileSource),
  /** The AA Intelligence Index version the scores were measured on. */
  indexVersion: z.string().nullable(),
  measuredAt: z.iso.datetime().nullable(),
  enabled: z.boolean(),
  /** Observed: finished steps, steps that passed first time, and escalations away from this profile. */
  stepsRun: z.int().min(0),
  firstPassSteps: z.int().min(0),
  escalations: z.int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ModelProfileDto = z.infer<typeof ModelProfileDto>;

/** Editing scores or cost makes the profile `manual` unless the patch names a source. */
export const ModelProfilePatch = z
  .object({
    enabled: z.boolean(),
    aaSlug: z.string().min(1).nullable(),
    scores: ProfileScores,
    costPerTaskUsd: z.number().nonnegative().nullable(),
    source: z.enum(ProfileSource),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' });
export type ModelProfilePatch = z.infer<typeof ModelProfilePatch>;
