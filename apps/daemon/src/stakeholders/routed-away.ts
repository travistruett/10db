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
