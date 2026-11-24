import {
  InboxPageDto,
  mintId,
  inboxRowKey,
  inboxRowSort,
  type InboxItemDto,
  type InboxItemId,
  type InboxListState,
  type InboxRowSort,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { inboxItemDto } from '../test/fixtures';
import { flattenRows, InboxRowsError, joinRows, mergeRow } from './inbox-live';
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

describe('mergeRow', () => {
  const T = (n: number) => new Date(Date.UTC(2026, 9, 13, 12, 0, n)).toISOString();
  // Open shows the newest first, so `at(1)` is the newest card and each later n an older one.
  const at = (n: number) => inboxItemDto({ createdAt: T(10 - n) });
  const project = mintId('Project');
  const flag = (n: number) =>
    inboxItemDto({
      projectId: project,
      kind: 'flag',
      options: [],
      title: 'Flag',
      body: 'same',
      createdAt: T(10 - n),
    });
  const single = (item: InboxItemDto, state: InboxListState = 'open'): InboxRow => ({
    key: inboxRowKey(item),
    sort: inboxRowSort(state, { ...item, sentAt: item.send?.sentAt ?? null }),
    passId: null,
    items: [item],
  });
  const keysOf = (pages: readonly InboxRowsPage[]) =>
    pages.map((page) => page.rows.map((row) => row.key));
  const page = (rows: InboxRow[], next: InboxRowSort | null = null): InboxRowsPage => ({
    rows,
    next,
  });

  const [a, b, c, d, e, f] = [at(1), at(2), at(3), at(4), at(5), at(6)];
  const [ra, rb, rc, rd, re, rf] = [a, b, c, d, e, f].map((item) => single(item));
  if (!ra || !rb || !rc || !rd || !re || !rf) throw new Error('rows');

  it.each<{
    name: string;
    pages: InboxRowsPage[];
    state?: InboxListState;
    card: InboxItemId;
    row: InboxRow | null;
    keys: string[][];
  }>([
    {
      name: '1/2: a card leaves its row, and the row is gone',
      pages: [page([ra, rb, rc])],
      card: b.id,
      row: null,
      keys: [[a.id, c.id]],
    },
    {
      name: '4: a new card sorts into the page that holds its place',
      pages: [page([ra, rc], rc.sort), page([re, rf])],
      card: b.id,
      row: rb,
      keys: [
        [a.id, b.id, c.id],
        [e.id, f.id],
      ],
    },
    {
      name: '5: a card past next is dropped, the next page brings it',
      pages: [page([ra, rb], rb.sort)],
      card: e.id,
      row: re,
      keys: [[a.id, b.id]],
    },
    {
      name: '5: a card sorting after every loaded row but before next joins the last page',
      pages: [page([ra, rb], rf.sort)],
      card: c.id,
      row: rc,
      keys: [[a.id, b.id, c.id]],
    },
    {
      name: '6: the last page, next null, takes a card at the end',
      pages: [page([ra, rb])],
      card: f.id,
      row: rf,
      keys: [[a.id, b.id, f.id]],
    },
    {
      name: '8: a sort change moves the row',
      pages: [page([ra, rb, rc])],
      card: a.id,
      row: single({ ...a, createdAt: T(0) }),
      keys: [[b.id, c.id, a.id]],
    },
    {
      name: '8: a sort change past next drops the row',
      pages: [page([ra, rb], rb.sort)],
      card: a.id,
      row: single({ ...a, createdAt: T(0) }),
      keys: [[b.id]],
    },
    {
      name: '11: a re-keyed card leaves its old row for its own',
      pages: [page([{ ...single(flag(1)), items: [flag(1), flag(2)] }, rb])],
      card: b.id,
      row: single(inboxItemDto({ ...b, kind: 'flag', options: [] })),
      keys: [[inboxRowKey(flag(1)), inboxRowKey({ ...b, kind: 'flag', options: [] })]],
    },
  ])('$name', ({ pages, state = 'open', card, row, keys }) => {
    expect(keysOf(mergeRow(pages, state, { cardId: card, row }))).toEqual(keys);
  });

  it('3: a grouped row shrinks, then is gone', () => {
    const [f1, f2] = [flag(1), flag(2)];
    const group: InboxRow = { ...single(f1), items: [f1, f2] };
    const shrunk = mergeRow([page([group])], 'open', {
      cardId: f1.id,
      row: { ...group, items: [f2] },
    });
    expect(shrunk[0]?.rows[0]?.items.map((item) => item.id)).toEqual([f2.id]);
    expect(keysOf(mergeRow(shrunk, 'open', { cardId: f2.id, row: null }))).toEqual([[]]);
  });

  it('7: a join replaces the row in place', () => {
    const [f1, f2] = [flag(1), flag(2)];
    const before = single(f1);
    const joined: InboxRow = { ...before, items: [f1, f2] };
    // The flag ties with a on time and was made later, so it shows first.
    const merged = mergeRow([page([before, ra, rc])], 'open', { cardId: f2.id, row: joined });
    expect(merged[0]?.rows.map((row) => row.items.length)).toEqual([2, 1, 1]);
  });

  it('22: resolved inserts at the top, and a tie on the time places by id, descending', () => {
    // Resolved rows sort by the time a card was last updated, so that is what these differ and tie on.
    const resolvedAt = (n: number) => inboxItemDto({ createdAt: T(1), updatedAt: T(n) });
    const [x, y, z] = [resolvedAt(5), resolvedAt(5), resolvedAt(7)];
    const [rx, ry, rz] = [x, y, z].map((item) => single(item, 'resolved'));
    if (!rx || !ry || !rz) throw new Error('rows');
    const top = mergeRow([page([rx])], 'resolved', { cardId: z.id, row: rz });
    expect(keysOf(top)).toEqual([[z.id, x.id]]);
    // y was minted after x, so its id is greater and it shows first at the same time.
    const tie = mergeRow([page([rx])], 'resolved', { cardId: y.id, row: ry });
    expect(keysOf(tie)).toEqual([[y.id, x.id]]);
  });

  it('the same change twice equals once', () => {
    const pages = [page([ra, rc], rc.sort), page([re])];
    const once = mergeRow(pages, 'open', { cardId: b.id, row: rb });
    expect(mergeRow(once, 'open', { cardId: b.id, row: rb })).toEqual(once);
  });
});
