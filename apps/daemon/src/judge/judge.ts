import {
  AccountKind,
  JUDGE_TIMEOUT_MS,
  mintId,
  type AccountId,
  type AskedDecision,
  JudgeDecision,
  isAskedDecision,
  type JudgeCallId,
  type JudgeOutcome,
  type JudgeTestResultDto,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { getJudgeConfig, insertJudgeCall, listAccountModels } from '@10db/db';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { askModel, type ModelQuestion } from './ask';
import type { BedrockClientFactory } from './bedrock';
import { ModelApi, modelApi, optionsText, type ModelAnswer } from './openrouter';
import { NO_DECISION_CREDENTIAL, secretsOf, type JudgeCredential } from './credential';
import { untilAborted } from './until-aborted';

/** Logged calls are kept this long; older rows are deleted when the daemon starts. */
export const JUDGE_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** The connection test waits longer: it may be the first call to a cold model. */
const TEST_TIMEOUT_MS = 15_000;

export interface JudgeRequest {
  readonly decision: AskedDecision;
  /** The content the question is about: task text and a capped diff. */
  readonly state: string;
  readonly question: string;
  readonly options: readonly [string, ...string[]];
  /** What each option means, by option. The call's logged question carries them as text. */
  readonly criteria?: Readonly<Record<string, string>>;
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
      readonly callId: JudgeCallId;
    }
  | {
      readonly kind: 'fallback';
      readonly reason: 'off' | 'no_key' | 'timeout' | 'error' | 'stopped';
      readonly detail: string;
      readonly callId: JudgeCallId;
    };

/** What a decision asks of the judge. */
export interface Judge {
  /**
   * The daemon was started with `TENDB_JUDGE=off`. A decision then keeps today's rule without calling
   * `choose`, so no fallback row is logged for each of them.
   */
  readonly off: boolean;
  /**
   * Asks the decision's configured model one question and logs the call. Never throws: off, no key,
   * a timeout, an HTTP error or an answer that does not parse is a `fallback`, and the caller applies
   * today's rule. The caller records what it did with an answer through `recordJudgeOutcome`.
   */
  choose(req: JudgeRequest): Promise<JudgeAnswer>;
  /**
   * Whether `decision` can be asked now: the daemon isn't off, the master switch and the decision's are on, and
   * the key reads within `JUDGE_TIMEOUT_MS`. Calls no model and logs nothing.
   */
  ready(decision: JudgeDecision): Promise<boolean>;
}

export interface JudgeService extends Judge {
  /**
   * One tiny call with `account`'s key, to check the key, the connection and that `model` (the review decision's
   * model when none is given) answers a decision 10db can use. Logs nothing.
   */
  test(account: AccountId, model?: string): Promise<JudgeTestResultDto>;
  /**
   * Why the account's latest call fell back to rules (a rejected key, an expired profile, a timeout, no credential),
   * or null when its latest call answered or none ran since the daemon started.
   */
  lastFallback(account: AccountId): string | null;
}

export interface JudgeDeps {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly fetch: typeof fetch;
  /**
   * The credential of the account `accountId`, read fresh for every call; null when there is none: no account,
   * an archived or unable account, or a secret that is missing or changed.
   */
  /** Builds Bedrock's runtime client; the SDK's own when absent. */
  readonly bedrockClient?: BedrockClientFactory;
  readonly readCredential: (accountId: AccountId | null) => Promise<JudgeCredential | null>;
  /** The ids of OpenRouter's decision models, which say which endpoint a model answers on; null when unknown. Never waits. */
  readonly decisionModelIds: () => ReadonlySet<string> | null;
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
  stopped: 'stopped',
} as const satisfies Record<string, JudgeOutcome>;

type Attempt =
  | { readonly kind: 'answered'; readonly answer: ModelAnswer; readonly latencyMs: number }
  | {
      readonly kind: 'fallback';
      readonly reason: 'no_key' | 'timeout' | 'error' | 'stopped';
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

export function createJudge(deps: JudgeDeps): JudgeService {
  /** Replaces every secret wherever it appears, so a server that echoes one back cannot put it in a log. */
  function scrub(text: string, credential: JudgeCredential | null): string {
    return secretsOf(credential).reduce(
      (out, secret) => (secret.length === 0 ? out : out.split(secret).join('[key]')),
      text,
    );
  }

  /** The latest outcome of a call on each account: the reason it fell back, or null when it answered. */
  const lastFallbacks = new Map<AccountId, string | null>();

  /** What the account lists as the model's price per million tokens; undefined when it lists none. */
  function listedPrice(accountId: AccountId | null, model: string): ModelQuestion['price'] {
    if (accountId === null) return undefined;
    const row = listAccountModels(deps.state.db, accountId).find((m) => m.launchId === model);
    return row?.inputPrice == null || row.outputPrice === null
      ? undefined
      : { inputUsdPerMillion: row.inputPrice, outputUsdPerMillion: row.outputPrice };
  }

  /** One call to `model`, bounded by `timeoutMs` on the injected clock and by the caller's signal. */
  async function attempt(
    model: string,
    accountId: AccountId | null,
    q: Pick<JudgeRequest, 'state' | 'question' | 'options' | 'criteria' | 'signal'>,
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
    let credential: JudgeCredential | null = null;
    try {
      // The credential read is part of the call: a slow Keychain counts against the same timeout.
      credential = await untilAborted(deps.readCredential(accountId), controller.signal);
      // A call cut short while the key was read sends nothing.
      controller.signal.throwIfAborted();
      if (credential === null)
        return {
          kind: 'fallback',
          reason: 'no_key',
          detail: NO_DECISION_CREDENTIAL,
          latencyMs: null,
        };
      const price =
        credential.kind === AccountKind.OpenRouter ? undefined : listedPrice(accountId, model);
      const answer = await untilAborted(
        askModel({
          model,
          api:
            credential.kind === AccountKind.OpenRouter
              ? modelApi(model, deps.decisionModelIds)
              : ModelApi.Chat,
          state: q.state,
          question: q.question,
          options: q.options,
          ...(q.criteria === undefined ? {} : { criteria: q.criteria }),
          ...(price === undefined ? {} : { price }),
          credential,
          ...(deps.bedrockClient === undefined ? {} : { bedrockClient: deps.bedrockClient }),
          fetch: deps.fetch,
          signal: controller.signal,
        }),
        // A credential lookup the SDK makes before it reads the signal (an SSO profile) is bounded too.
        controller.signal,
      );
      return { kind: 'answered', answer, latencyMs: elapsed() };
    } catch (error) {
      if (timeout.fired)
        return {
          kind: 'fallback',
          reason: 'timeout',
          detail: `No answer within ${String(timeoutMs / 1000)} s`,
          latencyMs: elapsed(),
        };
      // The caller's signal is a cancel or a shutdown: the call did not fail, it was stopped.
      if (q.signal?.aborted)
        return {
          kind: 'fallback',
          reason: 'stopped',
          detail: 'Stopped by a cancel or a shutdown',
          latencyMs: elapsed(),
        };
      return {
        kind: 'fallback',
        reason: 'error',
        detail: scrub(messageOf(error), credential),
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
      }): JudgeCallId =>
        deps.state.write((ctx) =>
          insertJudgeCall(ctx, {
            decision: req.decision,
            model: fields.model ?? model,
            state: req.state,
            question:
              req.criteria === undefined
                ? req.question
                : `${req.question}\nOptions:${optionsText(req)}`,
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

      const result = await attempt(
        model,
        config.accountId,
        req,
        deps.timeoutMs ?? JUDGE_TIMEOUT_MS,
      );
      // A decision's own calls say whether the account is answering; a test of another model does not.
      if (config.accountId !== null && !(result.kind === 'fallback' && result.reason === 'stopped'))
        lastFallbacks.set(config.accountId, result.kind === 'fallback' ? result.detail : null);
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

  async function ready(decision: JudgeDecision): Promise<boolean> {
    if (deps.off || !isAskedDecision(decision)) return false;
    const controller = new AbortController();
    const timer = deps.clock.setTimeout(() => {
      controller.abort();
    }, deps.timeoutMs ?? JUDGE_TIMEOUT_MS);
    try {
      const config = getJudgeConfig(deps.state.db);
      if (!config.enabled || !config.decisions[decision].enabled) return false;
      const credential = await untilAborted(
        deps.readCredential(config.accountId),
        controller.signal,
      );
      return credential !== null;
    } catch {
      // A key read that throws or doesn't answer in time means no call could run now.
      return false;
    } finally {
      timer.cancel();
    }
  }

  async function test(account: AccountId, model?: string): Promise<JudgeTestResultDto> {
    if (deps.off) return { ok: false, error: 'This daemon was started with TENDB_JUDGE=off' };
    const result = await attempt(
      model ?? getJudgeConfig(deps.state.db).decisions[JudgeDecision.ShapeRecord].model,
      account,
      { state: TEST_STATE, question: TEST_QUESTION, options: TEST_OPTIONS },
      TEST_TIMEOUT_MS,
    );
    if (result.kind === 'fallback')
      return {
        ok: false,
        error: result.reason === 'no_key' ? NO_DECISION_CREDENTIAL : result.detail,
      };
    return {
      ok: true,
      model: result.answer.model,
      latencyMs: result.latencyMs,
      costUsd: result.answer.costUsd,
    };
  }

  return {
    off: deps.off,
    choose,
    ready,
    test,
    lastFallback: (account) => lastFallbacks.get(account) ?? null,
  };
}
