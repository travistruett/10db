import type { LimitName, SkipKind } from '@10db/contracts';

// Trust line §5: what an unattended lane is told when a call is skipped, and the line that hands a
// skipped call back to auto mode once the builder approves it.

/** How many times a turn a skip stopped is resumed in one step (T4 call 10). */
export const SKIP_RESUMES_MAX = 2;

const LIMIT_VERBS: Readonly<Record<LimitName, string>> = {
  destroys_data: "destroy data this session didn't create",
  sends_data_out: 'send data out',
  reads_secrets: 'read secrets',
  writes_live: 'write to a live system',
};

const CARRY_ON = 'Carry on without it and say in your handoff what you skipped.';

/** What the agent is told in place of the call: the limit it would cross, else the reason. */
export function skipMessage(limit: LimitName | null, reason: string): string {
  return limit === null
    ? `Skipped: ${reason} ${CARRY_ON}`
    : `Skipped: this would ${LIMIT_VERBS[limit]}. ${CARRY_ON}`;
}

/** What an unattended lane's question is answered with (T4 call 21). */
export const AWAY_ANSWER =
  'The builder is away. Make the call yourself and say in your handoff what you decided and why.';

/** What a turn skipped so far: whether its last call was skipped, and that skip. */
export interface TurnSkips {
  readonly lastCallSkipped: boolean;
  readonly last: { readonly limit: LimitName | null; readonly reason: string } | null;
  readonly skips: number;
}

/** A turn whose last call was skipped stopped because of it (T4 call 10). */
export const stoppedBySkip = (turn: TurnSkips): boolean => turn.lastCallSkipped;

/** A call the builder approved after the run that skipped it. */
export interface ApprovedAction {
  readonly summary: string;
  readonly reason: string;
  readonly limit: LimitName | null;
  readonly kind: SkipKind;
}

/**
 * The allow line an approved classifier denial goes back as: the call and its reason quoted as JSON,
 * so nothing the agent wrote reads as a rule of its own, and cut so a long one stays a line.
 */
export function approvedLine(a: ApprovedAction): string {
  const quoted = JSON.stringify(a.summary.slice(0, 300));
  const reason = JSON.stringify(a.reason.slice(0, 200));
  return `Approved By The Builder: the call ${quoted}, skipped earlier because ${reason}. A call with the same intent is approved, however it is written.`;
}
