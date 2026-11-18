import {
  CARD_TYPE_DAYS,
  DISMISS_CHOICES,
  InboxKind,
  InboxState,
  isNoisyCardType,
  type CardTypeDto,
  type CardTypeWindowDto,
  type ProjectId,
} from '@10db/contracts';
import { and, eq, gte, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema';
import { RESOLVED_BY_TEN_DB } from './inbox-page';
import type { DbReader } from './store';

// What became of each type of Inbox card the project raised lately, counted in the query: nothing is
// stored, and no card leaves the database.

const DAY_MS = 86_400_000;
const items = schema.inboxItems;

/** The text before the first colon of `column`, or all of it when it has none. */
const beforeColon = (column: SQL | typeof items.foldKey | typeof items.title): SQL =>
  sql`substr(${column}, 1, instr(${column} || ':', ':') - 1)`;

/**
 * A card's type: its fold-key prefix. A card with no fold key is a flag typed by its title up to the
 * first colon, or any other kind typed by the kind, whose title is the question asked.
 */
const TYPE = sql<string>`CASE
  WHEN ${items.foldKey} IS NOT NULL AND ${items.foldKey} <> '' THEN ${beforeColon(items.foldKey)}
  WHEN ${items.kind} = ${InboxKind.Flag} THEN trim(${beforeColon(items.title)})
  ELSE ${items.kind}
END`;

const dismissChoices = sql.join(
  DISMISS_CHOICES.map((choice) => sql`${choice}`),
  sql`, `,
);

/**
 * How the card ended: closed by 10db (cancelled, expired, or resolved with its reason), dismissed by the
 * builder, answered with a real choice, or still open. 10db's own close comes first: it is no answer.
 */
const FATE = sql<string>`CASE
  WHEN ${items.state} IN (${InboxState.Cancelled}, ${InboxState.Expired}) THEN 'withdrawn'
  WHEN ${RESOLVED_BY_TEN_DB} THEN 'withdrawn'
  WHEN json_extract(${items.answer}, '$.choice') IN (${dismissChoices}) THEN 'dismissed'
  WHEN ${items.answer} IS NOT NULL THEN 'acted'
  ELSE 'open'
END`;

/** The cards of the group raised at or after `since` that ended as `fate`, or all of them. */
function countOf(since: string, fate?: string): SQL<number> {
  return sql<number>`coalesce(sum(CASE WHEN ${items.createdAt} >= ${since}${
    fate === undefined ? sql`` : sql` AND ${FATE} = ${fate}`
  } THEN 1 ELSE 0 END), 0)`;
}

/**
 * The project's Inbox card types over the last {@link CARD_TYPE_DAYS} 7 and 30 days: per type, how many
 * cards were raised, answered with a real choice, dismissed and closed by 10db. Noisy types come first,
 * then the most raised in 30 days. A type with no card in 30 days is left out.
 */
export function inboxCardTypes(db: DbReader, projectId: ProjectId, now: Date): CardTypeDto[] {
  const since = (days: number): string => new Date(now.getTime() - days * DAY_MS).toISOString();
  const week = since(CARD_TYPE_DAYS.Week);
  const month = since(CARD_TYPE_DAYS.Month);
  const rows = db
    .select({
      type: TYPE,
      weekRaised: countOf(week),
      weekActed: countOf(week, 'acted'),
      weekDismissed: countOf(week, 'dismissed'),
      weekWithdrawn: countOf(week, 'withdrawn'),
      monthRaised: countOf(month),
      monthActed: countOf(month, 'acted'),
      monthDismissed: countOf(month, 'dismissed'),
      monthWithdrawn: countOf(month, 'withdrawn'),
    })
    .from(items)
    .where(and(eq(items.projectId, projectId), gte(items.createdAt, month)))
    .groupBy(TYPE)
    .all();
  const types = rows.map((row): CardTypeDto => {
    const last7Days: CardTypeWindowDto = {
      raised: row.weekRaised,
      acted: row.weekActed,
      dismissed: row.weekDismissed,
      withdrawn: row.weekWithdrawn,
    };
    const last30Days: CardTypeWindowDto = {
      raised: row.monthRaised,
      acted: row.monthActed,
      dismissed: row.monthDismissed,
      withdrawn: row.monthWithdrawn,
    };
    return {
      type: row.type,
      last7Days,
      last30Days,
      noisy: isNoisyCardType(last7Days) || isNoisyCardType(last30Days),
    };
  });
  return types.sort(
    (a, b) =>
      Number(b.noisy) - Number(a.noisy) ||
      b.last30Days.raised - a.last30Days.raised ||
      a.type.localeCompare(b.type),
  );
}
