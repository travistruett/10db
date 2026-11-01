import { z } from 'zod';
import { SECRET_CHARACTERS } from './accounts';
import { JudgeCallId, TaskId, WorkstreamId } from './ids';

/** A routine decision the daemon can ask a fast model to make. */
export const JudgeDecision = { ReviewSize: 'review_size' } as const;
export type JudgeDecision = (typeof JudgeDecision)[keyof typeof JudgeDecision];

/** What came of a judge call: the decision's own outcomes, and the fallback that made today's rule apply. */
export const JudgeOutcome = {
  Acted: 'acted',
  BelowFloor: 'below_floor',
  FallbackOff: 'fallback_off',
  FallbackNoKey: 'fallback_no_key',
  FallbackTimeout: 'fallback_timeout',
  FallbackError: 'fallback_error',
} as const;
export type JudgeOutcome = (typeof JudgeOutcome)[keyof typeof JudgeOutcome];

export const JudgeDecisionConfig = z.object({
  enabled: z.boolean(),
  /** An OpenRouter model id, e.g. `typesafe/jev-1.13`. */
  model: z.string().trim().min(1),
  /** The confidence an answer must reach before 10db acts on it. */
  floor: z.number().min(0).max(1),
});
export type JudgeDecisionConfig = z.infer<typeof JudgeDecisionConfig>;

export const JudgeConfig = z.object({
  enabled: z.boolean(),
  decisions: z.object({ [JudgeDecision.ReviewSize]: JudgeDecisionConfig }),
});
export type JudgeConfig = z.infer<typeof JudgeConfig>;

export const DEFAULT_JUDGE_CONFIG: JudgeConfig = {
  enabled: true,
  decisions: {
    [JudgeDecision.ReviewSize]: { enabled: true, model: 'typesafe/jev-1.13', floor: 0.8 },
  },
};

export const JudgeStatusDto = z.object({
  config: JudgeConfig,
  /** Whether a key is in the Keychain; never the key. */
  keySet: z.boolean(),
  /** The daemon was started with `TENDB_JUDGE=off`: it never reads the key or calls OpenRouter. */
  off: z.boolean(),
});
export type JudgeStatusDto = z.infer<typeof JudgeStatusDto>;

const JudgeDecisionConfigPatch = JudgeDecisionConfig.partial().strict();

/** `PATCH /judge`: any subset of the config. */
export const JudgeConfigPatch = z
  .object({
    enabled: z.boolean(),
    decisions: z
      .object({ [JudgeDecision.ReviewSize]: JudgeDecisionConfigPatch })
      .partial()
      .strict(),
  })
  .partial()
  .strict();
export type JudgeConfigPatch = z.infer<typeof JudgeConfigPatch>;

/** `PUT /judge/key`. The key reaches the Keychain on `security`'s standard input, so it is printable ASCII. */
export const JudgeKeyInput = z.strictObject({
  key: z
    .string()
    .trim()
    .min(1)
    .max(8192)
    .regex(SECRET_CHARACTERS, 'printable ASCII with no spaces, double quotes or backslashes'),
});
export type JudgeKeyInput = z.infer<typeof JudgeKeyInput>;

export const JudgeTestResultDto = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    model: z.string(),
    latencyMs: z.number(),
    costUsd: z.number().nullable(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type JudgeTestResultDto = z.infer<typeof JudgeTestResultDto>;

export const JudgeCallDto = z.object({
  id: JudgeCallId,
  decision: z.enum(JudgeDecision),
  model: z.string(),
  /** The question sent, not the state: the state is task text and a diff. */
  question: z.string(),
  answer: z.string().nullable(),
  confidence: z.number().nullable(),
  outcome: z.enum(JudgeOutcome),
  latencyMs: z.number().nullable(),
  costUsd: z.number().nullable(),
  workstreamId: WorkstreamId.nullable(),
  taskId: TaskId.nullable(),
  createdAt: z.iso.datetime(),
});
export type JudgeCallDto = z.infer<typeof JudgeCallDto>;
