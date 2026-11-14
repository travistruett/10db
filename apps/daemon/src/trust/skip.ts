import type { LimitName, SkipKind } from '@10db/contracts';

// Trust line §5: what an unattended lane is told when a call is skipped, and the line that hands a
// skipped call back to auto mode once the builder approves it.

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

/** What an unattended lane's question is answered with. */
export const AWAY_ANSWER =
  'The builder is away. Make the call yourself and say in your handoff what you decided and why.';

/** What a turn skipped so far: whether its last call was skipped, and that skip. */
export interface TurnSkips {
  readonly lastCallSkipped: boolean;
  readonly last: { readonly limit: LimitName | null; readonly reason: string } | null;
  readonly skips: number;
}

/** How many times a step's turn a skip stopped is resumed, per start of the run. */
export const SKIP_RESUMES_MAX = 2;

/** A turn whose last call was skipped stopped because of it. */
export const stoppedBySkip = (turn: TurnSkips): boolean => turn.lastCallSkipped;

/** A call the builder approved after the run that skipped it. */
export interface ApprovedAction {
  readonly summary: string;
  /** The skip cut its summary: the builder never saw the whole call. */
  readonly cut: boolean;
  readonly reason: string;
  readonly limit: LimitName | null;
  readonly kind: SkipKind;
}

/** The longest call an allow line names; a longer one is never handed back by intent. */
const APPROVED_LINE_MAX = 300;

/**
 * The allow line an approved classifier denial goes back as: the call and its reason quoted as JSON,
 * so nothing the agent wrote reads as a rule of its own. An approval covers what the builder saw and
 * no more, so a call cut short, or longer than a line holds, gives none.
 */
export function approvedLine(a: ApprovedAction): string | null {
  if (a.cut || a.summary.length > APPROVED_LINE_MAX) return null;
  const quoted = JSON.stringify(a.summary);
  const reason = JSON.stringify(a.reason.slice(0, 200));
  return `Approved By The Builder: the call ${quoted}, skipped earlier because ${reason}, is approved as written.`;
}
