import type { TaskId, WorkstreamId } from '@10db/contracts';
import type { Clock } from '../clock';
import type { Logger } from '../log';

/** Failures in a row, inside `OUTAGE_WINDOW_MS`, that make a flaky provider an outage: a blip is one or two. */
export const OUTAGE_FAILURES = 5;
/** The window those failures must fall in; an older streak is a different, passed blip. */
export const OUTAGE_WINDOW_MS = 10 * 60 * 1000;

/** What a judge call came to, as far as the account's health goes. A call that was stopped says nothing. */
export type JudgeCallHealth =
  | { readonly kind: 'answered' }
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
const HARD_STATUS = /\bHTTP (401|402|403)\b/;

function providerOf(detail: string): string {
  return PROVIDERS.find((name) => detail.includes(name)) ?? 'the provider';
}

/** Whether the failure will not fix itself: a missing key, or the provider refusing the account. */
function causeOf(failure: Extract<JudgeCallHealth, { kind: 'failed' }>): {
  provider: string;
  cause: string;
  hard: boolean;
} {
  const provider = providerOf(failure.detail);
  if (failure.reason === 'no_key')
    return { provider, cause: 'has no key for the Decisions account', hard: true };
  const status = HARD_STATUS.exec(failure.detail)?.[1];
  if (status === '402') return { provider, cause: 'says the account has no credits', hard: true };
  if (status !== undefined)
    return {
      provider,
      cause: 'refused the key (check it belongs to the right account)',
      hard: true,
    };
  return { provider, cause: `keeps failing: ${failure.detail}`, hard: false };
}

/**
 * Turns the judge's calls into one outage: the first failure of a run is logged at warn, and a failure
 * that won't clear on its own, or `OUTAGE_FAILURES` of any kind within `OUTAGE_WINDOW_MS`, tells the sink
 * once. Nothing more is told while the judge stays down; its first answer clears it.
 */
export function createJudgeOutageWatch(deps: {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly sink: JudgeOutageSink;
}): (health: JudgeCallHealth) => void {
  let failures = 0;
  let streakStart = 0;
  let warned = false;
  let raised = false;
  // A card left open by a daemon that stopped during an outage is looked for once, at the first answer.
  let checkedAtStart = false;

  return (health) => {
    try {
      if (health.kind === 'answered') {
        failures = 0;
        warned = false;
        if (raised || !checkedAtStart) deps.sink.clear();
        raised = false;
        checkedAtStart = true;
        return;
      }
      const now = deps.clock.now().getTime();
      if (failures === 0 || now - streakStart > OUTAGE_WINDOW_MS) {
        failures = 0;
        streakStart = now;
      }
      failures += 1;
      const { provider, cause, hard } = causeOf(health);
      if (!warned) {
        warned = true;
        deps.logger.warn(
          { provider, detail: health.detail, reason: health.reason },
          "10db's judge is failing; the rules decide until it answers again",
        );
      }
      if (raised || (!hard && failures < OUTAGE_FAILURES)) return;
      raised = true;
      deps.sink.raise({
        provider,
        cause,
        ...(health.taskId === undefined ? {} : { taskId: health.taskId }),
        ...(health.workstreamId === undefined ? {} : { workstreamId: health.workstreamId }),
      });
    } catch (error) {
      // Telling the builder must never break a decision, which has its own answer already.
      deps.logger.error({ err: error }, 'judge outage watch failed');
    }
  };
}
