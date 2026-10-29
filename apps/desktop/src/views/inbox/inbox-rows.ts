import { InboxKind, type InboxItemDto, type InboxItemId } from '@10db/contracts';

/** One row of the inbox: a card, or identical flags shown together. */
export interface InboxRow {
  /** The first item's id, which selection and drafts follow. */
  readonly key: InboxItemId;
  readonly items: readonly [InboxItemDto, ...InboxItemDto[]];
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
  const rows: { key: InboxItemId; items: [InboxItemDto, ...InboxItemDto[]] }[] = [];
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
    const row: { key: InboxItemId; items: [InboxItemDto, ...InboxItemDto[]] } = {
      key: item.id,
      items: [item],
    };
    byText.set(text, row.items);
    rows.push(row);
  }
  return rows;
}
