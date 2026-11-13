import { z } from 'zod';

/**
 * What 10db reads from `codex app-server`. Every schema names only the fields 10db uses and
 * accepts the rest, so a newer Codex adding fields does not break a session.
 */

export const InitializeResponse = z.looseObject({
  userAgent: z.string(),
  codexHome: z.string(),
});

const Account = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('chatgpt'),
    email: z.string().nullable().optional(),
    planType: z.string().optional(),
  }),
  z.looseObject({ type: z.literal('apiKey') }),
  z.looseObject({ type: z.literal('amazonBedrock') }),
  z.looseObject({ type: z.literal('gcp') }),
]);

export const AccountReadResponse = z.looseObject({
  account: Account.nullable(),
  requiresOpenaiAuth: z.boolean().optional(),
});

export const RateLimitWindow = z.looseObject({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullable().optional(),
  resetsAt: z.number().nullable().optional(),
});

export const RateLimitSnapshot = z.looseObject({
  limitId: z.string().nullable().optional(),
  limitName: z.string().nullable().optional(),
  primary: RateLimitWindow.nullable().optional(),
  secondary: RateLimitWindow.nullable().optional(),
});

export const RateLimitsReadResponse = z.looseObject({
  rateLimits: RateLimitSnapshot,
  rateLimitsByLimitId: z
    .record(z.string(), RateLimitSnapshot.nullable().optional())
    .nullable()
    .optional(),
  accountId: z.string().nullable().optional(),
});

export const RateLimitsUpdated = z.looseObject({ rateLimits: RateLimitSnapshot });

export const ModelListResponse = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      model: z.string(),
      hidden: z.boolean().optional(),
      isDefault: z.boolean().optional(),
      supportedReasoningEfforts: z.array(z.looseObject({ reasoningEffort: z.string() })).optional(),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});

export const ConfigReadResponse = z.looseObject({
  layers: z
    .array(
      z.looseObject({
        name: z.looseObject({ type: z.string().optional() }),
        disabledReason: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
});

export const HooksListResponse = z.looseObject({
  data: z.array(
    z.looseObject({
      cwd: z.string().optional(),
      hooks: z.array(
        z.looseObject({
          key: z.string(),
          eventName: z.string(),
          enabled: z.boolean(),
          currentHash: z.string(),
          trustStatus: z.string(),
          sourcePath: z.string().optional(),
          /** The timeout Codex runs the hook under, which its binary may clamp below the configured one. */
          timeoutSec: z.number().nullable().optional(),
        }),
      ),
    }),
  ),
});

/** `skills/extraRoots/set` answers an empty object (0.167.0's `SkillsExtraRootsSetResponse`). */
export const SkillsExtraRootsResponse = z.looseObject({});

export const ThreadResponse = z.looseObject({
  thread: z.looseObject({ id: z.string() }),
  model: z.string(),
  activePermissionProfile: z
    .looseObject({ id: z.string(), extends: z.string().nullable().optional() })
    .nullable()
    .optional(),
});

const TurnStatus = z.enum(['completed', 'interrupted', 'failed', 'inProgress']);

const Turn = z.looseObject({
  id: z.string(),
  status: TurnStatus,
  error: z
    .looseObject({
      message: z.string(),
      codexErrorInfo: z.unknown().optional(),
      additionalDetails: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export const TurnStartResponse = z.looseObject({ turn: Turn });

export const TurnCompleted = z.looseObject({ threadId: z.string(), turn: Turn });

/** `review/start` answers the turn the review runs in. */
export const ReviewStarted = z.looseObject({ turn: Turn });

/** `thread/compact/start` answers an empty object. */
export const CompactStarted = z.looseObject({});

const TokenBreakdown = z.looseObject({
  totalTokens: z.number(),
  inputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});

export const TokenUsageUpdated = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  tokenUsage: z.looseObject({
    total: TokenBreakdown,
    last: TokenBreakdown,
    modelContextWindow: z.number().nullable().optional(),
  }),
});

const Item = z.looseObject({ type: z.string(), id: z.string().optional() });

export const ItemCompleted = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  item: Item,
  completedAtMs: z.number().optional(),
});

export const ItemStarted = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  item: Item,
  startedAtMs: z.number(),
});

/** A piece of the agent message an item is writing. */
export const AgentMessageDelta = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  delta: z.string(),
});

/** A piece of a reasoning summary; each summary part has its own index. */
export const ReasoningSummaryDelta = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  delta: z.string(),
  summaryIndex: z.number(),
});

/** A piece of a running command's output. */
export const CommandOutputDelta = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  delta: z.string(),
});

/** The turn's plan, whole each time; a status is a string, so a new one still parses. */
export const TurnPlanUpdated = z.looseObject({
  threadId: z.string(),
  turnId: z.string(),
  plan: z.array(z.looseObject({ step: z.string(), status: z.string() })),
});

export const TurnStarted = z.looseObject({ threadId: z.string(), turn: Turn });

/**
 * The thread items the model writes as it answers: one of these after a user message in a turn shows
 * the model took the message in. A user message, a hook's prompt, a compaction and the review-mode
 * markers are written without the model.
 */
export const MODEL_ITEMS: ReadonlySet<string> = new Set([
  'agentMessage',
  'reasoning',
  'plan',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'functionCallOutput',
  'webSearch',
  'imageView',
  'imageGeneration',
  'subAgentActivity',
  'sleep',
]);

/**
 * One page of a thread's turns (`thread/turns/list` with `itemsView: "full"`), as far as 10db reads
 * it: each turn's status and its items in order, a user message item with the client uuid
 * `clientUserMessageId` set when it was sent.
 */
export const ThreadTurnsPage = z.looseObject({
  data: z.array(
    z.looseObject({
      // Read as text: a status this Codex does not name counts as a turn that did not complete.
      status: z.string(),
      /** Unix seconds; absent or null for a turn that has not ended. */
      completedAt: z.number().nullable().optional(),
      items: z.array(
        z.looseObject({ type: z.string(), clientId: z.string().nullable().optional() }),
      ),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});
