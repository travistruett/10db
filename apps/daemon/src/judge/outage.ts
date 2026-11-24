import type { TaskId, WorkstreamId } from '@10db/contracts';
import type { Clock } from '../clock';
import type { Logger } from '../log';

/** Failures in a row, with no answer between, that make a flaky provider an outage: a blip is one or two. */
export const OUTAGE_FAILURES = 5;
/** Failing this long with no answer is an outage however few calls were made. */
export const OUTAGE_DURATION_MS = 10 * 60 * 1000;
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
      readonly taskId?: TaskId;
      readonly workstreamId?: WorkstreamId;
    };

/** Why the judge is down, in words a card can use. */
export interface JudgeOutage {
  /** The provider's name, or "the provider" when the error text names none. */
  readonly provider: string;
  /** What is wrong, as a clause: "says the account has no credits". */
  readonly cause: string;
  /** What clears it, as a clause: "add credits or check the key on that account". */
  readonly fix: string;
  readonly taskId?: TaskId;
  readonly workstreamId?: WorkstreamId;
}

/** Where an outage is told: the Inbox card, raised once and resolved when the judge answers. */
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

function providerOf(detail: string): string {
  return PROVIDERS.find((name) => detail.includes(name)) ?? 'the provider';
}

/** What a failure says about the provider and what the builder can do; `hard` ones will not fix themselves. */
function causeOf(failure: Extract<JudgeCallHealth, { kind: 'failed' }>): {
  provider: string;
  cause: string;
  fix: string;
  hard: boolean;
} {
  const { detail } = failure;
  const provider = providerOf(detail);
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
 * that won't clear on its own, or `OUTAGE_FAILURES` failures in a row (or failing for `OUTAGE_DURATION_MS`)
 * with no answer between, tells the sink once. The card closes after `OUTAGE_RECOVERY_ANSWERS` answers in a
 * row; no cause is raised again within `OUTAGE_COOLDOWN_MS` of that.
 */
export function createJudgeOutageWatch(deps: {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly sink: JudgeOutageSink;
}): (health: JudgeCallHealth) => void {
  let failures = 0;
  let failingSince = 0;
  let warned = false;
  let raised = false;
  let answersSinceRaise = 0;
  let clearedAt: number | null = null;
  // A card left open by a daemon that stopped during an outage is looked for once, at the first answer.
  let checkedAtStart = false;

  const close = (): void => {
    deps.sink.clear();
    raised = false;
    answersSinceRaise = 0;
    clearedAt = deps.clock.now().getTime();
  };

  return (health) => {
    try {
      if (health.kind === 'off') {
        failures = 0;
        warned = false;
        if (raised || !checkedAtStart) close();
        checkedAtStart = true;
        return;
      }
      if (health.kind === 'answered') {
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
      if (raised) return;
      const lasting = failures >= OUTAGE_FAILURES || now - failingSince >= OUTAGE_DURATION_MS;
      const cooling = clearedAt !== null && now - clearedAt < OUTAGE_COOLDOWN_MS;
      if (cooling || (!hard && !lasting)) return;
      raised = true;
      deps.sink.raise({
        provider,
        cause,
        fix,
        ...(health.taskId === undefined ? {} : { taskId: health.taskId }),
        ...(health.workstreamId === undefined ? {} : { workstreamId: health.workstreamId }),
      });
    } catch (error) {
      // Telling the builder must never break a decision, which has its own answer already.
      deps.logger.error({ err: error }, 'judge outage watch failed');
    }
  };
}
