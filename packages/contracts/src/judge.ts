import { z } from 'zod';
import { AccountId, JudgeCallId, TaskId, WorkstreamId } from './ids';

/** A routine decision the daemon can ask a fast model to make. */
export const JudgeDecision = {
  ReviewSize: 'review_size',
  /** Shape (spec §9): has the builder said enough to propose? */
  ShapeReady: 'shape_ready',
  /** Shape: does this message state a decision or principle worth recording? */
  ShapeRecord: 'shape_record',
  /** Shape: is this a question only someone else can answer? */
  ShapeElsewhere: 'shape_elsewhere',
  /** Stakeholder questions: which of the project's category and topic routes a question belongs to. */
  QuestionRoute: 'question_route',
  /** Stakeholder questions: which option a conversation landed on. */
  ThreadAnswer: 'thread_answer',
  /** Stakeholder questions: which open question a top-level reply answers. */
  ReplyMatch: 'reply_match',
  /** Stakeholder questions: whether a reply approves the open proposal. */
  ApprovalRead: 'approval_read',
} as const;
export type JudgeDecision = (typeof JudgeDecision)[keyof typeof JudgeDecision];

/** What came of a judge call: the decision's own outcomes, and the fallback that made today's rule apply. */
export const JudgeOutcome = {
  Acted: 'acted',
  BelowFloor: 'below_floor',
  FallbackOff: 'fallback_off',
  FallbackNoKey: 'fallback_no_key',
  FallbackTimeout: 'fallback_timeout',
  FallbackError: 'fallback_error',
  /** A cancel or a shutdown cut the call short: there is no answer, and the call did not fail. */
  Stopped: 'stopped',
  /** A Shape decision in shadow (spec §9): the answer was logged to be scored, and nothing was shown. */
  Shadow: 'shadow',
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

const DEFAULT_DECISION: JudgeDecisionConfig = {
  enabled: true,
  model: 'typesafe/jev-1.13',
  floor: 0.8,
};

/** Later decisions: a config stored before them reads with their defaults. */
const shapeDecision = (): z.ZodDefault<typeof JudgeDecisionConfig> =>
  JudgeDecisionConfig.default({ ...DEFAULT_DECISION });

export const JudgeConfig = z.object({
  enabled: z.boolean(),
  /** The OpenRouter account decisions run on; null until the builder picks one. */
  accountId: AccountId.nullable().default(null),
  decisions: z.object({
    [JudgeDecision.ReviewSize]: JudgeDecisionConfig,
    [JudgeDecision.ShapeReady]: shapeDecision(),
    [JudgeDecision.ShapeRecord]: shapeDecision(),
    [JudgeDecision.ShapeElsewhere]: shapeDecision(),
    [JudgeDecision.QuestionRoute]: shapeDecision(),
    [JudgeDecision.ThreadAnswer]: shapeDecision(),
    [JudgeDecision.ReplyMatch]: shapeDecision(),
    [JudgeDecision.ApprovalRead]: shapeDecision(),
  }),
});
export type JudgeConfig = z.infer<typeof JudgeConfig>;

export const DEFAULT_JUDGE_CONFIG: JudgeConfig = {
  enabled: true,
  accountId: null,
  decisions: {
    [JudgeDecision.ReviewSize]: { ...DEFAULT_DECISION },
    [JudgeDecision.ShapeReady]: { ...DEFAULT_DECISION },
    [JudgeDecision.ShapeRecord]: { ...DEFAULT_DECISION },
    [JudgeDecision.ShapeElsewhere]: { ...DEFAULT_DECISION },
    [JudgeDecision.QuestionRoute]: { ...DEFAULT_DECISION },
    [JudgeDecision.ThreadAnswer]: { ...DEFAULT_DECISION },
    [JudgeDecision.ReplyMatch]: { ...DEFAULT_DECISION },
    [JudgeDecision.ApprovalRead]: { ...DEFAULT_DECISION },
  },
};

export const JudgeStatusDto = z.object({
  config: JudgeConfig,
  /** The account decisions run on, or null when none is picked or the one picked no longer resolves. */
  account: z
    .object({
      id: AccountId,
      label: z.string(),
      /** Whether the key is usable: `secretState` is `set`. */
      secretSet: z.boolean(),
      /** Whether the account's key is recorded, missing from the Keychain, or changed since it was recorded. */
      secretState: z.enum(['set', 'missing', 'changed']),
    })
    .nullable(),
  /** The daemon was started with `TENDB_JUDGE=off`: it never reads the key or calls OpenRouter. */
  off: z.boolean(),
});
export type JudgeStatusDto = z.infer<typeof JudgeStatusDto>;

const JudgeDecisionConfigPatch = JudgeDecisionConfig.partial().strict();

/** `PATCH /judge`: any subset of the config. */
export const JudgeConfigPatch = z
  .object({
    enabled: z.boolean(),
    accountId: AccountId.nullable(),
    decisions: z
      .object({
        [JudgeDecision.ReviewSize]: JudgeDecisionConfigPatch,
        [JudgeDecision.ShapeReady]: JudgeDecisionConfigPatch,
        [JudgeDecision.ShapeRecord]: JudgeDecisionConfigPatch,
        [JudgeDecision.ShapeElsewhere]: JudgeDecisionConfigPatch,
        [JudgeDecision.QuestionRoute]: JudgeDecisionConfigPatch,
        [JudgeDecision.ThreadAnswer]: JudgeDecisionConfigPatch,
        [JudgeDecision.ReplyMatch]: JudgeDecisionConfigPatch,
        [JudgeDecision.ApprovalRead]: JudgeDecisionConfigPatch,
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();
export type JudgeConfigPatch = z.infer<typeof JudgeConfigPatch>;

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

/** `GET /judge/calls/page`: 1 to 100 calls (a larger number is read as 100, a non-number as 20), newest first. */
export const JudgeCallsPageQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .catch(20)
    .transform((n) => Math.min(n, 100)),
  offset: z.coerce.number().int().min(0).default(0),
  decision: z.enum(JudgeDecision).optional(),
  outcome: z.enum(JudgeOutcome).optional(),
});
export type JudgeCallsPageQuery = z.infer<typeof JudgeCallsPageQuery>;

export const JudgeCallsPageDto = z.object({
  calls: z.array(JudgeCallDto),
  /** Every call the filters match, not just this page. */
  total: z.int().min(0),
});
export type JudgeCallsPageDto = z.infer<typeof JudgeCallsPageDto>;
