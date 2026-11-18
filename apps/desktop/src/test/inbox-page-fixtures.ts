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
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { daemonUrl, server } from './daemon';

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

/**
 * Serves Open's rows from whatever `open` returns now, read on every request, and an empty context for every
 * question. A test that serves `GET /inbox` for the other readers calls this beside it. Returns every query asked.
 */
export function serveOpenRows(open: () => readonly InboxItemDto[]): Record<string, string>[] {
  server.use(http.get(daemonUrl('/inbox/:id/context'), () => HttpResponse.json({ messages: [] })));
  return serveInboxRows({
    get open() {
      return [...open()];
    },
  });
}

/**
 * A card's title is on screen twice in the Inbox: on its row in the panel's listbox, and in the content. These
 * read the content, so a test that looks for a card's text finds one element.
 */
const IN_LIST = '[role="listbox"] *';
type TextQuery = Parameters<typeof screen.findByText>;
export const findText = (text: TextQuery[0], options?: TextQuery[1]) =>
  screen.findByText(text, { ...options, ignore: IN_LIST });
export const getText = (text: TextQuery[0], options?: TextQuery[1]) =>
  screen.getByText(text, { ...options, ignore: IN_LIST });
export const queryText = (text: TextQuery[0], options?: TextQuery[1]) =>
  screen.queryByText(text, { ...options, ignore: IN_LIST });

/** The panel's rows. */
export const panelRows = (): HTMLElement[] =>
  within(screen.getByRole('listbox', { name: 'Inbox' })).queryAllByRole('option');

/** The panel's row whose text holds `text`, once it has drawn. */
export const findPanelRow = (text: string): Promise<HTMLElement> =>
  waitFor(() => {
    const row = panelRows().find((candidate) => candidate.textContent.includes(text));
    if (row === undefined) throw new Error(`no row holds ${text}`);
    return row;
  });

/** The panel's rows once there are exactly `count`, by their text. */
export const panelRowTexts = (count: number): Promise<string[]> =>
  waitFor(() => {
    const rows = panelRows();
    if (rows.length !== count) throw new Error(`${String(rows.length)} rows, not ${String(count)}`);
    return rows.map((row) => row.textContent);
  });

/** Picks `item` from the group `group` of the panel's Filter menu. */
export async function chooseFilter(group: string, item: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
  const menu = await screen.findByRole('group', { name: group, hidden: true });
  fireEvent.click(await within(menu).findByRole('menuitem', { name: item, hidden: true }));
}
