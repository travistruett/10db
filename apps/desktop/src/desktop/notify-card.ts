import { SendState, type InboxItemDto } from '@10db/contracts';
import { z } from 'zod';

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

const ASKED_BODY_LIMIT = 200;

/** "Mark asked" for each card whose send holds a question newer than any it held at `before`. */
export function askedNotices(
  before: readonly InboxItemDto[],
  now: readonly InboxItemDto[],
): Notice[] {
  return now.flatMap((item) => {
    const asked = item.send?.asked;
    if (asked === null || asked === undefined) return [];
    const was = before.find((card) => card.id === item.id);
    // A card first seen with its question already on it was seen before this run; only a change notifies.
    if (was === undefined || was.send?.asked?.ts === asked.ts) return [];
    return [{ title: `${asked.name} asked`, body: asked.text.slice(0, ASKED_BODY_LIMIT) }];
  });
}
