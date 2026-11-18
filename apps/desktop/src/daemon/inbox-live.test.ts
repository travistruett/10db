import { InboxPageDto, inboxRowSort, type InboxItemId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { inboxItemDto } from '../test/fixtures';
import { flattenRows, InboxRowsError, joinRows } from './inbox-live';
import type { InboxRow, InboxRowsPage } from './inbox-queries';

const card = (createdAt = '2026-10-13T12:00:00.000Z') => inboxItemDto({ createdAt });

function rowOf(...items: [ReturnType<typeof card>, ...ReturnType<typeof card>[]]): InboxRow {
  return {
    key: items[0].id,
    sort: inboxRowSort('open', { ...items[0], sentAt: null }),
    passId: null,
    items,
  };
}

describe('joinRows', () => {
  it('puts each row id on its card, in the row order', () => {
    const a = card();
    const b = card();
    const page = InboxPageDto.parse({
      items: [a, b],
      total: 2,
      page: 1,
      pageSize: 50,
      rows: [
        { key: a.id, sort: [1, a.createdAt, a.id], passId: null, ids: [a.id] },
        { key: b.id, sort: [1, b.createdAt, b.id], passId: null, ids: [b.id] },
      ],
      next: [1, b.createdAt, b.id],
    });
    const joined = joinRows(page);
    expect(joined.rows.map((row) => row.items.map((item) => item.id))).toEqual([[a.id], [b.id]]);
    expect(joined.next).toEqual([1, b.createdAt, b.id]);
  });

  it('throws InboxRowsError when a row names a card the page lacks', () => {
    const a = card();
    const missing: InboxItemId = card().id;
    const page = InboxPageDto.parse({
      items: [a],
      total: 1,
      page: 1,
      pageSize: 50,
      rows: [{ key: a.id, sort: [1, a.createdAt, a.id], passId: null, ids: [a.id, missing] }],
    });
    expect(() => joinRows(page)).toThrow(InboxRowsError);
  });
});

describe('flattenRows', () => {
  it('shows a key held by pages 1 and 2 once, from page 2', () => {
    const shared = card();
    const first = card();
    const stale = rowOf(shared);
    const fresh: InboxRow = { ...rowOf(shared), items: [{ ...shared, title: 'changed' }] };
    const pages: InboxRowsPage[] = [
      { rows: [rowOf(first), stale], next: stale.sort },
      { rows: [fresh], next: null },
    ];
    const flat = flattenRows(pages);
    expect(flat.map((row) => row.key)).toEqual([first.id, shared.id]);
    expect(flat[1]?.items[0].title).toBe('changed');
  });
});
