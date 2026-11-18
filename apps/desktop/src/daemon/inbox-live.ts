import {
  compareRowSort,
  InboxItemId,
  InboxListState,
  type DaemonEvent,
  type InboxPageDto,
  type InboxRowSort,
} from '@10db/contracts';
import {
  hashKey,
  type InfiniteData,
  type Query,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { z } from 'zod';
import type { DaemonClient } from './client';
import { fetchRowOf, type InboxList, type InboxRow, type InboxRowsPage } from './inbox-queries';

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

type RowsData = InfiniteData<InboxRowsPage, InboxRowSort | null>;

const ROWS_KEY: QueryKey = ['inbox-rows'];

/** A cached list's filters, read back from its key, which only `inboxRowsKey` writes. */
const ListKey = z.tuple([
  z.literal('inbox-rows'),
  z.looseObject({ state: z.enum(InboxListState) }),
]);

function listOf(query: Query): InboxList | null {
  const key = ListKey.safeParse(query.queryKey);
  return key.success ? key.data[1] : null;
}

/** One chain of work per list, so its lookups and drops land in the order the events arrived. */
const chains = new WeakMap<QueryClient, Map<string, Promise<void>>>();

function enqueue(queryClient: QueryClient, query: Query, job: () => Promise<void>): void {
  const forClient = chains.get(queryClient) ?? new Map<string, Promise<void>>();
  chains.set(queryClient, forClient);
  const key = hashKey(query.queryKey);
  const previous = forClient.get(key) ?? Promise.resolve();
  const next = previous.then(job).catch(() => undefined);
  forClient.set(key, next);
  void next.finally(() => {
    if (forClient.get(key) === next) forClient.delete(key);
  });
}

function patch(
  queryClient: QueryClient,
  query: Query,
  state: InboxListState,
  change: { readonly cardId: InboxItemId; readonly row: InboxRow | null },
): void {
  queryClient.setQueryData<RowsData>(query.queryKey, (old) =>
    old === undefined ? old : { ...old, pages: mergeRow(old.pages, state, change) },
  );
}

function rowHolding(query: Query, cardId: InboxItemId): InboxRow | null {
  // A validated boundary: only `useInboxRows` fills a list under this key, with its pages.
  const data = query.state.data as RowsData | undefined;
  for (const page of data?.pages ?? [])
    for (const row of page.rows) if (row.items.some((item) => item.id === cardId)) return row;
  return null;
}

/**
 * Asks the daemon where `cardId` is in one list now and merges the answer. A row that stays behind with other
 * cards is looked up by one of them, so it takes its new place.
 */
async function lookUp(
  queryClient: QueryClient,
  client: DaemonClient,
  query: Query,
  list: InboxList,
  cardId: InboxItemId,
): Promise<void> {
  const before = rowHolding(query, cardId);
  const row = await fetchRowOf(client, list, cardId);
  patch(queryClient, query, list.state, { cardId, row });
  if (before === null || (row !== null && row.key === before.key)) return;
  const other = before.items.find((item) => item.id !== cardId);
  if (other === undefined) return;
  const moved = await fetchRowOf(client, list, other.id);
  patch(queryClient, query, list.state, { cardId: other.id, row: moved });
}

/** Takes a card out of every cached list, after what is already queued for it. */
export function dropCard(queryClient: QueryClient, cardId: InboxItemId): void {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ROWS_KEY })) {
    const list = listOf(query);
    if (list === null) continue;
    enqueue(queryClient, query, () => {
      patch(queryClient, query, list.state, { cardId, row: null });
      return Promise.resolve();
    });
  }
}

const SendEventData = z.object({ inboxItemId: InboxItemId });

/** The card an inbox or send event is about, or null for an event that names none. */
function cardOf(event: DaemonEvent): InboxItemId | null {
  if (event.entityType === 'inbox') {
    const id = InboxItemId.safeParse(event.entityId);
    return id.success ? id.data : null;
  }
  if (event.entityType === 'stakeholder_send') {
    const data = SendEventData.safeParse(event.data);
    return data.success ? data.data.inboxItemId : null;
  }
  return null;
}

/**
 * Patches the lists on screen for a card's event, so none is read whole: each observed list looks the card up
 * and merges. A list nobody observes is marked stale, to read from its first page when it is shown again.
 */
export function applyInboxEvent(
  queryClient: QueryClient,
  client: DaemonClient,
  event: DaemonEvent,
): void {
  const cardId = cardOf(event);
  if (cardId === null) return;
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ROWS_KEY })) {
    const list = listOf(query);
    if (list === null) continue;
    if (query.getObserversCount() === 0) {
      void queryClient.invalidateQueries({
        queryKey: query.queryKey,
        exact: true,
        refetchType: 'none',
      });
      continue;
    }
    enqueue(queryClient, query, () => lookUp(queryClient, client, query, list, cardId));
  }
}
