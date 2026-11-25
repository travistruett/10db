import { z } from 'zod';
import { AccountId, JudgeCallId, TaskId, WorkstreamId } from './ids';

/** How long a decision waits for a model before today's rule applies. */
export const JUDGE_TIMEOUT_MS = 4_000;

/** A routine decision the daemon can ask a fast model to make. */
export const JudgeDecision = {
  /**
   * Retired: a rigor decides up front whether a review runs, so this is never asked. Its logged calls still
   * parse and show, and a stored config that holds it reads with the key dropped.
   */
  ReviewSize: 'review_size',
  /**
   * Retired: nothing asks it, since a session proposes as things are decided. Its logged calls still parse
   * and show, and a stored config that holds it reads with the key dropped.
   */
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
  /** Stakeholder questions: whether a reply answers, asks 10db, asks the builder, or is chatter. */
  ReplyKind: 'reply_kind',
  /** Sizing: how much process a task needs, one of the four rigors. */
  TaskRigor: 'task_rigor',
  /** Sizing: whether a task touches one kind of work, asked once per kind. */
  TaskKinds: 'task_kinds',
  /** Trust: does a tool call cross one of the four limits, where Claude Code's auto mode doesn't judge it? */
  CrossesLimit: 'crosses_limit',
  /** Trust: the same questions, asked of a stronger model, for a call the limits judge left between yes and no. */
  CrossesLimitSecond: 'crosses_limit_second',
  /** Delivery: does a test a step added earn its place, or duplicate or fold into one that exists? */
  TestValue: 'test_value',
  /** Acceptance: is each acceptance criterion of a finished task met by its change? One yes/no question per criterion. */
  Acceptance: 'acceptance',
  /** Acceptance: the same questions, asked of a stronger model, for a criterion the first call left unclear or not met. */
  AcceptanceSecond: 'acceptance_second',
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
  /** The builder changed the value the judge set, so the call is counted as wrong. */
  Overridden: 'overridden',
} as const;
export type JudgeOutcome = (typeof JudgeOutcome)[keyof typeof JudgeOutcome];

export const JudgeDecisionConfig = z.object({
  enabled: z.boolean(),
  /** A model the Decisions account offers: an OpenRouter id such as `typesafe/jev-1.13`, or the Anthropic or Bedrock id its list holds. */
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

/**
 * The limits decisions read their floor both ways: a limit at or above it skips the call, and every limit under
 * one minus it runs the call.
 */
const LIMITS_FLOOR = 0.7;

/**
 * The model the second opinion on limits starts on for an OpenRouter account: the one a replay of real lane calls
 * and dangerous controls showed settles them (`decisions/2026-11-24-the-limits-judge-asks-a-question-per-limit.md`).
 * A safety judge's default is a model shown to work, not whatever a tier resolves to on the account.
 */
export const OPENROUTER_SECOND_OPINION_MODEL = 'anthropic/claude-haiku-5.5';

/** The model the acceptance second call starts on for an OpenRouter account. */
export const OPENROUTER_ACCEPTANCE_SECOND_MODEL = 'anthropic/claude-sonnet-5.5';

const SECOND_OPINION_DECISION: JudgeDecisionConfig = {
  enabled: true,
  model: OPENROUTER_SECOND_OPINION_MODEL,
  floor: LIMITS_FLOOR,
};

/** Acceptance ships switched off: the builder turns it on in Settings once a replay has passed. */
const ACCEPTANCE_DECISION: JudgeDecisionConfig = { ...DEFAULT_DECISION, enabled: false };
const ACCEPTANCE_SECOND_DECISION: JudgeDecisionConfig = {
  enabled: false,
  model: OPENROUTER_ACCEPTANCE_SECOND_MODEL,
  floor: 0.7,
};

export const JudgeConfig = z.object({
  enabled: z.boolean(),
  /** The OpenRouter, Anthropic API key or Bedrock account decisions run on; null until the builder picks one. */
  accountId: AccountId.nullable().default(null),
  decisions: z.object({
    [JudgeDecision.ShapeRecord]: shapeDecision(),
    [JudgeDecision.ShapeElsewhere]: shapeDecision(),
    [JudgeDecision.QuestionRoute]: shapeDecision(),
    [JudgeDecision.ThreadAnswer]: shapeDecision(),
    [JudgeDecision.ReplyMatch]: shapeDecision(),
    [JudgeDecision.ApprovalRead]: shapeDecision(),
    [JudgeDecision.ReplyKind]: shapeDecision(),
    [JudgeDecision.TaskRigor]: shapeDecision(),
    [JudgeDecision.TaskKinds]: shapeDecision(),
    [JudgeDecision.CrossesLimit]: shapeDecision(),
    [JudgeDecision.CrossesLimitSecond]: JudgeDecisionConfig.default({ ...SECOND_OPINION_DECISION }),
    [JudgeDecision.TestValue]: shapeDecision(),
    [JudgeDecision.Acceptance]: JudgeDecisionConfig.default({ ...ACCEPTANCE_DECISION }),
    [JudgeDecision.AcceptanceSecond]: JudgeDecisionConfig.default({
      ...ACCEPTANCE_SECOND_DECISION,
    }),
  }),
});
export type JudgeConfig = z.infer<typeof JudgeConfig>;

/** A decision 10db still asks a model, and so still configures: every one but the retired `review_size` and `shape_ready`. */
export type AskedDecision = keyof JudgeConfig['decisions'];

export const DEFAULT_JUDGE_CONFIG: JudgeConfig = {
  enabled: true,
  accountId: null,
  decisions: {
    [JudgeDecision.ShapeRecord]: { ...DEFAULT_DECISION },
    [JudgeDecision.ShapeElsewhere]: { ...DEFAULT_DECISION },
    [JudgeDecision.QuestionRoute]: { ...DEFAULT_DECISION },
    [JudgeDecision.ThreadAnswer]: { ...DEFAULT_DECISION },
    [JudgeDecision.ReplyMatch]: { ...DEFAULT_DECISION },
    [JudgeDecision.ApprovalRead]: { ...DEFAULT_DECISION },
    [JudgeDecision.ReplyKind]: { ...DEFAULT_DECISION },
    [JudgeDecision.TaskRigor]: { ...DEFAULT_DECISION },
    [JudgeDecision.TaskKinds]: { ...DEFAULT_DECISION },
    [JudgeDecision.CrossesLimit]: { ...DEFAULT_DECISION, floor: LIMITS_FLOOR },
    [JudgeDecision.CrossesLimitSecond]: { ...SECOND_OPINION_DECISION },
    [JudgeDecision.TestValue]: { ...DEFAULT_DECISION },
    [JudgeDecision.Acceptance]: { ...ACCEPTANCE_DECISION },
    [JudgeDecision.AcceptanceSecond]: { ...ACCEPTANCE_SECOND_DECISION },
  },
};

/** Whether 10db still asks this decision, so it has a config; a retired one only labels logged calls. */
export function isAskedDecision(decision: JudgeDecision): decision is AskedDecision {
  return decision in DEFAULT_JUDGE_CONFIG.decisions;
}

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
      /** Why the account's latest decision fell back to rules (a rejected key, an expired profile); absent when it answered. */
      fallback: z.string().nullable().optional(),
      /** The AWS profile a Bedrock account signs with; it keeps no key. Absent for any other account. */
      awsProfile: z.string().nullable().optional(),
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
        [JudgeDecision.ShapeRecord]: JudgeDecisionConfigPatch,
        [JudgeDecision.ShapeElsewhere]: JudgeDecisionConfigPatch,
        [JudgeDecision.QuestionRoute]: JudgeDecisionConfigPatch,
        [JudgeDecision.ThreadAnswer]: JudgeDecisionConfigPatch,
        [JudgeDecision.ReplyMatch]: JudgeDecisionConfigPatch,
        [JudgeDecision.ApprovalRead]: JudgeDecisionConfigPatch,
        [JudgeDecision.ReplyKind]: JudgeDecisionConfigPatch,
        [JudgeDecision.TaskRigor]: JudgeDecisionConfigPatch,
        [JudgeDecision.TaskKinds]: JudgeDecisionConfigPatch,
        [JudgeDecision.CrossesLimit]: JudgeDecisionConfigPatch,
        [JudgeDecision.CrossesLimitSecond]: JudgeDecisionConfigPatch,
        [JudgeDecision.TestValue]: JudgeDecisionConfigPatch,
        [JudgeDecision.Acceptance]: JudgeDecisionConfigPatch,
        [JudgeDecision.AcceptanceSecond]: JudgeDecisionConfigPatch,
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
  /** Each question's probability of yes, for a decision that asks several yes/no questions; null for a choice. */
  probabilities: z.record(z.string(), z.number()).nullable(),
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
