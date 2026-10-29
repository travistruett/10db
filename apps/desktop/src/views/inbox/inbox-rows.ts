import { InboxKind, type InboxItemDto } from '@10db/contracts';

/** One row of the inbox: a card, or identical flags shown together. */
export interface InboxRow {
  /**
   * What selection and drafts follow: a card's id, or for identical flags their shared text, which
   * stays the same while members leave the row.
   */
  readonly key: string;
  readonly items: readonly [InboxItemDto, ...InboxItemDto[]];
}

/** What the sidebar and the menu bar count: the rows the inbox shows, not the cards folded into them. */
export function inboxRowCount(items: readonly InboxItemDto[]): number {
  return inboxRows(items).length;
}

/** A flag with no options closes on any answer, so it can be dismissed without opening it. */
export function isDismissable(item: InboxItemDto): boolean {
  return item.kind === InboxKind.Flag && item.options.length === 0;
}

/**
 * The inbox's rows in the order of their first item. Dismissable flags of one project with the same
 * title and body share a row; every other item has its own.
 */
export function inboxRows(items: readonly InboxItemDto[]): InboxRow[] {
  const rows: { key: string; items: [InboxItemDto, ...InboxItemDto[]] }[] = [];
  const byText = new Map<string, InboxItemDto[]>();
  for (const item of items) {
    if (!isDismissable(item)) {
      rows.push({ key: item.id, items: [item] });
      continue;
    }
    const text = JSON.stringify([item.projectId, item.title, item.body]);
    const same = byText.get(text);
    if (same) {
      same.push(item);
      continue;
    }
    const row: { key: string; items: [InboxItemDto, ...InboxItemDto[]] } = {
      key: `flags:${text}`,
      items: [item],
    };
    byText.set(text, row.items);
    rows.push(row);
  }
  return rows;
}
