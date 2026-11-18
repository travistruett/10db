import {
  compareRowSort,
  type InboxItemId,
  type InboxListState,
  type InboxPageDto,
} from '@10db/contracts';
import type { InboxRow, InboxRowsPage } from './inbox-queries';

/** A page's row names a card the page does not hold, so the daemon and the client disagree. */
export class InboxRowsError extends Error {
  override readonly name = 'InboxRowsError';
}

/** Puts each row's card ids onto the cards the page holds. */
export function joinRows(page: InboxPageDto): InboxRowsPage {
  const byId = new Map(page.items.map((item) => [item.id, item]));
  const rows = page.rows.map((ref): InboxRow => {
    const [first, ...rest] = ref.ids.map((id) => {
      const item = byId.get(id);
      if (item === undefined) throw new InboxRowsError(`the page has no card ${id}`);
      return item;
    });
    if (first === undefined) throw new InboxRowsError(`row ${ref.key} has no cards`);
    return { key: ref.key, sort: ref.sort, passId: ref.passId, items: [first, ...rest] };
  });
  return { rows, next: page.next };
}

/** The loaded pages as one list. A row on two pages (the list moved between fetches) shows once, from the later. */
export function flattenRows(pages: readonly InboxRowsPage[]): InboxRow[] {
  const seen = new Set<string>();
  const reversed: InboxRow[] = [];
  for (const page of pages.toReversed()) {
    for (const row of page.rows.toReversed()) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      reversed.push(row);
    }
  }
  return reversed.toReversed();
}

/**
 * Where a card's row belongs in the loaded pages after the card changed: `row` is the row the daemon now
 * answers for the card (null when no row of this list holds it). The card leaves every row it was in, and the
 * row, if any, takes the place the daemon's pages would give it. Past the loaded end it is dropped, because
 * the next page brings it. Applying a change twice gives the same pages.
 */
export function mergeRow(
  pages: readonly InboxRowsPage[],
  state: InboxListState,
  change: { readonly cardId: InboxItemId; readonly row: InboxRow | null },
): InboxRowsPage[] {
  const { cardId, row } = change;
  const without = pages.map((page): InboxRowsPage => {
    const rows = page.rows.flatMap((held): InboxRow[] => {
      if (held.key === row?.key) return [];
      const items = held.items.filter((item) => item.id !== cardId);
      const [first, ...rest] = items;
      return first === undefined ? [] : [{ ...held, items: [first, ...rest] }];
    });
    return { rows, next: page.next };
  });
  if (row === null) return without;
  for (const [index, page] of without.entries()) {
    const at = page.rows.findIndex((held) => compareRowSort(state, held.sort, row.sort) > 0);
    if (at >= 0) {
      return without.map((other, i) =>
        i === index ? { rows: other.rows.toSpliced(at, 0, row), next: other.next } : other,
      );
    }
  }
  const last = without.at(-1);
  if (last === undefined) return without;
  if (last.next !== null && compareRowSort(state, last.next, row.sort) <= 0) return without;
  return without.map((page) =>
    page === last ? { rows: [...page.rows, row], next: page.next } : page,
  );
}
