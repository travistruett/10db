import { createChannel } from './channel';
import type { SessionEvent, ShapeSessionHandle, ShapeSessionSpec, ShapeToolRequest } from './types';
import type { GuardVerdict } from '../guard';

/** What a scripted turn of a fake Shape session did. */
export interface FakeShapeTurnResult {
  /** What the model wrote last. */
  readonly text?: string;
  /** The share of the context window in use after the turn; 10 when absent. */
  readonly contextPercent?: number;
}

/** One turn the fake runs for a message it was sent. */
export interface FakeShapeTurn {
  readonly spec: ShapeSessionSpec;
  /** The message the turn answers. */
  readonly message: string;
  /** Which message of this session it is, from 1. */
  readonly number: number;
  /** Aborts when the turn is interrupted. */
  readonly signal: AbortSignal;
  /** The session's PreToolUse hook, as Claude Code runs it before each call. */
  guard(request: ShapeToolRequest): GuardVerdict;
}

export type FakeShapeBehaviour = (turn: FakeShapeTurn) => Promise<FakeShapeTurnResult>;

const DEFAULT_CONTEXT_PERCENT = 10;

/** A Shape session that ends at once with the account's refusal, before any message. */
export function refusedShapeSession(message: string): ShapeSessionHandle {
  const events = createChannel<SessionEvent>();
  events.push({
    type: 'ended',
    reason: 'account_refused',
    message: `${message}. No message was sent.`,
  });
  events.end();
  return {
    events,
    send: () => undefined,
    interrupt: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

/**
 * Stands in for a Shape conversation's Claude Code session: each message it is sent runs the
 * scripted behaviour as one turn, and the turns run one after another.
 */
export function createFakeShapeSession(
  spec: ShapeSessionSpec,
  behaviour: FakeShapeBehaviour,
  providerSessionId: string,
): ShapeSessionHandle {
  const events = createChannel<SessionEvent>();
  const queue: string[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  let current: AbortController | null = null;
  let number = 0;
  // Read through a function: TypeScript would otherwise keep the narrowing from before the awaits.
  const isEnded = (): boolean => ended;
  const finish = (reason: 'stopped' | 'error', message: string | null): void => {
    if (ended) return;
    ended = true;
    events.push({ type: 'ended', reason, message });
    events.end();
    wake?.();
  };

  const guard = (request: ShapeToolRequest): GuardVerdict => {
    try {
      return spec.preToolUse(request);
    } catch (error) {
      return { decision: 'deny', reason: `guard failed: ${String(error)}` };
    }
  };

  const loop = async (): Promise<void> => {
    events.push({ type: 'started', providerSessionId, pid: null });
    queue.push(spec.prompt);
    while (!isEnded()) {
      const message = queue.shift();
      if (message === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      number += 1;
      current = new AbortController();
      let result: FakeShapeTurnResult = {};
      let failed = false;
      try {
        result = await behaviour({ spec, message, number, signal: current.signal, guard });
      } catch (error) {
        if (!current.signal.aborted) {
          failed = true;
          events.push({ type: 'activity', kind: 'text', summary: String(error) });
        }
      }
      current = null;
      if (isEnded()) break;
      const percent = result.contextPercent ?? DEFAULT_CONTEXT_PERCENT;
      events.push({
        type: 'context',
        percentage: percent,
        totalTokens: percent * 2_000,
        maxTokens: 200_000,
      });
      events.push({
        type: 'turn_complete',
        ...(failed ? { result: 'error' as const } : {}),
        ...(result.text === undefined ? {} : { text: result.text }),
        inputTokens: 100 * number,
        outputTokens: 10 * number,
        cachedTokens: 0,
        costUsd: 0,
      });
    }
  };
  void loop();

  return {
    events,
    send(text) {
      queue.push(text);
      wake?.();
    },
    interrupt() {
      current?.abort();
      return Promise.resolve();
    },
    stop() {
      current?.abort();
      finish('stopped', null);
      return Promise.resolve();
    },
  };
}
