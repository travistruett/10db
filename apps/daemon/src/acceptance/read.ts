import { AcceptanceVerdict, type AcceptanceCriterionResult } from '@10db/contracts';
import { proofNeedsHands } from './hands';

/** Under one half a criterion could read both met and not met at once. */
const FLOOR_MIN = 0.5;

const ACCEPTED_NOTE = 'accepted by the builder';

/** What `unasked` says when the check saw only a likelihood of unrequested behaviour, never what it is. */
export const UNASKED_NO_DETAIL = "The change may do something the task didn't ask for.";

/**
 * What a card says the change may do beyond the task, or null when the reading carries no description (a card
 * line with nothing after the colon is noise). A stored reading may still end in its score, "(0.97)".
 */
export function unaskedDescription(unasked: string | null): string | null {
  if (unasked === null) return null;
  const text = unasked.replace(/\s*\(\d(?:\.\d+)?\)(?=\.?$)/, '').trim();
  const bare = (t: string): string => t.replace(/\.$/, '');
  return text === '' || bare(text) === bare(UNASKED_NO_DETAIL) ? null : text;
}

type Probabilities = Readonly<Record<string, number>> | null;

const clamped = (floor: number): number => Math.max(floor, FLOOR_MIN);

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
 * above its floor, not met at or below one minus it, unclear between. A criterion reads not met only when the second
 * call also found the change enough to judge it either way (`judgeable` at its floor, or not asked): a result 10db
 * didn't see can't be not met. A call that gave no answer leaves what it was asked unread.
 */
export function readAcceptance(input: {
  criteria: readonly string[];
  accepted: ReadonlySet<string>;
  first: Probabilities;
  second: Probabilities;
  /** The second call's answers to whether each criterion can be judged from the change; null when not asked. */
  judgeable: Probabilities;
  firstFloor: number;
  secondFloor: number;
}): AcceptanceCriterionResult[] {
  const f2 = clamped(input.secondFloor);
  const asked = new Set(
    secondQuestions(input.criteria, input.accepted, input.first, input.firstFloor),
  );
  return input.criteria.map((criterion) => {
    if (input.accepted.has(criterion))
      return result(criterion, AcceptanceVerdict.Met, ACCEPTED_NOTE);
    if (!asked.has(criterion)) {
      return result(criterion, AcceptanceVerdict.Met, 'read as met');
    }
    const p = input.second?.[criterion];
    if (p === undefined) return result(criterion, AcceptanceVerdict.Unread, 'no answer');
    // 1 − p is compared to the floor, so a probability of exactly 1 − f is read as not met in floating point.
    if (p >= f2) return result(criterion, AcceptanceVerdict.Met, 'read as met');
    if (1 - p >= f2) {
      const j = input.judgeable?.[criterion];
      if (j !== undefined && j < f2)
        return result(criterion, AcceptanceVerdict.Unclear, "can't be judged from the change");
      return result(criterion, AcceptanceVerdict.NotMet, 'read as not met');
    }
    return result(criterion, AcceptanceVerdict.Unclear, 'unclear');
  });
}

export const AcceptanceMove = {
  GoOn: 'go_on',
  SendBack: 'send_back',
  GoOnWithCard: 'go_on_with_card',
} as const;
export type AcceptanceMove = (typeof AcceptanceMove)[keyof typeof AcceptanceMove];

/**
 * The results that are unproven: not met, or unclear where no Review follows to read it (a Review reads an
 * unclear criterion itself, unless only the builder can prove it). Unread never counts: the call that would have
 * read it gave no answer.
 */
export function unprovenResults(
  results: readonly AcceptanceCriterionResult[],
  reviewFollows: boolean,
): AcceptanceCriterionResult[] {
  return results.filter(
    (r) =>
      r.verdict === AcceptanceVerdict.NotMet ||
      (r.verdict === AcceptanceVerdict.Unclear &&
        (!reviewFollows || proofNeedsHands(r.criterion) !== null)),
  );
}

/**
 * What the run does next. An unproven criterion goes back for proof while the fix budget lasts, with no card; the
 * budget spent leaves one card, and nothing here ever accepts the criterion: only the builder's answer to that card
 * does. A criterion only the builder can prove (`proofNeedsHands`) is not sent back, since no round could prove it:
 * it leaves its card at once, unless another unproven one still has a round to use first.
 */
export function acceptanceMove(input: {
  results: readonly AcceptanceCriterionResult[];
  reviewFollows: boolean;
  atLimit: boolean;
}): AcceptanceMove {
  const unproven = unprovenResults(input.results, input.reviewFollows);
  if (unproven.length === 0) return AcceptanceMove.GoOn;
  const sessionCanProve = unproven.some((r) => proofNeedsHands(r.criterion) === null);
  return sessionCanProve && !input.atLimit ? AcceptanceMove.SendBack : AcceptanceMove.GoOnWithCard;
}
