import { AcceptanceVerdict, type AcceptanceCriterionResult } from '@10db/contracts';

/** Under one half a criterion could read both met and not met at once. */
const FLOOR_MIN = 0.5;

const ACCEPTED_NOTE = 'accepted by the builder';

type Probabilities = Readonly<Record<string, number>> | null;

const clamped = (floor: number): number => Math.max(floor, FLOOR_MIN);

const pct = (p: number): string => p.toFixed(2);

/**
 * The criteria the second call is asked about: every one the builder hasn't accepted that the first call did not
 * read as met. With no first answer (a fallback) that is every one not accepted.
 */
export function secondQuestions(
  criteria: readonly string[],
  accepted: ReadonlySet<string>,
  first: Probabilities,
  floor: number,
): string[] {
  const f = clamped(floor);
  return criteria.filter((criterion) => {
    if (accepted.has(criterion)) return false;
    const p = first?.[criterion];
    return p === undefined || p < f;
  });
}

function result(
  criterion: string,
  verdict: AcceptanceVerdict,
  note: string,
): AcceptanceCriterionResult {
  return { criterion, verdict, note };
}

/**
 * Each criterion's verdict. The first call settles a criterion only as met; the second reads the rest: met at or
 * above its floor, not met at or below one minus it, unclear between. A call that gave no answer leaves what it was
 * asked unread.
 */
export function readAcceptance(input: {
  criteria: readonly string[];
  accepted: ReadonlySet<string>;
  first: Probabilities;
  second: Probabilities;
  firstFloor: number;
  secondFloor: number;
}): AcceptanceCriterionResult[] {
  const f1 = clamped(input.firstFloor);
  const f2 = clamped(input.secondFloor);
  const asked = new Set(
    secondQuestions(input.criteria, input.accepted, input.first, input.firstFloor),
  );
  return input.criteria.map((criterion) => {
    if (input.accepted.has(criterion))
      return result(criterion, AcceptanceVerdict.Met, ACCEPTED_NOTE);
    if (!asked.has(criterion)) {
      const p = input.first?.[criterion] ?? f1;
      return result(criterion, AcceptanceVerdict.Met, `read as met (${pct(p)}, first read)`);
    }
    const p = input.second?.[criterion];
    if (p === undefined) return result(criterion, AcceptanceVerdict.Unread, 'no answer');
    // 1 − p is compared to the floor, so a probability of exactly 1 − f is read as not met in floating point.
    if (p >= f2)
      return result(criterion, AcceptanceVerdict.Met, `read as met (${pct(p)}, second opinion)`);
    if (1 - p >= f2)
      return result(
        criterion,
        AcceptanceVerdict.NotMet,
        `read as not met (${pct(p)}, second opinion)`,
      );
    return result(criterion, AcceptanceVerdict.Unclear, `unclear (${pct(p)}, second opinion)`);
  });
}

export const AcceptanceMove = {
  GoOn: 'go_on',
  SendBack: 'send_back',
  GoOnWithCard: 'go_on_with_card',
} as const;
export type AcceptanceMove = (typeof AcceptanceMove)[keyof typeof AcceptanceMove];

/**
 * What the run does next: a criterion not met sends it back while rounds remain; at the limit, or with an unclear
 * one and no Review to read it, it goes on and leaves one card; else it goes on. Unread never counts against it.
 */
export function acceptanceMove(input: {
  results: readonly AcceptanceCriterionResult[];
  reviewFollows: boolean;
  atLimit: boolean;
}): AcceptanceMove {
  const has = (v: AcceptanceVerdict): boolean => input.results.some((r) => r.verdict === v);
  if (has(AcceptanceVerdict.NotMet))
    return input.atLimit ? AcceptanceMove.GoOnWithCard : AcceptanceMove.SendBack;
  if (has(AcceptanceVerdict.Unclear) && !input.reviewFollows) return AcceptanceMove.GoOnWithCard;
  return AcceptanceMove.GoOn;
}
