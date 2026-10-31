import {
  mintId,
  type JudgeDecision,
  type JudgeOutcome,
  type JudgeTestResultDto,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { getJudgeConfig, insertJudgeCall } from '@10db/db';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { askModel, type ModelAnswer } from './openrouter';

/** How long a decision waits for a model before today's rule applies. */
export const JUDGE_TIMEOUT_MS = 4_000;
/** Logged calls are kept this long; older rows are deleted when the daemon starts. */
export const JUDGE_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** The connection test waits longer: it may be the first call to a cold model. */
const TEST_TIMEOUT_MS = 15_000;

export interface JudgeRequest {
  readonly decision: JudgeDecision;
  /** The content the question is about: task text and a capped diff. */
  readonly state: string;
  readonly question: string;
  readonly options: readonly [string, ...string[]];
  readonly workstreamId?: WorkstreamId;
  readonly taskId?: TaskId;
  readonly signal?: AbortSignal;
}

export type JudgeAnswer =
  | {
      readonly kind: 'answered';
      readonly choice: string;
      readonly confidence: number;
      readonly model: string;
      readonly latencyMs: number;
      readonly costUsd: number | null;
      readonly callId: string;
    }
  | {
      readonly kind: 'fallback';
      readonly reason: 'off' | 'no_key' | 'timeout' | 'error';
      readonly detail: string;
      readonly callId: string;
    };

/** What a decision asks of the judge. */
export interface Judge {
  /**
   * Asks the decision's configured model one question and logs the call. Never throws: off, no key,
   * a timeout, an HTTP error or an answer that does not parse is a `fallback`, and the caller applies
   * today's rule. The caller records what it did with an answer through `recordJudgeOutcome`.
   */
  choose(req: JudgeRequest): Promise<JudgeAnswer>;
}

export interface JudgeService extends Judge {
  /** One tiny call on the review decision's model, to check the key and the connection. Logs nothing. */
  test(): Promise<JudgeTestResultDto>;
}

export interface JudgeDeps {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly fetch: typeof fetch;
  /** The builder's OpenRouter key, read fresh for every call; null when there is none. */
  readonly readKey: () => Promise<string | null>;
  /** The daemon was started with `TENDB_JUDGE=off`: no key is read and nothing is sent. */
  readonly off: boolean;
  readonly logger: Logger;
  readonly timeoutMs?: number;
}

const FALLBACK_OUTCOME = {
  off: 'fallback_off',
  no_key: 'fallback_no_key',
  timeout: 'fallback_timeout',
  error: 'fallback_error',
} as const satisfies Record<string, JudgeOutcome>;

type Attempt =
  | { readonly kind: 'answered'; readonly answer: ModelAnswer; readonly latencyMs: number }
  | {
      readonly kind: 'fallback';
      readonly reason: 'no_key' | 'timeout' | 'error';
      readonly detail: string;
      readonly latencyMs: number | null;
    };

const TEST_STATE =
  'The change renames one local variable in one file; the tests that cover it pass.';
const TEST_QUESTION = 'Does this change need an independent code review before it ships?';
const TEST_OPTIONS = ['review', 'skip'] as const;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/** The promise's value, or a rejection as soon as `signal` aborts, whichever comes first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error('aborted'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export function createJudge(deps: JudgeDeps): JudgeService {
  /** Replaces the key wherever it appears, so a server that echoes it back cannot put it in a log. */
  function scrub(text: string, key: string | null): string {
    return key === null || key.length === 0 ? text : text.split(key).join('[key]');
  }

  /** One call to `model`, bounded by `timeoutMs` on the injected clock and by the caller's signal. */
  async function attempt(
    model: string,
    q: Pick<JudgeRequest, 'state' | 'question' | 'options' | 'signal'>,
    timeoutMs: number,
  ): Promise<Attempt> {
    const controller = new AbortController();
    const timeout = { fired: false };
    const timer = deps.clock.setTimeout(() => {
      timeout.fired = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = (): void => {
      controller.abort();
    };
    if (q.signal?.aborted) controller.abort();
    q.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const started = deps.clock.now().getTime();
    const elapsed = (): number => deps.clock.now().getTime() - started;
    let key: string | null = null;
    try {
      // The key read is part of the call: a slow Keychain counts against the same timeout.
      key = await untilAborted(deps.readKey(), controller.signal);
      // A call cut short while the key was read sends nothing.
      controller.signal.throwIfAborted();
      if (key === null)
        return {
          kind: 'fallback',
          reason: 'no_key',
          detail: 'No OpenRouter key is set',
          latencyMs: null,
        };
      const answer = await askModel({
        model,
        state: q.state,
        question: q.question,
        options: q.options,
        key,
        fetch: deps.fetch,
        signal: controller.signal,
      });
      return { kind: 'answered', answer, latencyMs: elapsed() };
    } catch (error) {
      if (timeout.fired)
        return {
          kind: 'fallback',
          reason: 'timeout',
          detail: `No answer within ${String(timeoutMs / 1000)} s`,
          latencyMs: elapsed(),
        };
      return {
        kind: 'fallback',
        reason: 'error',
        detail: scrub(messageOf(error), key),
        latencyMs: elapsed(),
      };
    } finally {
      timer.cancel();
      q.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  async function choose(req: JudgeRequest): Promise<JudgeAnswer> {
    let model = '';
    try {
      const config = getJudgeConfig(deps.state.db);
      const decision = config.decisions[req.decision];
      model = decision.model;
      const log = (fields: {
        readonly answer: string | null;
        readonly confidence: number | null;
        readonly outcome: JudgeOutcome;
        readonly latencyMs: number | null;
        readonly costUsd: number | null;
        readonly model?: string;
      }): string =>
        deps.state.write((ctx) =>
          insertJudgeCall(ctx, {
            decision: req.decision,
            model: fields.model ?? model,
            state: req.state,
            question: req.question,
            answer: fields.answer,
            confidence: fields.confidence,
            outcome: fields.outcome,
            latencyMs: fields.latencyMs,
            costUsd: fields.costUsd,
            workstreamId: req.workstreamId ?? null,
            taskId: req.taskId ?? null,
          }),
        );
      const fallback = (
        reason: keyof typeof FALLBACK_OUTCOME,
        detail: string,
        latencyMs: number | null,
      ): JudgeAnswer => ({
        kind: 'fallback',
        reason,
        detail,
        callId: log({
          answer: null,
          confidence: null,
          outcome: FALLBACK_OUTCOME[reason],
          latencyMs,
          costUsd: null,
        }),
      });

      if (deps.off) return fallback('off', 'Started with TENDB_JUDGE=off', null);
      if (!config.enabled || !decision.enabled)
        return fallback('off', 'Switched off in Settings', null);

      const result = await attempt(model, req, deps.timeoutMs ?? JUDGE_TIMEOUT_MS);
      if (result.kind === 'fallback')
        return fallback(result.reason, result.detail, result.latencyMs);
      const { answer } = result;
      // Provisional: the decision that acts on the answer replaces it with `acted` or `below_floor`.
      const callId = log({
        answer: answer.choice,
        confidence: answer.confidence,
        outcome: answer.confidence >= decision.floor ? 'acted' : 'below_floor',
        latencyMs: result.latencyMs,
        costUsd: answer.costUsd,
      });
      return {
        kind: 'answered',
        choice: answer.choice,
        confidence: answer.confidence,
        model: answer.model,
        latencyMs: result.latencyMs,
        costUsd: answer.costUsd,
        callId,
      };
    } catch (error) {
      // The log or the config could not be read or written: with nothing recorded, the caller applies today's rule.
      deps.logger.error({ err: error, decision: req.decision, model }, 'judge call failed');
      return {
        kind: 'fallback',
        reason: 'error',
        detail: messageOf(error),
        // Nothing was logged under this id, so recording an outcome against it changes nothing.
        callId: mintId('JudgeCall'),
      };
    }
  }

  async function test(): Promise<JudgeTestResultDto> {
    if (deps.off) return { ok: false, error: 'This daemon was started with TENDB_JUDGE=off' };
    const model = getJudgeConfig(deps.state.db).decisions.review_size.model;
    const result = await attempt(
      model,
      { state: TEST_STATE, question: TEST_QUESTION, options: TEST_OPTIONS },
      TEST_TIMEOUT_MS,
    );
    if (result.kind === 'fallback')
      return {
        ok: false,
        error: result.reason === 'no_key' ? 'No OpenRouter key is set' : result.detail,
      };
    return {
      ok: true,
      model: result.answer.model,
      latencyMs: result.latencyMs,
      costUsd: result.answer.costUsd,
    };
  }

  return { choose, test };
}
