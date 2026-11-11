import { MAX_STEP_SUMMARY } from '@10db/contracts';
import { z } from 'zod';
import { contextEvent } from './context-event';
import {
  ItemCompleted,
  RateLimitsUpdated,
  TokenUsageUpdated,
  TurnCompleted,
  TurnStarted,
  type RateLimitSnapshot,
} from './codex-protocol';
import type { SessionEvent } from './types';
import { codexCommandTarget, codexPatchTarget } from './tool-target';

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

const CommandItem = z.looseObject({ type: z.literal('commandExecution'), command: z.string() });
const PatchItem = z.looseObject({
  type: z.literal('fileChange'),
  changes: z.array(z.looseObject({ path: z.string() })),
});
const McpItem = z.looseObject({
  type: z.literal('mcpToolCall'),
  server: z.string(),
  tool: z.string(),
});
const MessageItem = z.looseObject({ type: z.literal('agentMessage'), text: z.string() });
/**
 * A user message the thread recorded in a turn, under the client uuid it was sent with
 * (`clientUserMessageId`): the evidence a turn took it, as Claude Code's `user_message_uuids` is.
 */
const UserMessageItem = z.looseObject({ type: z.literal('userMessage'), clientId: z.string() });

/** The activity an item stands for, or null for one 10db does not show. */
function itemActivity(item: z.infer<typeof ItemCompleted>['item']): SessionEvent | null {
  const command = CommandItem.safeParse(item);
  if (command.success)
    return {
      type: 'activity',
      kind: 'tool',
      summary: command.data.command.slice(0, SUMMARY_CHARS),
      tool: codexCommandTarget(command.data.command),
    };
  const patch = PatchItem.safeParse(item);
  if (patch.success)
    return {
      type: 'activity',
      kind: 'tool',
      summary: (patch.data.changes[0]?.path ?? 'apply_patch').slice(0, SUMMARY_CHARS),
      tool: codexPatchTarget(patch.data.changes.map((c) => c.path)),
    };
  const mcp = McpItem.safeParse(item);
  if (mcp.success)
    return {
      type: 'activity',
      kind: 'tool',
      summary: `${mcp.data.server}.${mcp.data.tool}`.slice(0, SUMMARY_CHARS),
      tool: { name: `${mcp.data.server}.${mcp.data.tool}`, target: null, written: [] },
    };
  const message = MessageItem.safeParse(item);
  if (message.success)
    return { type: 'activity', kind: 'text', summary: message.data.text.slice(0, SUMMARY_CHARS) };
  return null;
}

/** The method each schema below reads; a method not here maps to nothing. */
const SHAPES = {
  'turn/started': TurnStarted,
  'turn/completed': TurnCompleted,
  'item/completed': ItemCompleted,
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
      return [];
    }
    case 'turn/completed': {
      const parsed = TurnCompleted.safeParse(n.params);
      if (!parsed.success) return [];
      const text = state.lastText.trim().slice(0, MAX_STEP_SUMMARY);
      const cached = state.latest.cached - state.baseline.cached;
      const result = parsed.data.turn.status === 'completed' ? {} : { result: 'error' as const };
      state.turnId = null;
      state.lastText = '';
      return [
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
      if (message.success) state.lastText = message.data.text;
      // Codex 0.154 reports a compaction only as this item, never as `thread/compacted`.
      if (parsed.data.item.type === 'contextCompaction')
        return [{ type: 'compacted', trigger: 'auto' }];
      const taken = UserMessageItem.safeParse(parsed.data.item);
      if (taken.success) return [{ type: 'consumed', uuids: [taken.data.clientId] }];
      const activity = itemActivity(parsed.data.item);
      return activity === null ? [] : [activity];
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
