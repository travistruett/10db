import type { InboxPageDto } from '@10db/contracts';
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
