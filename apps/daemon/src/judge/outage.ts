import { AccountKind, type TaskId, type WorkstreamId } from '@10db/contracts';
import type { Clock } from '../clock';
import type { Logger } from '../log';
import type { JudgeCredential } from './credential';

/** How far back the failure rate is read: a slow tail is a few calls in it, an outage most of them. */
export const OUTAGE_WINDOW_MS = 5 * 60 * 1000;
/** The fewest failures in the window that can make an outage, so two or three slow answers never do. */
export const OUTAGE_FAILURES = 5;
/** Failing this long with no answer between is an outage however few calls were made. */
export const OUTAGE_SILENCE_MS = 2 * 60 * 1000;
/** The most calls the window keeps; the oldest is dropped first. */
const WINDOW_CALLS_MAX = 512;
/** Answers in a row that must follow a raised outage before its card closes, so a half-down provider doesn't flap it. */
export const OUTAGE_RECOVERY_ANSWERS = 3;
/** A cause that may clear alone is not raised again this soon after the card closed. */
export const OUTAGE_COOLDOWN_MS = 30 * 60 * 1000;

/** What a judge call came to, as far as the account's health goes. A call that was stopped says nothing. */
export type JudgeCallHealth =
  | { readonly kind: 'answered' }
  /** The judge is switched off, in Settings or at start: nothing is failing, and nothing is asked. */
  | { readonly kind: 'off' }
  | {
      readonly kind: 'failed';
      readonly reason: 'no_key' | 'timeout' | 'error';
      readonly detail: string;
      /** The model the call asked. */
      readonly model: string;
      /** The kind of account the call ran on; null when no credential was read. */
      readonly accountKind: JudgeCredential['kind'] | null;
      readonly taskId?: TaskId;
      readonly workstreamId?: WorkstreamId;
    };

/** Why the judge is down, in words a card can use. */
export interface JudgeOutage {
  /** The provider's name, or "the provider" when neither the account nor the error text names one. */
  readonly provider: string;
  /** The model the failing call asked. */
  readonly model: string;
  /** What is wrong, as a clause: "says the account has no credits". */
  readonly cause: string;
  /** What clears it, as a clause: "add credits or check the key on that account". */
  readonly fix: string;
  /**
   * The cause won't clear without the builder (no key, no credits, a refused or expired sign-in): the
   * sink raises a card at once. Otherwise it is a timeout or a 5xx that may clear alone: a notice.
   */
  readonly hard: boolean;
  readonly taskId?: TaskId;
  readonly workstreamId?: WorkstreamId;
}

/**
 * Where an outage is told: an Inbox card for a hard cause, resolved when the judge answers, and an
 * Activity notice for a transient one.
 */
export interface JudgeOutageSink {
  raise(outage: JudgeOutage): void;
  /** Closes the outage's card; called on the first answer after a failure, and once after a start. */
  clear(): void;
}

const PROVIDERS = ['OpenRouter', 'Anthropic', 'Bedrock'] as const;
const HARD_STATUS_402 = /\bHTTP 402\b/;
const HARD_STATUS_AUTH = /\bHTTP (401|403)\b/;
/** Anthropic answers an empty balance with a 400 whose message says so. */
const CREDIT_BALANCE = /credit balance is too low/i;
/** The SDK's error names for an expired or missing AWS sign-in carry no status. */
const BEDROCK_SIGN_IN = /CredentialsProviderError|ExpiredToken|SSO session|Token has expired/i;

const PROVIDER_NAMES = {
  [AccountKind.OpenRouter]: 'OpenRouter',
  [AccountKind.AnthropicApiKey]: 'Anthropic',
  [AccountKind.Bedrock]: 'Bedrock',
} as const satisfies Record<JudgeCredential['kind'], (typeof PROVIDERS)[number]>;

/** The account's provider, else the one the error text names. */
function providerOf(failure: Extract<JudgeCallHealth, { kind: 'failed' }>): string {
  if (failure.accountKind !== null) return PROVIDER_NAMES[failure.accountKind];
  return PROVIDERS.find((name) => failure.detail.includes(name)) ?? 'the provider';
}

/** What a failure says about the provider and what the builder can do; `hard` ones will not fix themselves. */
function causeOf(failure: Extract<JudgeCallHealth, { kind: 'failed' }>): {
  provider: string;
  cause: string;
  fix: string;
  hard: boolean;
} {
  const { detail } = failure;
  const provider = providerOf(failure);
  const fixKey = 'check the key on that account';
  if (failure.reason === 'no_key')
    return {
      provider,
      cause: 'has no key for the Decisions account',
      fix: 'add the key in Settings › Accounts',
      hard: true,
    };
  if (HARD_STATUS_402.test(detail) || CREDIT_BALANCE.test(detail))
    return {
      provider,
      cause: 'says the account has no credits',
      fix: `add credits or ${fixKey}`,
      hard: true,
    };
  if (provider === 'Bedrock' && (BEDROCK_SIGN_IN.test(detail) || HARD_STATUS_AUTH.test(detail)))
    return {
      provider,
      cause: detail.includes('403')
        ? 'refused the request (model access or permissions)'
        : "can't sign in with the AWS profile",
      fix: 'refresh the AWS profile (sign in again) and check the model is enabled for it',
      hard: true,
    };
  const refused = HARD_STATUS_AUTH.exec(detail)?.[1];
  if (refused === '401') return { provider, cause: 'rejected the key', fix: fixKey, hard: true };
  if (refused === '403')
    return {
      provider,
      cause: 'refused the request',
      fix: `${fixKey}, or pick another model`,
      hard: true,
    };
  return {
    provider,
    cause: `keeps failing (${detail})`,
    fix: 'check the provider and the account',
    hard: false,
  };
}

/**
 * Turns the judge's calls into one outage: the first failure of a run is logged at warn, and a failure
 * that won't clear on its own, most calls failing over `OUTAGE_WINDOW_MS` (at least `OUTAGE_FAILURES` of
 * them), or failing for `OUTAGE_SILENCE_MS` with no answer between, tells the sink once. A tail of slow
 * answers among many good ones raises nothing. The card closes after `OUTAGE_RECOVERY_ANSWERS` answers in a
 * row; no cause is raised again within `OUTAGE_COOLDOWN_MS` of that.
 */
export function createJudgeOutageWatch(deps: {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly sink: JudgeOutageSink;
}): (health: JudgeCallHealth) => void {
  // Each call's time and whether it answered, oldest first, for the window's failure rate.
  const calls: { readonly at: number; readonly ok: boolean }[] = [];
  const note = (ok: boolean): void => {
    const now = deps.clock.now().getTime();
    calls.push({ at: now, ok });
    while (
      calls.length > WINDOW_CALLS_MAX ||
      (calls[0] !== undefined && now - calls[0].at > OUTAGE_WINDOW_MS)
    )
      calls.shift();
  };
  let failures = 0;
  let failingSince = 0;
  let warned = false;
  let raised = false;
  let raisedHard = false;
  let answersSinceRaise = 0;
  let clearedAt: number | null = null;
  // A card left open by a daemon that stopped during an outage is looked for once, at the first answer.
  let checkedAtStart = false;

  const close = (): void => {
    deps.sink.clear();
    raised = false;
    raisedHard = false;
    answersSinceRaise = 0;
    clearedAt = deps.clock.now().getTime();
  };

  return (health) => {
    try {
      if (health.kind === 'off') {
        failures = 0;
        warned = false;
        calls.length = 0;
        if (raised || !checkedAtStart) close();
        checkedAtStart = true;
        return;
      }
      if (health.kind === 'answered') {
        note(true);
        failures = 0;
        warned = false;
        if (raised) {
          answersSinceRaise += 1;
          if (answersSinceRaise >= OUTAGE_RECOVERY_ANSWERS) close();
        } else if (!checkedAtStart) {
          deps.sink.clear();
        }
        checkedAtStart = true;
        return;
      }
      const now = deps.clock.now().getTime();
      note(false);
      if (failures === 0) failingSince = now;
      failures += 1;
      answersSinceRaise = 0;
      const { provider, cause, fix, hard } = causeOf(health);
      if (!warned) {
        warned = true;
        deps.logger.warn(
          { provider, detail: health.detail, reason: health.reason },
          "10db's judge is failing; the rules decide until it answers again",
        );
      }
      // A transient outage already told as a notice doesn't hide a hard cause that follows it.
      if (raised && (raisedHard || !hard)) return;
      const failed = calls.filter((c) => !c.ok).length;
      const mostFail = failed >= OUTAGE_FAILURES && failed > calls.length - failed;
      const lasting = mostFail || now - failingSince >= OUTAGE_SILENCE_MS;
      const cooling = clearedAt !== null && now - clearedAt < OUTAGE_COOLDOWN_MS;
      if (!raised && (cooling || (!hard && !lasting))) return;
      raised = true;
      raisedHard = hard;
      deps.sink.raise({
        provider,
        model: health.model,
        cause,
        fix,
        hard,
        ...(health.taskId === undefined ? {} : { taskId: health.taskId }),
        ...(health.workstreamId === undefined ? {} : { workstreamId: health.workstreamId }),
      });
    } catch (error) {
      // Telling the builder must never break a decision, which has its own answer already.
      deps.logger.error({ err: error }, 'judge outage watch failed');
    }
  };
}
