import { RoutedBy, SendState, type InboxItemDto } from '@10db/contracts';
import { z } from 'zod';

/**
 * Whether a card that just opened is worth a notification: not one triage is still placing, and not one
 * that went straight out to someone, since neither needs the builder.
 */
export function shouldNotifyOpened(item: InboxItemDto): boolean {
  if (item.routedBy === RoutedBy.TriagePending) return false;
  return item.send?.state !== SendState.Sent && item.send?.state !== SendState.Sending;
}

const TriagedData = z.object({ toBuilder: z.boolean() });

/** Whether triage left a card with the builder, which is when it becomes worth a notification. */
export function triagedToBuilder(data: unknown): boolean {
  const parsed = TriagedData.safeParse(data);
  return parsed.success && parsed.data.toBuilder;
}

const AnsweredData = z.object({ inboxItemId: z.string(), state: z.string() });

/** The words of a notification: a title and what the question was. */
export interface Notice {
  readonly title: string;
  readonly body: string;
}

function joinNames(names: readonly string[]): string {
  const last = names.at(-1);
  if (last === undefined) return '';
  return names.length === 1 ? last : `${names.slice(0, -1).join(', ')} and ${last}`;
}

const recipientNames = (item: InboxItemDto): string[] =>
  item.send?.people.filter((p) => p.recipient).map((p) => p.name) ?? [];

/**
 * "Mark answered: <question>" for a send-changed event that says a stakeholder answered, looking the card
 * up in the Open cards the client already holds (the refetch that follows has not replaced them yet).
 */
export function answeredNotice(data: unknown, open: readonly InboxItemDto[]): Notice | null {
  const parsed = AnsweredData.safeParse(data);
  if (!parsed.success || parsed.data.state !== SendState.Answered) return null;
  const item = open.find((card) => card.id === parsed.data.inboxItemId);
  if (!item) return null;
  const names = recipientNames(item);
  return names.length === 0 ? null : { title: `${joinNames(names)} answered`, body: item.title };
}

/** "Mark and Ana disagree: <question>" for each card whose recipients disagreed since `before`. */
export function disagreementNotices(
  before: readonly InboxItemDto[],
  now: readonly InboxItemDto[],
): Notice[] {
  return now.flatMap((item) => {
    if (item.send?.returnedReason !== 'disagreed') return [];
    const was = before.find((card) => card.id === item.id);
    if (was === undefined || was.send?.returnedReason === 'disagreed') return [];
    return [{ title: `${joinNames(recipientNames(item))} disagree`, body: item.title }];
  });
}
