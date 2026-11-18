import {
  CARD_RESOLUTION,
  InboxListState,
  InboxOutcome,
  InboxSort,
  inboxRowSort,
  InboxState,
  SortDirection,
  type InboxPageDto,
  type InboxPageQuery,
  type InboxRowRef,
} from '@10db/contracts';
import { and, asc, count, desc, eq, exists, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import * as schema from '../schema';
import { INBOX_URGENCY_ORDER, toInboxItemDto } from './inbox';
import { openRowsPage, type InboxPlacement } from './inbox-open-rows';
import { SENT_AT, sendIsOut } from './inbox-sql';
import type { DbReader } from './store';

const items = schema.inboxItems;
const sends = schema.stakeholderSends;
const sendPeople = schema.stakeholderSendPeople;

/** The `$."key"` path of one key of a card's detail. */
const detailPath = (key: string, field: string) => `$."${key}"."${field}"`;

/**
 * `inboxOutcome` in SQL, with the same precedence: a Slack answer, then a resolution `CardResolution`
 * accepts (by 10db, with a reason), then anything else.
 */
const OUTCOME = sql`CASE
  WHEN json_extract(${items.answer}, '$.via') = 'slack' THEN ${InboxOutcome.Slack}
  WHEN json_extract(${items.detail}, ${detailPath(CARD_RESOLUTION, 'by')}) = '10db'
    AND json_type(${items.detail}, ${detailPath(CARD_RESOLUTION, 'reason')}) = 'text'
    AND length(json_extract(${items.detail}, ${detailPath(CARD_RESOLUTION, 'reason')})) > 0
    THEN ${InboxOutcome.TenDb}
  ELSE ${InboxOutcome.Answered}
END`;

function whereOf(db: DbReader, q: InboxPageQuery): SQL | undefined {
  const where: (SQL | undefined)[] = [
    eq(items.state, q.state === InboxListState.Resolved ? InboxState.Resolved : InboxState.Open),
  ];
  const waiting = q.state === InboxListState.Waiting;
  if (waiting)
    where.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(sends)
          .where(and(eq(sends.inboxItemId, items.id), sendIsOut)),
      ),
    );
  if (q.project !== undefined) where.push(eq(items.projectId, q.project));
  if (q.kind !== undefined) where.push(eq(items.kind, q.kind));
  if (q.outcome !== undefined) where.push(sql`${OUTCOME} = ${q.outcome}`);
  if (q.person !== undefined)
    where.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(sendPeople)
          .innerJoin(sends, eq(sends.id, sendPeople.sendId))
          .where(
            and(
              eq(sends.inboxItemId, items.id),
              eq(sendPeople.personId, q.person),
              eq(sendPeople.recipient, true),
              // In Waiting, the person is who the question is out with now.
              waiting ? sendIsOut : undefined,
            ),
          ),
      ),
    );
  return and(...where);
}

function orderOf(q: InboxPageQuery): SQL[] {
  const by = (column: SQL | SQLiteColumn, dir: SortDirection): SQL[] =>
    dir === SortDirection.Desc ? [desc(column), desc(items.id)] : [asc(column), asc(items.id)];
  const dir = q.dir ?? SortDirection.Asc;
  switch (q.sort) {
    case undefined:
      switch (q.state) {
        case InboxListState.Resolved:
          return by(items.updatedAt, q.dir ?? SortDirection.Desc);
        case InboxListState.Waiting:
          return [sql`${SENT_AT} IS NULL`, ...by(SENT_AT, q.dir ?? SortDirection.Asc)];
        case InboxListState.Open:
          return [INBOX_URGENCY_ORDER, ...by(items.createdAt, q.dir ?? SortDirection.Asc)];
      }
      break;
    case InboxSort.UpdatedAt:
      return by(items.updatedAt, dir);
    case InboxSort.CreatedAt:
      return by(items.createdAt, dir);
    case InboxSort.Kind:
      return by(items.kind, dir);
    case InboxSort.Title:
      return by(sql`${items.title} COLLATE NOCASE`, dir);
    case InboxSort.SentAt:
      // A card with no send sorts last either way.
      return [sql`${SENT_AT} IS NULL`, ...by(SENT_AT, dir)];
  }
  return by(items.updatedAt, dir);
}

/**
 * One page of the inbox's cards and how many match in all, filtered, sorted and counted in the query.
 * A page past the last answers the last.
 */
export function pageInbox(
  db: DbReader,
  q: InboxPageQuery,
  placement: InboxPlacement,
): InboxPageDto {
  if (q.state === InboxListState.Open) return openRowsPage(db, q, placement);
  const where = whereOf(db, q);
  const total = db.select({ n: count() }).from(items).where(where).get()?.n ?? 0;
  const page = Math.min(q.page ?? 1, Math.max(1, Math.ceil(total / q.pageSize)));
  const found = db
    .select()
    .from(items)
    .where(where)
    .orderBy(...orderOf(q))
    .limit(q.pageSize)
    .offset((page - 1) * q.pageSize)
    .all()
    .map((row) => toInboxItemDto(db, row));
  const rows = found.map((item): InboxRowRef => ({
    key: item.id,
    sort: inboxRowSort(q.state, { ...item, sentAt: item.send?.sentAt ?? null }),
    passId: null,
    ids: [item.id],
  }));
  return { items: found, total, page, pageSize: q.pageSize, rows, next: null };
}
