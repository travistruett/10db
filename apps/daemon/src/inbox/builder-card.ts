import { InboxKind, RoutedBy, type InboxItemDto } from '@10db/contracts';
import { BUILDER_HANDLE } from '@10db/db';

/**
 * Whether a question card is the builder's alone once routed: triage or a rule named no one else, or
 * the draft handed a person's card back for want of Slack. A lane nobody watches never waits on one,
 * so it is answered at once. A card still waiting for triage is not yet anyone's.
 */
export function leftWithBuilder(
  card: Pick<InboxItemDto, 'kind' | 'routedBy' | 'assignees'>,
): boolean {
  return (
    card.kind === InboxKind.Question &&
    card.routedBy !== RoutedBy.TriagePending &&
    card.assignees.every((handle) => handle === BUILDER_HANDLE)
  );
}
