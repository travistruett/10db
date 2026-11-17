import type { InboxItemDto } from '@10db/contracts';
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
