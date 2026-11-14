import { InboxKind, RoutedBy, type InboxItemDto } from '@10db/contracts';
import { BUILDER_HANDLE } from '@10db/db';

/**
 * Whether a question card goes to someone other than the builder, so its sessions park at once. A card still
 * waiting for triage is the builder's until it is routed.
 */
export function routedAway(card: Pick<InboxItemDto, 'kind' | 'routedBy' | 'assignees'>): boolean {
  return (
    card.kind === InboxKind.Question &&
    card.routedBy !== RoutedBy.TriagePending &&
    card.assignees.some((handle) => handle !== BUILDER_HANDLE)
  );
}

/**
 * Whether triage left a question with the builder alone, naming no one else. A card routed to a
 * person, even one it then hands back to the builder for want of Slack, is not: that person's answer
 * is what its lane waits for.
 */
export function keptWithBuilder(card: Pick<InboxItemDto, 'kind' | 'assignees'>): boolean {
  return (
    card.kind === InboxKind.Question && card.assignees.every((handle) => handle === BUILDER_HANDLE)
  );
}
