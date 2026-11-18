import {
  compareRowSort,
  InboxRowSort,
  inboxRowKey,
  inboxRowSort,
  readyPassOf,
  type InboxItemDto,
  type InboxListState,
  type InboxRowRef,
} from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { daemonUrl, server } from './daemon';

/**
 * Serves `GET /inbox/page`: each state's cards as one page, whatever the filters (the daemon's own test
 * proves those). Returns every query the app asked with, in order, so a test can check what reached it.
 */
export function serveInboxPage(
  byState: Partial<Record<string, readonly InboxItemDto[]>>,
  /** How many cards a state holds in all, when more than the one page served. */
  totals: Partial<Record<string, number>> = {},
): Record<string, string>[] {
  const asked: Record<string, string>[] = [];
  server.use(
    http.get(daemonUrl('/inbox/page'), ({ request }) => {
      const params = new URL(request.url).searchParams;
      const query = Object.fromEntries(params);
      asked.push(query);
      const state = query['state'] ?? '';
      const items = byState[state] ?? [];
      return HttpResponse.json({
        items,
        total: totals[state] ?? items.length,
        page: Number(query['page'] ?? '1'),
        pageSize: Number(query['pageSize'] ?? '25'),
      });
    }),
  );
  return asked;
}

/** SQLite's LIKE folds A-Z only: never `toLowerCase()`, which folds every script. */
const asciiFold = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The rows of one state's cards, as the daemon groups and orders them. */
function rowsOf(state: InboxListState, cards: readonly InboxItemDto[]): InboxRowRef[] {
  const byKey = new Map<string, InboxRowRef>();
  for (const card of cards) {
    const sort = inboxRowSort(state, { ...card, sentAt: card.send?.sentAt ?? null });
    const key = state === 'open' ? inboxRowKey(card) : card.id;
    const row = byKey.get(key);
    if (row === undefined) {
      byKey.set(key, { key, sort, passId: readyPassOf(card), ids: [card.id] });
    } else {
      const first = compareRowSort(state, sort, row.sort) < 0 ? sort : row.sort;
      byKey.set(key, { ...row, sort: first, ids: [...row.ids, card.id] });
    }
  }
  return [...byKey.values()].sort((a, b) => compareRowSort(state, a.sort, b.sort));
}

/**
 * Serves `GET /inbox/page` as the daemon does, from one array of cards per state, read on every request so a
 * test changes what is served by changing the array: Open grouped by `inboxRowKey`, every list keyset-paged by
 * `after`, a `card` lookup, `pageSize`, and the `project`, `kind` and `q` filters. `hold` is awaited after the
 * answer is built and before it is sent, so a test can keep a page in flight with what it read then. Returns
 * every query asked, in order.
 */
export function serveInboxRows(
  byState: Partial<Record<InboxListState, InboxItemDto[]>>,
  hold?: (query: Record<string, string>) => Promise<void> | undefined,
): Record<string, string>[] {
  const asked: Record<string, string>[] = [];
  server.use(
    http.get(daemonUrl('/inbox/page'), async ({ request }) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      asked.push(query);
      const state =
        query['state'] === 'waiting' || query['state'] === 'resolved' ? query['state'] : 'open';
      const needle = query['q'] === undefined ? null : asciiFold(query['q']);
      const cards = (byState[state] ?? []).filter(
        (card) =>
          (query['project'] === undefined || card.projectId === query['project']) &&
          (query['kind'] === undefined || card.kind === query['kind']) &&
          (needle === null ||
            asciiFold(card.title).includes(needle) ||
            asciiFold(card.body).includes(needle)),
      );
      let rows = rowsOf(state, cards);
      const total = state === 'open' ? rows.length : cards.length;
      const pageSize = Number(query['pageSize'] ?? '25');
      let next: InboxRowSort | null = null;
      if (query['card'] !== undefined) {
        rows = rows.filter((row) => row.ids.some((id) => id === query['card']));
      } else {
        if (query['after'] !== undefined) {
          const after = InboxRowSort.parse(JSON.parse(query['after']));
          rows = rows.filter((row) => compareRowSort(state, row.sort, after) > 0);
        }
        if (rows.length > pageSize) {
          rows = rows.slice(0, pageSize);
          next = rows.at(-1)?.sort ?? null;
        }
      }
      const items = rows.flatMap((row) =>
        row.ids.flatMap((id) => cards.filter((card) => card.id === id)),
      );
      const body = { items, total, page: 1, pageSize, rows, next };
      await hold?.(query);
      return HttpResponse.json(body);
    }),
  );
  return asked;
}

/** The record rows of the table named `label`, once it has drawn at least `count`. */
export async function tableRows(label: string, count = 1): Promise<HTMLElement[]> {
  const table = await screen.findByRole('table', { name: label });
  return waitFor(() => {
    const rows = [...table.querySelectorAll<HTMLElement>('tr[data-row-id]')];
    if (rows.length < count) throw new Error(`${label} has ${String(rows.length)} rows`);
    return rows;
  });
}

/** Opens every row of the table named `label` with Enter, as the builder would from the keyboard. */
export async function openEveryRow(label: string, count = 1): Promise<HTMLElement[]> {
  const rows = await tableRows(label, count);
  for (const row of rows) {
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
  }
  await waitFor(() => {
    for (const row of rows)
      if (row.getAttribute('aria-expanded') !== 'true') throw new Error('shut');
  });
  return rows;
}
