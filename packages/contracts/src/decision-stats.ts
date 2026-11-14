import { z } from 'zod';
import { JudgeDecision } from './judge';

/** What one decision's judge calls came to since a time. */
export const DecisionStatsDto = z.object({
  decision: z.enum(JudgeDecision),
  calls: z.int().min(0),
  acted: z.int().min(0),
  belowFloor: z.int().min(0),
  shadow: z.int().min(0),
  stopped: z.int().min(0),
  /** Calls that fell back to today's rule, by why. */
  fallbacks: z.object({
    off: z.int().min(0),
    no_key: z.int().min(0),
    timeout: z.int().min(0),
    error: z.int().min(0),
  }),
  costUsd: z.number().min(0),
  medianLatencyMs: z.number().nullable(),
  /** The models that answered, with the confidence of each answer, oldest call first. */
  answers: z.array(z.object({ model: z.string(), confidence: z.number() })),
});
export type DecisionStatsDto = z.infer<typeof DecisionStatsDto>;

/** `GET /judge/decisions`: one entry per decision, counted from `since`. */
export const DecisionStatsListDto = z.object({
  since: z.iso.datetime(),
  decisions: z.array(DecisionStatsDto),
});
export type DecisionStatsListDto = z.infer<typeof DecisionStatsListDto>;
