import { z } from 'zod';
import { ModelStatus, ModelTier } from './catalogue';
import { ModelProfileId } from './ids';
import { Effort, ProfileSource, Provider } from './states';

/** The Artificial Analysis Intelligence Index, 0–100, that every role routes on; null when nobody has measured it. */
export const ProfileScores = z.object({
  intelligence: z.number().min(0).max(100).nullable(),
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
  /** What the maker publishes about the model; all null until a catalogue describes it. */
  maker: z.string().min(1).nullable(),
  family: z.string().min(1).nullable(),
  tier: z.enum(ModelTier).nullable(),
  status: z.enum(ModelStatus).nullable(),
  inputPrice: z.number().min(0).nullable(),
  outputPrice: z.number().min(0).nullable(),
  /** The maker's release date, as a calendar day. */
  releaseDate: z.string().min(1).nullable(),
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
