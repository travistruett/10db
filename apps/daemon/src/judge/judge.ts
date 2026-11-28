import {
  AccountKind,
  JUDGE_TIMEOUT_MS,
  JUDGE_UNATTENDED_ATTEMPTS,
  JUDGE_UNATTENDED_TIMEOUT_MS,
  JudgeBudget,
  mintId,
  type AccountId,
  type AskedDecision,
  JudgeDecision,
  isAskedDecision,
  type JudgeCallId,
  type JudgeOutcome,
  type JudgeTestResultDto,
  type ProjectId,
  type TaskId,
  type TrustPrecedentId,
  type WorkstreamId,
} from '@10db/contracts';
import { getJudgeConfig, insertJudgeCall, listAccountModels } from '@10db/db';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { askModel, askModelNouls, type ModelQuestion } from './ask';
import type { NoulQuestion } from './noul-questions';
import type { BedrockClientFactory } from './bedrock';
import { isTypeSafeModel, ModelApi, modelApi, optionsText } from './openrouter';
import { NO_DECISION_CREDENTIAL, secretsOf, type JudgeCredential } from './credential';
import type { JudgeCallHealth } from './outage';
import {
  parseSessionChoice,
  parseSessionNouls,
  sessionChoicePrompt,
  sessionNoulsPrompt,
} from './session-answer';
import { untilAborted } from './until-aborted';

/** Logged calls are kept this long; older rows are deleted when the daemon starts. */
export const JUDGE_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** How long a question asked in a session on the project's own account may take: a CLI start is slow. */
export const SESSION_JUDGE_TIMEOUT_MS = 60_000;
/** How much later a session's own deadline is than the call's, so the call's timeout is the one logged. */
const SESSION_GRACE_MS = 5_000;
/** What a failed session call's detail ends with. */
export const DECISIONS_ACCOUNT_WOULD_SETTLE = 'A Decisions account would have settled it.';

/** The decisions a session on the project's account never answers: limits block a live tool call. */
const SESSION_EXCLUDED: ReadonlySet<JudgeDecision> = new Set([
  JudgeDecision.CrossesLimit,
  JudgeDecision.CrossesLimitSecond,
]);

/** What a call is about, so the session judge can find the project whose account it asks on. */
export interface SessionScope {
  readonly taskId?: TaskId | undefined;
  readonly workstreamId?: WorkstreamId | undefined;
  readonly projectId?: ProjectId | undefined;
}

/** A one-shot, tool-less question on a project's own account. */
export interface SessionAsker {
  /** The model it runs on, as the account launches it: the call's logged model. */
  readonly model: string;
  /** Answers the model's text; rejects on a timeout, a withdrawal or a failed start. */
  ask(
    prompt: string,
    opts: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<string>;
}
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
  /** Who waits on the call; attended when absent. */
  readonly budget?: JudgeBudget;
  readonly workstreamId?: WorkstreamId;
  readonly taskId?: TaskId;
  /** The project the call is about, when the caller has it: only for finding its account, never logged. */
  readonly projectId?: ProjectId;
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

/** A decision asked as yes/no questions about a structured state. */
export interface AssessRequest {
  readonly decision: AskedDecision;
  /** The content the questions are about, as named fields. */
  readonly state: Readonly<Record<string, unknown>>;
  /** By question id; each question carries its whole meaning, since the id is not sent as a question. */
  readonly questions: Readonly<Record<string, NoulQuestion>>;
  /** What the call's row records of the answers at the decision's floor; pure, so the caller can read them again. */
  readonly read: (probabilities: Readonly<Record<string, number>>, floor: number) => AssessReading;
  /** How long one try of this call may take; the budget's own timeout when absent. */
  readonly timeoutMs?: number;
  /** Who waits on the call; attended when absent. */
  readonly budget?: JudgeBudget;
  /**
   * A second opinion: its failures are its own, so they neither raise the judge's outage card nor show as the
   * account falling back to rules.
   */
  readonly secondary?: boolean;
  readonly workstreamId?: WorkstreamId;
  readonly taskId?: TaskId;
  /** The project the call is about, when the caller has it: only for finding its account, never logged. */
  readonly projectId?: ProjectId;
  /** The precedent the state shows; the row names it only when the reading is `byPrecedent`. */
  readonly precedentId?: TrustPrecedentId;
  /** The program the call runs, written on every row of the call. */
  readonly programKey?: string | null;
  readonly signal?: AbortSignal;
}

/** What a call's row records of its answers. */
export interface AssessReading {
  readonly answer: string;
  readonly confidence: number;
  readonly outcome: JudgeOutcome;
  /** The answers allowed the call through a precedent: the row records which. */
  readonly byPrecedent?: true;
}

export type AssessAnswer =
  | {
      readonly kind: 'answered';
      /** Each question's probability of yes, by id. */
      readonly probabilities: Readonly<Record<string, number>>;
      /** The decision's floor when it was asked, so the caller reads the answers at the level the row did. */
      readonly floor: number;
      readonly model: string;
      readonly latencyMs: number;
      readonly costUsd: number | null;
      readonly callId: JudgeCallId;
    }
  | Extract<JudgeAnswer, { readonly kind: 'fallback' }>;

/** What a call's row holds of its answer, whatever was asked. */
interface LoggedAnswer {
  readonly answer: string | null;
  readonly confidence: number | null;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly outcome: JudgeOutcome;
  readonly costUsd: number | null;
  readonly byPrecedent?: true;
}

type Decided<T> =
  | {
      readonly kind: 'answered';
      readonly answer: T;
      readonly floor: number;
      readonly latencyMs: number;
      readonly callId: JudgeCallId;
    }
  | Extract<JudgeAnswer, { readonly kind: 'fallback' }>;

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
   * Asks the decision's model yes/no questions and logs the call with every probability and what `read` makes of
   * them. Never throws; a call that can't answer is a `fallback`, as for `choose`.
   */
  assess(req: AssessRequest): Promise<AssessAnswer>;
  /**
   * Whether `decision` can be asked now: the daemon isn't off, the master switch and the decision's are on, and
   * the key reads within `JUDGE_TIMEOUT_MS`, or, with no Decisions account, the session judge can ask on the
   * project of `scope`. Calls no model and logs nothing.
   */
  ready(decision: JudgeDecision, scope?: SessionScope): Promise<boolean>;
}

export interface JudgeService extends Judge {
  /**
   * One tiny call with `account`'s key, to check the key, the connection and that `model` (the review decision's
   * model when none is given) answers a decision 10db can use, asked the way `kind` says. Logs nothing.
   */
  test(account: AccountId, model?: string, kind?: JudgeTestKind): Promise<JudgeTestResultDto>;
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
  /** Told how each decision's call went, so an outage the builder must fix is raised once. */
  readonly onCallHealth?: (health: JudgeCallHealth) => void;
  /**
   * With no Decisions account, asks the call's project's own plan account in a one-shot session; null when the
   * project's account can't. Absent: no call is asked that way.
   */
  readonly sessionJudge?: (scope: SessionScope) => SessionAsker | null;
}

/** What a session asks and how its reply is read. */
interface SessionQuestion<T> {
  readonly prompt: string;
  readonly parse: (text: string, model: string) => T;
}

/** How a call bounded by a timeout and the caller's signal went. */
type Bounded<T> =
  | { readonly kind: 'answered'; readonly answer: T; readonly latencyMs: number }
  | {
      readonly kind: 'fallback';
      readonly reason: 'timeout' | 'error' | 'stopped';
      readonly detail: string;
      readonly latencyMs: number;
    };

const FALLBACK_OUTCOME = {
  off: 'fallback_off',
  no_key: 'fallback_no_key',
  timeout: 'fallback_timeout',
  error: 'fallback_error',
  stopped: 'stopped',
} as const satisfies Record<string, JudgeOutcome>;

/** The kind of account a try ran on: the provider an outage card names. Null when no credential was read. */
type TriedOn = JudgeCredential['kind'] | null;

type Attempt<T> =
  | {
      readonly kind: 'answered';
      readonly answer: T;
      readonly latencyMs: number;
      readonly accountKind: TriedOn;
    }
  | {
      readonly kind: 'fallback';
      readonly reason: 'no_key' | 'timeout' | 'error' | 'stopped';
      readonly detail: string;
      readonly latencyMs: number | null;
      readonly accountKind: TriedOn;
    };

const TEST_STATE =
  'The change renames one local variable in one file; the tests that cover it pass.';
const TEST_QUESTION = 'Does this change need an independent code review before it ships?';
const TEST_OPTIONS = ['review', 'skip'] as const;
const TEST_NOULS = {
  needs_review: {
    instructions: TEST_QUESTION,
    criteria: { true: 'It needs a review first.', false: 'It can ship without one.' },
  },
} as const satisfies Record<string, NoulQuestion>;

/** What a model test asks: a choice, as most decisions do, or yes/no questions, as the limits decisions do. */
export const JudgeTestKind = { Choice: 'choice', Nouls: 'nouls' } as const;
export type JudgeTestKind = (typeof JudgeTestKind)[keyof typeof JudgeTestKind];

/** What every call carries to its transport, whatever it asks. */
type Transport = Pick<
  ModelQuestion,
  'model' | 'api' | 'price' | 'credential' | 'bedrockClient' | 'fetch' | 'signal'
>;

/** The choice a request asks, as the transport takes it. */
function choiceOf(
  req: JudgeRequest,
): Pick<ModelQuestion, 'state' | 'question' | 'options' | 'criteria'> {
  return {
    state: req.state,
    question: req.question,
    options: req.options,
    ...(req.criteria === undefined ? {} : { criteria: req.criteria }),
  };
}

/**
 * The OpenRouter endpoint yes/no questions go to: the decisions endpoint for a TypeSafe model or a model the list
 * names, and chat for every other model. With the list unread any other model is asked as a chat model, since only
 * TypeSafe's are known to answer a `noul` on the decisions endpoint.
 */
function noulApi(model: string, decisionModels: () => ReadonlySet<string> | null): ModelApi {
  if (modelApi(model, decisionModels) === ModelApi.Chat) return ModelApi.Chat;
  return decisionModels() !== null || isTypeSafeModel(model) ? ModelApi.Decisions : ModelApi.Chat;
}

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

  /**
   * One call to `model`, bounded by `timeoutMs` on the injected clock and by the caller's signal; `send` asks the
   * question on the transport it is handed.
   */
  async function attempt<T>(
    model: string,
    accountId: AccountId | null,
    q: { readonly signal?: AbortSignal | undefined },
    timeoutMs: number,
    send: (transport: Transport) => Promise<T>,
  ): Promise<Attempt<T>> {
    const read: { credential: JudgeCredential | null } = { credential: null };
    const result = await bounded(
      q.signal,
      timeoutMs,
      async (signal) => {
        // The credential read is part of the call: a slow Keychain counts against the same timeout.
        const credential = await untilAborted(deps.readCredential(accountId), signal);
        read.credential = credential;
        // A call cut short while the key was read sends nothing.
        signal.throwIfAborted();
        if (credential === null) return null;
        const price =
          credential.kind === AccountKind.OpenRouter ? undefined : listedPrice(accountId, model);
        const answer = await untilAborted(
          send({
            model,
            api:
              credential.kind === AccountKind.OpenRouter
                ? modelApi(model, deps.decisionModelIds)
                : ModelApi.Chat,
            ...(price === undefined ? {} : { price }),
            credential,
            ...(deps.bedrockClient === undefined ? {} : { bedrockClient: deps.bedrockClient }),
            fetch: deps.fetch,
            signal,
          }),
          // A credential lookup the SDK makes before it reads the signal (an SSO profile) is bounded too.
          signal,
        );
        return { answer };
      },
      (error) => scrub(messageOf(error), read.credential),
    );
    const accountKind = read.credential?.kind ?? null;
    if (result.kind === 'fallback') return { ...result, accountKind };
    if (result.answer === null)
      return {
        kind: 'fallback',
        reason: 'no_key',
        detail: NO_DECISION_CREDENTIAL,
        latencyMs: null,
        accountKind: null,
      };
    return {
      kind: 'answered',
      answer: result.answer.answer,
      latencyMs: result.latencyMs,
      accountKind,
    };
  }

  /**
   * Runs `run` bounded by `timeoutMs` on the injected clock and by the caller's signal: a timeout, a stop by the
   * caller and an error each come back as a fallback, `errorText` giving an error's detail.
   */
  async function bounded<T>(
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
    errorText: (error: unknown) => string,
  ): Promise<Bounded<T>> {
    const controller = new AbortController();
    const timeout = { fired: false };
    const timer = deps.clock.setTimeout(() => {
      timeout.fired = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = (): void => {
      controller.abort();
    };
    if (callerSignal?.aborted) controller.abort();
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const started = deps.clock.now().getTime();
    const elapsed = (): number => deps.clock.now().getTime() - started;
    try {
      const answer = await run(controller.signal);
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
      if (callerSignal?.aborted)
        return {
          kind: 'fallback',
          reason: 'stopped',
          detail: 'Stopped by a cancel or a shutdown',
          latencyMs: elapsed(),
        };
      return { kind: 'fallback', reason: 'error', detail: errorText(error), latencyMs: elapsed() };
    } finally {
      timer.cancel();
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /** The session judge's asker for a call's scope, or null when it has none or fails to find one. */
  function sessionAskerFor(decision: JudgeDecision, scope: SessionScope): SessionAsker | null {
    if (deps.sessionJudge === undefined || SESSION_EXCLUDED.has(decision)) return null;
    try {
      return deps.sessionJudge(scope);
    } catch (error) {
      deps.logger.warn({ err: error, decision }, 'session judge could not be prepared');
      return null;
    }
  }

  /**
   * One logged call of `decision`: the config, the switches, the call and its row. `logged` turns an answer into
   * the row's answer, confidence and outcome. Never throws.
   */
  async function decide<T>(
    req: {
      readonly decision: AskedDecision;
      readonly state: string;
      readonly question: string;
      readonly workstreamId?: WorkstreamId | undefined;
      readonly taskId?: TaskId | undefined;
      readonly projectId?: ProjectId | undefined;
      readonly signal?: AbortSignal | undefined;
      readonly timeoutMs?: number | undefined;
      readonly budget?: JudgeBudget | undefined;
      readonly secondary?: boolean | undefined;
      readonly precedentId?: TrustPrecedentId | undefined;
      readonly programKey?: string | null | undefined;
    },
    send: (transport: Transport) => Promise<T>,
    session: SessionQuestion<T>,
    logged: (answer: T, floor: number) => LoggedAnswer,
  ): Promise<Decided<T>> {
    let model = '';
    // A second opinion's health is not the judge's: it reports nothing.
    const health = (h: JudgeCallHealth): void => {
      if (req.secondary !== true) deps.onCallHealth?.(h);
    };
    try {
      const config = getJudgeConfig(deps.state.db);
      const decision = config.decisions[req.decision];
      model = decision.model;
      let attempts = 1;
      const log = (fields: LoggedAnswer & { readonly latencyMs: number | null }): JudgeCallId =>
        deps.state.write((ctx) =>
          insertJudgeCall(ctx, {
            decision: req.decision,
            model,
            state: req.state,
            question: req.question,
            answer: fields.answer,
            confidence: fields.confidence,
            probabilities: fields.probabilities ?? null,
            outcome: fields.outcome,
            latencyMs: fields.latencyMs,
            attempts,
            costUsd: fields.costUsd,
            workstreamId: req.workstreamId ?? null,
            taskId: req.taskId ?? null,
            precedentId: fields.byPrecedent === true ? (req.precedentId ?? null) : null,
            programKey: req.programKey ?? null,
          }),
        );
      const fallback = (
        reason: keyof typeof FALLBACK_OUTCOME,
        detail: string,
        latencyMs: number | null,
      ): Decided<T> => ({
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

      if (deps.off) {
        health({ kind: 'off' });
        return fallback('off', 'Started with TENDB_JUDGE=off', null);
      }
      // One decision switched off says nothing of the judge's health: only the whole judge off does.
      if (!config.enabled) health({ kind: 'off' });
      if (!config.enabled || !decision.enabled)
        return fallback('off', 'Switched off in Settings', null);

      const asker = config.accountId === null ? sessionAskerFor(req.decision, req) : null;
      if (asker !== null) {
        // The project's own account answers: its health is not the Decisions account's, so it reports nothing.
        model = asker.model;
        const timeoutMs = Math.max(req.timeoutMs ?? 0, SESSION_JUDGE_TIMEOUT_MS);
        const result = await bounded(
          req.signal,
          timeoutMs,
          async (signal) =>
            session.parse(
              // The session's own deadline is later, so this call's timeout is the one that ends it.
              await untilAborted(
                asker.ask(session.prompt, { signal, timeoutMs: timeoutMs + SESSION_GRACE_MS }),
                signal,
              ),
              asker.model,
            ),
          messageOf,
        );
        if (result.kind === 'fallback')
          return fallback(
            result.reason,
            result.reason === 'stopped'
              ? result.detail
              : `${result.detail.replace(/\.$/, '')}. ${DECISIONS_ACCOUNT_WOULD_SETTLE}`,
            result.latencyMs,
          );
        const callId = log({
          ...logged(result.answer, decision.floor),
          latencyMs: result.latencyMs,
        });
        return {
          kind: 'answered',
          answer: result.answer,
          floor: decision.floor,
          latencyMs: result.latencyMs,
          callId,
        };
      }

      const unattended = req.budget === JudgeBudget.Unattended;
      const timeoutMs =
        req.timeoutMs ??
        (unattended ? JUDGE_UNATTENDED_TIMEOUT_MS : (deps.timeoutMs ?? JUDGE_TIMEOUT_MS));
      const maxAttempts = unattended ? JUDGE_UNATTENDED_ATTEMPTS : 1;
      let result = await attempt(model, config.accountId, req, timeoutMs, send);
      let waitedMs = result.latencyMs ?? 0;
      // Only a slow answer is tried again: an error or a missing key would fail the same way.
      while (
        result.kind === 'fallback' &&
        result.reason === 'timeout' &&
        attempts < maxAttempts &&
        req.signal?.aborted !== true
      ) {
        attempts += 1;
        result = await attempt(model, config.accountId, req, timeoutMs, send);
        waitedMs += result.latencyMs ?? 0;
      }
      if (attempts > 1) {
        if (result.kind === 'answered') result = { ...result, latencyMs: waitedMs };
        else
          result = {
            ...result,
            latencyMs: waitedMs,
            ...(result.reason === 'timeout'
              ? { detail: `${result.detail} in ${String(attempts)} tries` }
              : {}),
          };
      }
      // A decision's own calls say whether the account is answering; a test of another model does not.
      if (
        req.secondary !== true &&
        config.accountId !== null &&
        !(result.kind === 'fallback' && result.reason === 'stopped')
      )
        lastFallbacks.set(config.accountId, result.kind === 'fallback' ? result.detail : null);
      if (result.kind === 'fallback') {
        if (result.reason !== 'stopped')
          health({
            kind: 'failed',
            reason: result.reason,
            detail: result.detail,
            model,
            accountKind: result.accountKind,
            ...(req.taskId === undefined ? {} : { taskId: req.taskId }),
            ...(req.workstreamId === undefined ? {} : { workstreamId: req.workstreamId }),
          });
        return fallback(result.reason, result.detail, result.latencyMs);
      }
      health({ kind: 'answered' });
      const callId = log({
        ...logged(result.answer, decision.floor),
        latencyMs: result.latencyMs,
      });
      return {
        kind: 'answered',
        answer: result.answer,
        floor: decision.floor,
        latencyMs: result.latencyMs,
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

  async function choose(req: JudgeRequest): Promise<JudgeAnswer> {
    const decided = await decide(
      {
        ...req,
        question:
          req.criteria === undefined
            ? req.question
            : `${req.question}\nOptions:${optionsText(req)}`,
      },
      (transport) => askModel({ ...transport, ...choiceOf(req) }),
      {
        prompt: sessionChoicePrompt(choiceOf(req)),
        parse: (text, model) => parseSessionChoice(req, text, model),
      },
      // Provisional: the decision that acts on the answer replaces it with `acted` or `below_floor`.
      (answer, floor) => ({
        answer: answer.choice,
        confidence: answer.confidence,
        outcome: answer.confidence >= floor ? 'acted' : 'below_floor',
        costUsd: answer.costUsd,
      }),
    );
    if (decided.kind === 'fallback') return decided;
    const { answer } = decided;
    return {
      kind: 'answered',
      choice: answer.choice,
      confidence: answer.confidence,
      model: answer.model,
      latencyMs: decided.latencyMs,
      costUsd: answer.costUsd,
      callId: decided.callId,
    };
  }

  async function assess(req: AssessRequest): Promise<AssessAnswer> {
    const decided = await decide(
      {
        ...req,
        state: JSON.stringify(req.state, null, 2),
        question: Object.entries(req.questions)
          .map(([id, q]) => `${id}: ${q.instructions}`)
          .join('\n'),
      },
      (transport) =>
        askModelNouls({
          ...transport,
          api: noulTransportApi(transport),
          state: req.state,
          questions: req.questions,
        }),
      {
        prompt: sessionNoulsPrompt(req),
        parse: (text, model) => parseSessionNouls(req, text, model),
      },
      (answer, floor) => ({
        ...req.read(answer.probabilities, floor),
        probabilities: answer.probabilities,
        costUsd: answer.costUsd,
      }),
    );
    if (decided.kind === 'fallback') return decided;
    return {
      kind: 'answered',
      probabilities: decided.answer.probabilities,
      floor: decided.floor,
      model: decided.answer.model,
      latencyMs: decided.latencyMs,
      costUsd: decided.answer.costUsd,
      callId: decided.callId,
    };
  }

  /** The API yes/no questions go to on the transport's account: on OpenRouter it may differ from a choice's. */
  function noulTransportApi(transport: Transport): ModelApi {
    return transport.credential.kind === AccountKind.OpenRouter
      ? noulApi(transport.model, deps.decisionModelIds)
      : transport.api;
  }

  async function ready(decision: JudgeDecision, scope: SessionScope = {}): Promise<boolean> {
    if (deps.off || !isAskedDecision(decision)) return false;
    const controller = new AbortController();
    const timer = deps.clock.setTimeout(() => {
      controller.abort();
    }, deps.timeoutMs ?? JUDGE_TIMEOUT_MS);
    try {
      const config = getJudgeConfig(deps.state.db);
      if (!config.enabled || !config.decisions[decision].enabled) return false;
      if (config.accountId === null && sessionAskerFor(decision, scope) !== null) return true;
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

  async function test(
    account: AccountId,
    model?: string,
    kind: JudgeTestKind = JudgeTestKind.Choice,
  ): Promise<JudgeTestResultDto> {
    if (deps.off) return { ok: false, error: 'This daemon was started with TENDB_JUDGE=off' };
    const send = (transport: Transport): Promise<{ model: string; costUsd: number | null }> =>
      kind === JudgeTestKind.Nouls
        ? askModelNouls({
            ...transport,
            api: noulTransportApi(transport),
            state: { change: TEST_STATE },
            questions: TEST_NOULS,
          })
        : askModel({
            ...transport,
            state: TEST_STATE,
            question: TEST_QUESTION,
            options: TEST_OPTIONS,
          });
    const result = await attempt(
      model ?? getJudgeConfig(deps.state.db).decisions[JudgeDecision.ShapeRecord].model,
      account,
      {},
      TEST_TIMEOUT_MS,
      send,
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
    assess,
    ready,
    test,
    lastFallback: (account) => lastFallbacks.get(account) ?? null,
  };
}
