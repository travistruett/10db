import { MAX_STEP_SUMMARY, type ToolCallView } from '@10db/contracts';
import { z } from 'zod';
import { contextEvent } from './context-event';
import {
  AgentMessageDelta,
  CommandOutputDelta,
  ItemCompleted,
  ItemStarted,
  MODEL_ITEMS,
  RateLimitsUpdated,
  ReasoningSummaryDelta,
  TokenUsageUpdated,
  TurnCompleted,
  TurnPlanUpdated,
  TurnStarted,
  type RateLimitSnapshot,
} from './codex-protocol';
import { codexPlanSteps, codexToolCalls, withCommandOutput } from './codex-tool-calls';
import type { SessionEvent } from './types';

export type RateLimitEvent = Extract<SessionEvent, { type: 'rate_limit' }>;

type RateLimitSnapshotValue = z.infer<typeof RateLimitSnapshot>;

/** What a session keeps between notifications: the active turn, its last message and the session's tokens. */
export interface CodexTurnState {
  /** The active turn's ID, from `turn/started` to `turn/completed`; null between turns. */
  turnId: string | null;
  /** What the model wrote in the active turn's last message. */
  lastText: string;
  /**
   * The thread's token total as of the first turn's start: 0 on a fresh thread, and on a resume what
   * earlier sessions spent, which Codex replays outside a turn.
   */
  baseline: TokenCounts;
  /** The thread's latest token total; this session's tokens are this minus the baseline. */
  latest: TokenCounts;
  /** Whether a turn has started, which fixes the baseline. */
  baselineFixed: boolean;
  /** The last rate-limit window seen, which a hard limit takes its reset from. */
  lastLimit: RateLimitEvent | null;
  /**
   * The client uuids of the user messages the active turn recorded that no model item has followed
   * yet: not taken until one does, or the turn completes.
   */
  recorded: string[];
  /** Each agent message's length so far, which the next delta's offset is. */
  texts: Map<string, number>;
  /** Each reasoning item's length so far and the summary part it is in. */
  reasoning: Map<string, { length: number; summaryIndex: number }>;
  /** The calls of each tool item that started, until it completes. */
  calls: Map<string, readonly ToolCallView[]>;
}

interface TokenCounts {
  input: number;
  cached: number;
  output: number;
}

export function createTurnState(): CodexTurnState {
  return {
    turnId: null,
    lastText: '',
    baseline: { input: 0, cached: 0, output: 0 },
    latest: { input: 0, cached: 0, output: 0 },
    baselineFixed: false,
    lastLimit: null,
    recorded: [],
    texts: new Map(),
    reasoning: new Map(),
    calls: new Map(),
  };
}

const SUMMARY_CHARS = 200;
const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10_080;

/** Which limit a window is, from its length. */
export function limitTypeOf(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (minutes === FIVE_HOUR_MINUTES) return 'five_hour';
  if (minutes === SEVEN_DAY_MINUTES) return 'seven_day';
  return `${String(minutes)}_minutes`;
}

/** One `rate_limit` per window the snapshot holds, the primary first. */
export function rateLimitEvents(snapshot: RateLimitSnapshotValue): readonly RateLimitEvent[] {
  const windows = [snapshot.primary, snapshot.secondary];
  return windows.flatMap((window) =>
    window === null || window === undefined
      ? []
      : [
          {
            type: 'rate_limit' as const,
            status: 'allowed' as const,
            utilization: window.usedPercent / 100,
            resetsAt:
              typeof window.resetsAt === 'number' ? new Date(window.resetsAt * 1_000) : null,
            limitType: limitTypeOf(window.windowDurationMins ?? null),
          },
        ],
  );
}

const MessageItem = z.looseObject({
  type: z.literal('agentMessage'),
  id: z.string().min(1).optional(),
  text: z.string(),
});
/** The output a command item finished with; null when Codex kept none, and the streamed tail stands. */
const CommandOutput = z.looseObject({
  type: z.literal('commandExecution'),
  aggregatedOutput: z.string().nullable().optional(),
});
/**
 * A user message the thread recorded in a turn, under the client uuid it was sent with
 * (`clientUserMessageId`). It is taken once the model answers after it, as Claude Code's first
 * assistant message stamps `user_message_uuids`: the evidence is consumption, not receipt.
 */
const UserMessageItem = z.looseObject({ type: z.literal('userMessage'), clientId: z.string() });

/** The `consumed` event for what the turn recorded and the model has now answered, clearing it. */
function takenNow(state: CodexTurnState): SessionEvent[] {
  if (state.recorded.length === 0) return [];
  const uuids = state.recorded;
  state.recorded = [];
  return [{ type: 'consumed', uuids }];
}

/** A tool item's final calls: its id kept, its start the one first seen, its streamed output kept when Codex kept none. */
function finalCalls(
  item: z.infer<typeof ItemCompleted>['item'],
  completedAtMs: number | null,
  state: CodexTurnState,
): readonly ToolCallView[] {
  const id = item.id ?? '';
  const seen = id === '' ? undefined : state.calls.get(id);
  state.calls.delete(id);
  const recordedStart = z.number().safeParse(Reflect.get(item, 'startedAtMs'));
  const startedAtMs =
    seen?.[0] !== undefined
      ? Date.parse(seen[0].startedAt)
      : recordedStart.success
        ? recordedStart.data
        : (completedAtMs ?? 0);
  const finals = codexToolCalls(item, {
    startedAtMs,
    completedAtMs: completedAtMs ?? startedAtMs,
  });
  const output = CommandOutput.safeParse(item);
  const keptNone = output.success && (output.data.aggregatedOutput ?? null) === null;
  return finals.map((call, index) => {
    const streamed = seen?.[index];
    return keptNone && call.kind === 'command' && streamed?.kind === 'command'
      ? { ...call, outputTail: streamed.outputTail, outputBytes: streamed.outputBytes }
      : call;
  });
}

/** The method each schema below reads; a method not here maps to nothing. */
const SHAPES = {
  'turn/started': TurnStarted,
  'turn/completed': TurnCompleted,
  'item/started': ItemStarted,
  'item/completed': ItemCompleted,
  'item/agentMessage/delta': AgentMessageDelta,
  'item/reasoning/summaryTextDelta': ReasoningSummaryDelta,
  'item/commandExecution/outputDelta': CommandOutputDelta,
  'turn/plan/updated': TurnPlanUpdated,
  'thread/tokenUsage/updated': TokenUsageUpdated,
  'account/rateLimits/updated': RateLimitsUpdated,
} as const;

type ReadMethod = keyof typeof SHAPES;

const isReadMethod = (method: string): method is ReadMethod => Object.hasOwn(SHAPES, method);

/** False for a method 10db reads whose params are not the shape it expects; true for any other. */
export function hasKnownShape(n: { method: string; params: unknown }): boolean {
  return !isReadMethod(n.method) || SHAPES[n.method].safeParse(n.params).success;
}

/**
 * Maps one notification to session events, updating `state`. A method 10db does not read, or one
 * whose params are not the shape it expects, maps to nothing; the caller reports the second.
 * A failed turn that names a limit, a sign-out or a refused model is the caller's to end the session
 * on before it maps the rest.
 */
export function mapCodexNotification(
  n: { method: string; params: unknown },
  state: CodexTurnState,
): readonly SessionEvent[] {
  if (!isReadMethod(n.method)) return [];
  switch (n.method) {
    case 'turn/started': {
      const parsed = TurnStarted.safeParse(n.params);
      if (!parsed.success) return [];
      state.turnId = parsed.data.turn.id;
      state.lastText = '';
      state.baselineFixed = true;
      state.recorded = [];
      state.texts.clear();
      state.reasoning.clear();
      state.calls.clear();
      return [];
    }
    case 'item/started': {
      const parsed = ItemStarted.safeParse(n.params);
      if (!parsed.success) return [];
      const { item, startedAtMs } = parsed.data;
      if (item.id === undefined || item.id === '') return [];
      const calls = codexToolCalls(item, { startedAtMs, completedAtMs: null });
      if (calls.length === 0) return [];
      state.calls.set(item.id, calls);
      return calls.map((call) => ({ type: 'tool_call', call }));
    }
    case 'item/agentMessage/delta': {
      const parsed = AgentMessageDelta.safeParse(n.params);
      if (!parsed.success || parsed.data.delta === '') return [];
      const { itemId, delta } = parsed.data;
      const offset = state.texts.get(itemId) ?? 0;
      state.texts.set(itemId, offset + delta.length);
      return [{ type: 'text_delta', itemId, offset, text: delta }];
    }
    case 'item/reasoning/summaryTextDelta': {
      const parsed = ReasoningSummaryDelta.safeParse(n.params);
      if (!parsed.success || parsed.data.delta === '') return [];
      const { itemId, delta, summaryIndex } = parsed.data;
      const seen = state.reasoning.get(itemId) ?? { length: 0, summaryIndex };
      // A new summary part starts a paragraph, so the item's text stays one sequence (call 13).
      const text = summaryIndex > seen.summaryIndex && seen.length > 0 ? `\n\n${delta}` : delta;
      state.reasoning.set(itemId, {
        length: seen.length + text.length,
        summaryIndex: Math.max(seen.summaryIndex, summaryIndex),
      });
      return [{ type: 'reasoning_delta', itemId, offset: seen.length, text }];
    }
    case 'item/commandExecution/outputDelta': {
      const parsed = CommandOutputDelta.safeParse(n.params);
      if (!parsed.success) return [];
      const { itemId, delta } = parsed.data;
      const calls = state.calls.get(itemId);
      if (calls === undefined) return [];
      const next = calls.map((call) => withCommandOutput(call, delta));
      state.calls.set(itemId, next);
      return next.flatMap((call) =>
        call.kind === 'command' ? [{ type: 'tool_call', call, appended: delta } as const] : [],
      );
    }
    case 'turn/plan/updated': {
      const parsed = TurnPlanUpdated.safeParse(n.params);
      if (!parsed.success) return [];
      return [{ type: 'plan_update', steps: codexPlanSteps(parsed.data.plan) }];
    }
    case 'turn/completed': {
      const parsed = TurnCompleted.safeParse(n.params);
      if (!parsed.success) return [];
      const text = state.lastText.trim().slice(0, MAX_STEP_SUMMARY);
      const cached = state.latest.cached - state.baseline.cached;
      const completed = parsed.data.turn.status === 'completed';
      const result = completed ? {} : { result: 'error' as const };
      // A turn that failed or was stopped before the model answered took none of what it recorded.
      const taken = completed ? takenNow(state) : [];
      state.recorded = [];
      state.turnId = null;
      state.lastText = '';
      return [
        ...taken,
        {
          type: 'turn_complete',
          ...result,
          ...(text === '' ? {} : { text }),
          inputTokens: state.latest.input - state.baseline.input - cached,
          outputTokens: state.latest.output - state.baseline.output,
          cachedTokens: cached,
          costUsd: 0,
        },
      ];
    }
    case 'item/completed': {
      const parsed = ItemCompleted.safeParse(n.params);
      if (!parsed.success) return [];
      const message = MessageItem.safeParse(parsed.data.item);
      if (message.success) {
        state.lastText = message.data.text;
        if (message.data.id !== undefined) state.texts.delete(message.data.id);
      }
      // Codex 0.154 reports a compaction only as this item, never as `thread/compacted`.
      if (parsed.data.item.type === 'contextCompaction')
        return [{ type: 'compacted', trigger: 'auto' }];
      const recorded = UserMessageItem.safeParse(parsed.data.item);
      if (recorded.success) {
        state.recorded.push(recorded.data.clientId);
        return [];
      }
      const taken = MODEL_ITEMS.has(parsed.data.item.type) ? takenNow(state) : [];
      if (message.success)
        return [
          ...taken,
          {
            type: 'activity',
            kind: 'text',
            summary: message.data.text.slice(0, SUMMARY_CHARS),
          },
          ...(message.data.id === undefined
            ? []
            : [{ type: 'message' as const, itemId: message.data.id, text: message.data.text }]),
        ];
      const calls = finalCalls(parsed.data.item, parsed.data.completedAtMs ?? null, state);
      return [...taken, ...calls.map((call) => ({ type: 'tool_call' as const, call }))];
    }
    case 'thread/tokenUsage/updated': {
      const parsed = TokenUsageUpdated.safeParse(n.params);
      if (!parsed.success) return [];
      const { last, total, modelContextWindow } = parsed.data.tokenUsage;
      // `last` repeats and estimates around compaction, so only the thread's `total` is counted.
      state.latest = {
        input: total.inputTokens ?? 0,
        cached: total.cachedInputTokens ?? 0,
        output: total.outputTokens ?? 0,
      };
      if (!state.baselineFixed) state.baseline = state.latest;
      return [
        contextEvent({
          totalTokens: last.totalTokens,
          maxTokens: modelContextWindow ?? 0,
          percentage: 0,
        }),
      ];
    }
    case 'account/rateLimits/updated': {
      const parsed = RateLimitsUpdated.safeParse(n.params);
      if (!parsed.success) return [];
      const events = rateLimitEvents(parsed.data.rateLimits);
      state.lastLimit = events.at(-1) ?? state.lastLimit;
      return events;
    }
  }
}
