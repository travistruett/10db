import {
  AcceptanceDetail,
  AcceptanceVerdict,
  InboxKind,
  ProposalKind,
  type InboxItemDto,
} from '@10db/contracts';
import { isPrincipleCard } from './permission-labels';

/** What the card's own state adds to its line: facts the card's data alone does not hold. */
export interface DecisionFacts {
  /** The batch answers a not-shipped flag offers. */
  readonly batch?: { readonly retry: boolean; readonly abandon: boolean };
  /** The flag closes itself when what it reports clears, so it has no Dismiss. */
  readonly closesItself?: boolean;
  /** How many cards a folded flag stands for; its Dismiss is Dismiss All above one. */
  readonly count?: number;
}

/** The unmet criteria an acceptance card lists, and whether it names something the task didn't ask for. */
export function acceptanceCounts(item: InboxItemDto): { unmet: number; extra: boolean } {
  const detail = AcceptanceDetail.safeParse(item.detail);
  if (!detail.success) return { unmet: 0, extra: false };
  return {
    unmet: detail.data.criteria.filter((c) => c.verdict !== AcceptanceVerdict.Met).length,
    extra: detail.data.unasked !== null,
  };
}

/** The card's header already counts the criteria, so the line says only where the work is and what the answers do. */
function acceptanceLine(item: InboxItemDto): string {
  const shipped =
    item.detail?.['reviewFollows'] === true ? 'The work went on to review.' : 'Already shipped.';
  return `${shipped} Keep As Is changes nothing; Send Back files a fix task.`;
}

/** The card's body already names the areas the change touched, so the line says only what the answers do. */
const WATCHPOINT_LINE =
  'Nothing is waiting on this. Looks Right closes it; Send Back files a follow-up task.';

function flagLine(item: InboxItemDto, facts: DecisionFacts): string | null {
  const { retry, abandon } = facts.batch ?? { retry: false, abandon: false };
  if (retry || abandon) {
    return [
      retry ? 'Retry ships the batch again.' : null,
      abandon ? 'Abandon gives up on it.' : null,
    ]
      .filter((clause) => clause !== null)
      .join(' ');
  }
  if (facts.closesItself === true || item.options.length > 0) return null;
  return (facts.count ?? 1) > 1 ? 'Dismiss All only hides these cards.' : DISMISS_LINE;
}

const DISMISS_LINE = 'Dismiss only hides this card.';

/** Only a new-task proposal files a task when accepted; a card that does not say its kind gets no line. */
function proposalLine(item: InboxItemDto): string | null {
  if (isPrincipleCard(item)) return 'Accepting adds a rule.';
  return item.detail?.['proposalKind'] === ProposalKind.NewTask
    ? 'Accepting creates a task.'
    : null;
}

/**
 * The sentence by a card's buttons saying what its answers do, built from the card's kind and counts, never
 * from the agent's words. Null where the options already name their effect.
 */
export function decisionLine(item: InboxItemDto, facts: DecisionFacts = {}): string | null {
  switch (item.kind) {
    case InboxKind.Acceptance:
      return acceptanceLine(item);
    case InboxKind.Watchpoint:
      return WATCHPOINT_LINE;
    case InboxKind.Check:
      // The card's body says how many commits are ready.
      return 'Approve and Finish lands the work and finishes the task.';
    case InboxKind.Plan:
      return 'Approve starts the build. Re-plan sends it back with your note.';
    case InboxKind.Proposal:
      return proposalLine(item);
    case InboxKind.Flag:
      return flagLine(item, facts);
    // Their options already name their effect.
    case InboxKind.Permission:
    case InboxKind.Question:
    case InboxKind.Review:
      return null;
    case InboxKind.PlaybookMoveReport:
      return DISMISS_LINE;
  }
}
