import {
  DecisionId,
  KnowledgeItemKind,
  KnowledgeListShelf,
  KnowledgeScope,
  KnowledgeSort,
  PAST_KNOWLEDGE_STATES,
  PRINCIPLE_KIND_ORDER,
  PrincipleId,
  SortDirection,
  type DecisionDto,
  type PrincipleDto,
  type PrincipleKind,
  type ProjectId,
  type SearchMatch,
} from '@10db/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { currentDecisionSql, decisionStateSql, listDecisions } from './decisions';
import { KnowledgeIndex, rankedMatchesSql } from './knowledge-search';
import { currentPrincipleSql, listPrinciples, principleStateSql } from './principles';
import type { DbReader } from './store';

// The Knowledge list, one page at a time: the filters, the order, the page and the count are all
// worked out in SQL, so no reader ever loads every record to narrow, sort or count them.

export interface KnowledgePageQuery {
  readonly projectId: ProjectId;
  readonly scope?: KnowledgeScope | undefined;
  readonly area?: string | undefined;
  /** Whether decisions are listed. */
  readonly decisions: boolean;
  /** The kinds of principle listed; none lists no principle. */
  readonly principleKinds: readonly PrincipleKind[];
  readonly shelf: KnowledgeListShelf;
  /** Only the records matching these words; null lists without a search. */
  readonly search: { readonly text: string; readonly match: SearchMatch } | null;
  /** The order asked for; null orders a search by best match and a list without one newest first. */
  readonly sort: { readonly by: KnowledgeSort; readonly dir: SortDirection } | null;
  /** From 1; a page past the end answers the last page. */
  readonly page: number;
  readonly pageSize: number;
}

export type KnowledgePageRow =
  | { readonly kind: typeof KnowledgeItemKind.Decision; readonly decision: DecisionDto }
  | { readonly kind: typeof KnowledgeItemKind.Principle; readonly principle: PrincipleDto };

export interface KnowledgePage {
  readonly rows: readonly KnowledgePageRow[];
  /** How many records match, on every page together. */
  readonly total: number;
  /** The page answered. */
  readonly page: number;
}

/** Builder-wide, then the project, then its areas: the order a sort by scope follows. */
const SCOPE_ORDER: readonly KnowledgeScope[] = [
  KnowledgeScope.You,
  KnowledgeScope.Project,
  KnowledgeScope.Area,
];

/** The position of `column`'s value in `order`, as SQL. */
function positionIn(column: SQL, order: readonly string[]): SQL {
  return sql`CASE ${column} ${sql.join(
    order.map((value, i) => sql`WHEN ${value} THEN ${i}`),
    sql` `,
  )} END`;
}

const inList = (values: readonly string[]): SQL =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/** One table's matching rows with the columns the page is ordered by; null when none can match. */
function leg(kind: KnowledgeItemKind, q: KnowledgePageQuery): SQL | null {
  const decision = kind === KnowledgeItemKind.Decision;
  const alias = sql.raw(decision ? 'd' : 'p');
  const column = (name: string) => sql.raw(`${decision ? 'd' : 'p'}.${name}`);
  const state = decision ? decisionStateSql : principleStateSql;
  const where: SQL[] = [
    sql`(${column('project_id')} = ${q.projectId} OR ${column('project_id')} IS NULL)`,
  ];
  if (q.scope) where.push(sql`${column('scope')} = ${q.scope}`);
  if (q.area) where.push(sql`${column('area')} = ${q.area}`);
  if (!decision && !PRINCIPLE_KIND_ORDER.every((k) => q.principleKinds.includes(k)))
    where.push(sql`p.kind IN (${inList(q.principleKinds)})`);
  switch (q.shelf) {
    case KnowledgeListShelf.Current:
      where.push(decision ? currentDecisionSql : currentPrincipleSql);
      break;
    case KnowledgeListShelf.Past:
      where.push(sql`(${state}) IN (${inList(PAST_KNOWLEDGE_STATES)})`);
      break;
    case KnowledgeListShelf.All:
      break;
  }
  let from = sql`${sql.raw(decision ? 'decisions' : 'principles')} ${alias}`;
  // Without a search every row stands at position 0; with one, each kind's best match is 1, its
  // second best 2, so ordering by position takes the best of each kind in turn.
  let position = sql`0`;
  if (q.search) {
    const matches = rankedMatchesSql(
      decision ? KnowledgeIndex.Decisions : KnowledgeIndex.Principles,
      q.search.text,
      q.search.match,
    );
    if (matches === null) return null;
    from = sql`${from} JOIN (${matches}) m ON m.rowid = ${column('rowid')}`;
    position = sql`row_number() OVER (ORDER BY m.rank, ${column('id')})`;
  }
  const kindOrder = decision
    ? sql`${PRINCIPLE_KIND_ORDER.length}`
    : positionIn(sql`p.kind`, PRINCIPLE_KIND_ORDER);
  return sql`SELECT ${kind} AS kind, ${column('id')} AS id, ${column('created_at')} AS createdAt,
      ${kindOrder} AS kindOrder, ${positionIn(column('scope'), SCOPE_ORDER)} AS scopeOrder,
      ${column('area')} AS area, ${state} AS state, ${position} AS position
    FROM ${from} WHERE ${sql.join(where, sql` AND `)}`;
}

const NEWEST = sql`createdAt DESC, id DESC`;

/** The order of the page; every order ends on the id, so a row never moves between pages. */
function orderBy(q: KnowledgePageQuery): SQL {
  if (q.sort === null) return q.search ? sql`position, kind, id` : NEWEST;
  const dir = sql.raw(q.sort.dir === SortDirection.Asc ? 'ASC' : 'DESC');
  switch (q.sort.by) {
    case KnowledgeSort.CreatedAt:
      return sql`createdAt ${dir}, id ${dir}`;
    case KnowledgeSort.Kind:
      return sql`kindOrder ${dir}, ${NEWEST}`;
    case KnowledgeSort.Scope:
      return sql`scopeOrder ${dir}, area ${dir}, ${NEWEST}`;
    case KnowledgeSort.State:
      return sql`state ${dir}, ${NEWEST}`;
  }
}

const Total = z.array(z.object({ total: z.number().int().nonnegative() }));
const PageIds = z.array(
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal(KnowledgeItemKind.Decision), id: DecisionId }),
    z.object({ kind: z.literal(KnowledgeItemKind.Principle), id: PrincipleId }),
  ]),
);

/**
 * One page of the project's decisions and principles and the builder's own, narrowed by scope,
 * area, kind, shelf and search, in the order asked for, with how many match in all.
 */
export function pageKnowledge(db: DbReader, q: KnowledgePageQuery): KnowledgePage {
  const legs = [
    q.decisions ? leg(KnowledgeItemKind.Decision, q) : null,
    q.principleKinds.length > 0 ? leg(KnowledgeItemKind.Principle, q) : null,
  ].filter((l): l is SQL => l !== null);
  if (legs.length === 0) return { rows: [], total: 0, page: 1 };
  const listed = sql`WITH listed AS (${sql.join(legs, sql` UNION ALL `)})`;
  const total =
    Total.parse(db.all(sql`${listed} SELECT COUNT(*) AS total FROM listed`))[0]?.total ?? 0;
  const page = Math.min(q.page, Math.max(1, Math.ceil(total / q.pageSize)));
  const ids = PageIds.parse(
    db.all(sql`${listed} SELECT kind, id FROM listed ORDER BY ${orderBy(q)}
      LIMIT ${q.pageSize} OFFSET ${(page - 1) * q.pageSize}`),
  );
  const decisionIds = ids.flatMap((r) => (r.kind === KnowledgeItemKind.Decision ? [r.id] : []));
  const principleIds = ids.flatMap((r) => (r.kind === KnowledgeItemKind.Principle ? [r.id] : []));
  const decisions = new Map(
    listDecisions(db, { projectId: q.projectId, history: true, ids: decisionIds }).map((d) => [
      d.id,
      d,
    ]),
  );
  const principles = new Map(
    listPrinciples(db, { projectId: q.projectId, history: true, ids: principleIds }).map((p) => [
      p.id,
      p,
    ]),
  );
  return {
    rows: ids.flatMap((r): KnowledgePageRow[] => {
      if (r.kind === KnowledgeItemKind.Decision) {
        const decision = decisions.get(r.id);
        return decision ? [{ kind: r.kind, decision }] : [];
      }
      const principle = principles.get(r.id);
      return principle ? [{ kind: r.kind, principle }] : [];
    }),
    total,
    page,
  };
}
