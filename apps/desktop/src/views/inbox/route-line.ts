import {
  InboxKind,
  QuestionCategory,
  RoutedBy,
  SendState,
  type InboxItemDto,
  type PersonDto,
} from '@10db/contracts';

/** What the card shows for a question that may go to someone else. */
export const StakeholderMode = {
  /** Not a stakeholder card as far as the screen goes: today's card. */
  None: 'none',
  /** A question nobody was asked about; it offers Ask Someone. */
  Unrouted: 'unrouted',
  /** Triage is still choosing who answers. */
  Pending: 'pending',
  /** A drafted message waits for the builder's Send. */
  Draft: 'draft',
  /** A send that failed; Send tries again to the same people. */
  Failed: 'failed',
  /** Routed to people who are not in Slack: the builder copies the message to them. */
  Copy: 'copy',
} as const;
export type StakeholderMode = (typeof StakeholderMode)[keyof typeof StakeholderMode];

/** The people a card is routed to, other than the builder, in routing order. */
export function recipientsOf(item: InboxItemDto, people: readonly PersonDto[]): PersonDto[] {
  return item.assignees.flatMap((handle) => {
    const person = people.find((p) => p.handle === handle && !p.isBuilder);
    return person === undefined ? [] : [person];
  });
}

/** The people the builder asked who have no Slack: the daemon keeps such a card, and names them in `copyFor`. */
export function copyPeople(item: InboxItemDto, people: readonly PersonDto[]): PersonDto[] {
  return item.copyFor.flatMap((handle) => {
    const person = people.find((p) => p.handle === handle);
    return person === undefined ? [] : [person];
  });
}

export function stakeholderMode(item: InboxItemDto, people: readonly PersonDto[]): StakeholderMode {
  const copyFor = copyPeople(item, people);
  if (item.kind !== InboxKind.Question) return StakeholderMode.None;
  if (item.routedBy === RoutedBy.TriagePending) return StakeholderMode.Pending;
  if (item.send?.state === SendState.Draft) return StakeholderMode.Draft;
  if (item.send?.state === SendState.Failed) return StakeholderMode.Failed;
  // Sending, sent or answered: the Waiting tab and Resolved show it, not this card.
  if (item.send !== null && item.send.state !== SendState.Closed) return StakeholderMode.None;
  if (item.send === null && copyFor.length > 0 && copyFor.every((p) => p.slack === null))
    return StakeholderMode.Copy;
  const recipients = recipientsOf(item, people);
  if (recipients.length === 0) return StakeholderMode.Unrouted;
  return recipients.every((p) => p.slack === null)
    ? StakeholderMode.Copy
    : StakeholderMode.Unrouted;
}

/** "Mark", "Mark and Ana", "Mark, Ana and Lee". */
export function joinNames(names: readonly string[]): string {
  const last = names.at(-1);
  if (last === undefined) return '';
  return names.length === 1 ? last : `${names.slice(0, -1).join(', ')} and ${last}`;
}

const CATEGORY_WORDS: Readonly<Record<QuestionCategory, string>> = {
  [QuestionCategory.Product]: 'Product',
  [QuestionCategory.Design]: 'Design',
  [QuestionCategory.Engineering]: 'Engineering',
  [QuestionCategory.Business]: 'Business',
  [QuestionCategory.Access]: 'Access',
  [QuestionCategory.Other]: 'Other',
};

export function categoryWord(category: string): string {
  const found = Object.values(QuestionCategory).find((c) => c === category);
  return found === undefined ? category : CATEGORY_WORDS[found];
}

/** Why this person: the kind of question, who it goes to, and who chose them when it was not a rule. */
export function routeLine(
  item: InboxItemDto,
  people: readonly PersonDto[],
  /** Recipients the card itself does not name, such as people not in Slack. */
  named?: readonly PersonDto[],
): { readonly text: string; readonly pending: boolean } {
  if (item.routedBy === RoutedBy.TriagePending)
    return { text: 'Finding who answers…', pending: true };
  const names = (named ?? recipientsOf(item, people)).map((p) => p.name);
  const who = joinNames(names.length > 0 ? names : item.assignees);
  const by =
    named !== undefined
      ? ' · chosen by you'
      : item.routedBy === RoutedBy.Judge
        ? ' · chosen by Jev'
        : item.routedBy === RoutedBy.Builder
          ? ' · chosen by you'
          : '';
  return { text: `${categoryWord(item.category)} question → ${who}${by}`, pending: false };
}
