import {
  InboxKind,
  PassCheckDetail,
  RoutedBy,
  SendState,
  type InboxItemDto,
  type PassId,
  type SlackConnectionDto,
} from '@10db/contracts';

/** One row of the inbox: a card, identical flags shown together, or a pass's Ready pages. */
export interface InboxRow {
  /**
   * What selection and drafts follow: a card's id, or for identical flags their shared text, or for
   * a pass its id, each of which stays the same while members leave the row.
   */
  readonly key: string;
  readonly items: readonly [InboxItemDto, ...InboxItemDto[]];
  /** The Workbench pass whose Ready pages the row holds; null for any other row. */
  readonly passId: PassId | null;
}

/**
 * Whether a question is out with someone and needs nothing from the builder: sent and not returned, while
 * Slack is connected. With Slack off, unreachable, refused or without a token nobody can read a reply, so
 * the card is the builder's to answer or take back.
 */
export function isWaiting(
  item: InboxItemDto,
  connection: SlackConnectionDto['state'] | undefined,
): boolean {
  return (
    connection === 'connected' &&
    item.send?.state === SendState.Sent &&
    item.send.returnedAt === null
  );
}

/** The open cards divided into what needs the builder and what waits on someone else. */
export function splitInbox(
  items: readonly InboxItemDto[],
  connection: SlackConnectionDto['state'] | undefined,
): { readonly open: InboxItemDto[]; readonly waiting: InboxItemDto[] } {
  const waiting = items.filter((item) => isWaiting(item, connection));
  return { open: items.filter((item) => !waiting.includes(item)), waiting };
}

/** Open's count: its rows, leaving out a card triage has not placed yet, which may still go to someone else. */
export function openCount(open: readonly InboxItemDto[]): number {
  return inboxRows(open.filter((item) => item.routedBy !== RoutedBy.TriagePending)).length;
}

/** A flag with no options closes on any answer, so it can be dismissed without opening it. */
export function isDismissable(item: InboxItemDto): boolean {
  return item.kind === InboxKind.Flag && item.options.length === 0;
}

/** The pass of a Ready page's `check` item, or null for any other card. */
function readyPass(item: InboxItemDto): PassId | null {
  if (item.kind !== InboxKind.Check) return null;
  const detail = PassCheckDetail.safeParse(item.detail);
  return detail.success ? detail.data.passId : null;
}

interface Row {
  key: string;
  items: [InboxItemDto, ...InboxItemDto[]];
  passId: PassId | null;
}

/**
 * The inbox's rows in the order of their first item. Dismissable flags of one project with the same
 * title and body share a row, and so do the Ready pages of one pass; every other item, a failed
 * turn's flag included, has its own.
 */
export function inboxRows(items: readonly InboxItemDto[]): InboxRow[] {
  const rows: Row[] = [];
  const byKey = new Map<string, InboxItemDto[]>();
  const fold = (key: string, item: InboxItemDto, passId: PassId | null): void => {
    const same = byKey.get(key);
    if (same) {
      same.push(item);
      return;
    }
    const row: Row = { key, items: [item], passId };
    byKey.set(key, row.items);
    rows.push(row);
  };
  for (const item of items) {
    const passId = readyPass(item);
    if (passId !== null) fold(`pass:${passId}`, item, passId);
    else if (isDismissable(item))
      fold(`flags:${JSON.stringify([item.projectId, item.title, item.body])}`, item, null);
    else rows.push({ key: item.id, items: [item], passId: null });
  }
  return rows;
}
