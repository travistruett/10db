import {
  AcceptanceDetail,
  AcceptanceVerdict,
  InboxKind,
  WatchpointCardDetail,
  type InboxItemDto,
} from '@10db/contracts';
import { isPrincipleCard } from './permission-labels';

/** What the card's own state adds to its line: facts the card's data alone does not hold. */
export interface DecisionFacts {
  /** The commits a check card's work holds, once they are read. */
  readonly commits?: number | null;
  /** The batch answers a not-shipped flag offers. */
  readonly batch?: { readonly retry: boolean; readonly abandon: boolean };
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

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

const listOf = (names: readonly string[]): string =>
  names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`
    : (names[0] ?? '');

function acceptanceLine(item: InboxItemDto): string {
  const { unmet, extra } = acceptanceCounts(item);
  const shipped =
    item.detail?.['reviewFollows'] === true ? 'The work went on to review.' : 'Already shipped.';
  const counts = `${plural(unmet, 'criterion', 'criteria')} unconfirmed${extra ? ', 1 extra behaviour' : ''}.`;
  return `${shipped} ${counts} Keep As Is changes nothing; Send Back files a fix task.`;
}

function watchpointLine(item: InboxItemDto): string {
  const detail = WatchpointCardDetail.safeParse(item.detail);
  const areas = detail.success ? listOf(detail.data.watchpoints.map((w) => w.label)) : '';
  return `Touched ${areas === '' ? 'an area' : areas}, which you asked to see. Nothing is waiting on this.`;
}

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
  return item.options.length === 0 ? 'Dismiss only hides this card.' : null;
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
      return watchpointLine(item);
    case InboxKind.Check:
      return `${facts.commits === undefined || facts.commits === null ? 'The work is ready' : `${plural(facts.commits, 'commit', 'commits')} ready`}. Approve and Finish lands it and finishes the task.`;
    case InboxKind.Plan:
      return 'Approve starts the build. Re-plan sends it back with your note.';
    case InboxKind.Proposal:
      return isPrincipleCard(item) ? 'Accepting adds a rule.' : 'Accepting creates a task.';
    case InboxKind.Flag:
      return flagLine(item, facts);
    // Their options already name their effect.
    case InboxKind.Permission:
    case InboxKind.Question:
    case InboxKind.Review:
    case InboxKind.PlaybookMoveReport:
      return null;
  }
}
