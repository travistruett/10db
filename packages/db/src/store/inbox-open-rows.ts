import {
  compareRowSort,
  InboxListState,
  inboxRowKey,
  inboxRowSort,
  InboxState,
  isBuilderCard,
  readyPassOf,
  RoutedBy,
  type InboxPageDto,
  type InboxPageQuery,
  type InboxRowRef,
  type InboxRowSort,
} from '@10db/contracts';
import { and, desc, eq, exists, inArray, not, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema';
import { INBOX_URGENCY_ORDER, toInboxItemDto } from './inbox';
import { sendIsOut, textMatches } from './inbox-sql';
import { ofActiveProject } from './projects';
import type { DbReader } from './store';

const items = schema.inboxItems;
const sends = schema.stakeholderSends;

/** Where a card belongs in Open, given what is connected. */
export interface InboxPlacement {
  /** Workspaces connected now: a sent, unreturned card whose send is in one of them is Waiting's, not Open's. */
  readonly connectedTeams: readonly string[];
}

interface OpenRow {
  readonly key: string;
  readonly sort: InboxRowSort;
  readonly passId: InboxRowRef['passId'];
  readonly ids: [InboxRowRef['ids'][0], ...InboxRowRef['ids'][number][]];
  counted: boolean;
  hit: boolean;
}

/**
 * One page of Open's rows. The light columns of every open card are read and folded into rows in order,
 * so a row is never split by a page; the page's cards are then read whole. `total` counts rows that hold a
 * card triage has placed.
 */
export function openRowsPage(
  db: DbReader,
  q: InboxPageQuery,
  placement: InboxPlacement,
): InboxPageDto {
  const where: (SQL | undefined)[] = [eq(items.state, InboxState.Open)];
  if (q.project !== undefined) where.push(eq(items.projectId, q.project));
  else where.push(ofActiveProject(items.projectId));
  if (q.kind !== undefined) where.push(eq(items.kind, q.kind));
  if (placement.connectedTeams.length > 0)
    where.push(
      not(
        exists(
          db
            .select({ one: sql`1` })
            .from(sends)
            .where(
              and(
                eq(sends.inboxItemId, items.id),
                sendIsOut,
                inArray(sends.teamId, [...placement.connectedTeams]),
              ),
            ),
        ),
      ),
    );
  const hit = q.q === undefined ? sql<number>`1` : sql<number>`${textMatches(q.q)}`;
  const cards = db
    .select({
      id: items.id,
      kind: items.kind,
      projectId: items.projectId,
      title: items.title,
      body: items.body,
      options: items.options,
      detail: items.detail,
      urgency: items.urgency,
      createdAt: items.createdAt,
      updatedAt: items.updatedAt,
      routedBy: items.routedBy,
      hit,
    })
    .from(items)
    .where(and(...where))
    // By urgency, then newest first, as `compareRowSort` orders Open.
    .orderBy(INBOX_URGENCY_ORDER, desc(items.createdAt), desc(items.id))
    .all();

  const rows: OpenRow[] = [];
  const byKey = new Map<string, OpenRow>();
  for (const card of cards) {
    // Open holds the builder's decisions only: a card another decider settles is never a row here.
    if (!isBuilderCard(card)) continue;
    const key = inboxRowKey(card);
    const counted = card.routedBy !== RoutedBy.TriagePending;
    const matched = card.hit === 1;
    const same = byKey.get(key);
    if (same) {
      same.ids.push(card.id);
      same.counted ||= counted;
      same.hit ||= matched;
      continue;
    }
    const row: OpenRow = {
      key,
      sort: inboxRowSort(InboxListState.Open, { ...card, sentAt: null }),
      passId: readyPassOf(card),
      ids: [card.id],
      counted,
      hit: matched,
    };
    byKey.set(key, row);
    rows.push(row);
  }

  const kept = rows.filter((row) => row.hit);
  const total = kept.filter((row) => row.counted).length;

  let from = 0;
  let page = 1;
  let wanted = kept;
  if (q.card !== undefined) {
    const card = q.card;
    wanted = kept.filter((row) => row.ids.includes(card));
  } else if (q.after !== undefined) {
    const after = q.after;
    wanted = kept.filter((row) => compareRowSort(InboxListState.Open, row.sort, after) > 0);
  } else {
    page = Math.min(q.page ?? 1, Math.max(1, Math.ceil(kept.length / q.pageSize)));
    from = (page - 1) * q.pageSize;
  }
  const shown = wanted.slice(from, from + q.pageSize);
  const last = shown.at(-1);
  const next = last !== undefined && from + shown.length < wanted.length ? last.sort : null;

  const ids = shown.flatMap((row) => row.ids);
  const byId = new Map(
    (ids.length === 0 ? [] : db.select().from(items).where(inArray(items.id, ids)).all()).map(
      (row) => [row.id, toInboxItemDto(db, row)] as const,
    ),
  );
  const pageItems = ids.flatMap((id) => {
    const item = byId.get(id);
    return item === undefined ? [] : [item];
  });
  return {
    items: pageItems,
    total,
    page,
    pageSize: q.pageSize,
    rows: shown.map((row) => ({ key: row.key, sort: row.sort, passId: row.passId, ids: row.ids })),
    next,
  };
}
