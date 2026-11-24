import { z } from 'zod';
import type { InboxItemDto } from './entities';
import { CARD_CLOSES_ITSELF } from './card-resolution';
import { InboxItemId, PassId } from './ids';
// A type only: inbox-page.ts imports this module's schemas, so a value import would be a cycle.
import type { InboxListState } from './inbox-page';
import { PassCheckDetail } from './passes';
import { InboxKind, Urgency } from './states';

const Timestamp = z.iso.datetime();

/** What the row rules read of a card. */
export type InboxRowCard = Pick<
  InboxItemDto,
  'id' | 'kind' | 'projectId' | 'title' | 'body' | 'options' | 'detail'
>;

/**
 * A flag or a move report with no options closes on any answer, so it can be dismissed without opening it.
 * A condition card, which closes on an event (`detail.closesItself`), is never dismissed.
 */
export function isDismissable(card: Pick<InboxItemDto, 'kind' | 'options' | 'detail'>): boolean {
  return (
    (card.kind === InboxKind.Flag || card.kind === InboxKind.PlaybookMoveReport) &&
    card.options.length === 0 &&
    card.detail?.[CARD_CLOSES_ITSELF] !== true
  );
}

/** The pass of a Ready page's `check` card, or null for any other card. */
export function readyPassOf(card: InboxRowCard): PassId | null {
  if (card.kind !== InboxKind.Check) return null;
  const detail = PassCheckDetail.safeParse(card.detail);
  return detail.success ? detail.data.passId : null;
}

/**
 * The row a card belongs to: a pass's Ready pages share one, and so do dismissable flags of one project with
 * the same kind, title and body (so a kind filter never cuts a row); every other card, a failed turn's flag included, has its own. The key stays the
 * same while members leave the row.
 */
export function inboxRowKey(card: InboxRowCard): string {
  const passId = readyPassOf(card);
  if (passId !== null) return `pass:${passId}`;
  if (isDismissable(card))
    return `flags:${JSON.stringify([card.projectId, card.kind, card.title, card.body])}`;
  return card.id;
}

/** Where a row sorts: a rank, a timestamp (or '') and the card's id as the final tie-break. */
export const InboxRowSort = z.tuple([z.int().min(0), z.string(), InboxItemId]);
export type InboxRowSort = z.infer<typeof InboxRowSort>;

export interface SortCard {
  readonly id: InboxItemId;
  readonly urgency: Urgency;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sentAt: string | null;
}

const URGENCY_RANK: Record<Urgency, number> = {
  [Urgency.High]: 0,
  [Urgency.Normal]: 1,
  [Urgency.Low]: 2,
};

/** The sort key of a card in one list: the order the list shows, as a tuple the keyset page resumes from. */
export function inboxRowSort(state: InboxListState, card: SortCard): InboxRowSort {
  switch (state) {
    case 'open':
      return [URGENCY_RANK[card.urgency], card.createdAt, card.id];
    case 'waiting':
      return [card.sentAt === null ? 1 : 0, card.sentAt ?? '', card.id];
    case 'resolved':
      return [0, card.updatedAt, card.id];
  }
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Negative when `a` shows first. Open runs by urgency, then newest first; Waiting runs ascending, the longest
 * waiting first; Resolved runs newest first. A tie on the timestamp falls to the greater id where newest
 * leads. Strings compare by code unit, as SQLite's BINARY collation does.
 */
export function compareRowSort(state: InboxListState, a: InboxRowSort, b: InboxRowSort): number {
  const later = byCodeUnit(a[1], b[1]) || byCodeUnit(a[2], b[2]);
  switch (state) {
    case 'open':
      return a[0] - b[0] || -later;
    case 'waiting':
      return a[0] - b[0] || later;
    case 'resolved':
      return -(a[0] - b[0] || later);
  }
}

/** One row of a page: its key, where it sorts, the pass it holds and its cards' ids in list order. */
export const InboxRowRef = z.object({
  key: z.string().min(1),
  sort: InboxRowSort,
  passId: PassId.nullable(),
  ids: z.array(InboxItemId).nonempty(),
});
export type InboxRowRef = z.infer<typeof InboxRowRef>;

export const InboxCardContextDto = z.object({
  messages: z
    .array(z.object({ author: z.enum(['builder', 'agent']), text: z.string(), at: Timestamp }))
    .max(3),
});
export type InboxCardContextDto = z.infer<typeof InboxCardContextDto>;
