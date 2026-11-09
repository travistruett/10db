import {
  DecisionId,
  KnowledgeHit,
  PrincipleId,
  RecordHit,
  SearchMatch,
  searchTerms,
  type KnowledgeScope,
  type PrincipleDto,
  type PrincipleKind,
  type ProjectId,
} from '@10db/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { TendbDatabase } from '../database';
import { composed } from './compose';
import { currentDecisionSql } from './decisions';
import { currentPrincipleSql, listPrinciples } from './principles';
import type { DbReader } from './store';

// Every full-text query lives here, so the storage engine can change later (packages/db/AGENTS.md).

/**
 * Turns text into an FTS5 query of quoted terms, so user text is never parsed as syntax. `AnyWord`
 * joins whole words with OR, so a long question or a task's description still finds what it shares.
 * `AllPrefixes` makes every term a prefix that must match, so a word still being typed finds its
 * record and each added word narrows, the rule the Proposals tab filters with (`matchesSearch`).
 */
function ftsQuery(text: string, match: SearchMatch = SearchMatch.AnyWord): string | null {
  const terms = searchTerms(text);
  if (terms.length === 0) return null;
  return match === SearchMatch.AllPrefixes
    ? terms.map((t) => `"${t}"*`).join(' AND ')
    : terms.map((t) => `"${t}"`).join(' OR ');
}

/**
 * The rows of an index's table that match `text`, each with its `rank` (lower is better), as a
 * subquery to join on `rowid`; null when the text holds no word.
 */
export function rankedMatchesSql(
  index: KnowledgeIndex,
  text: string,
  match: SearchMatch,
): SQL | null {
  const query = ftsQuery(text, match);
  if (query === null) return null;
  const name = sql.raw(index);
  return sql`SELECT rowid AS rowid, bm25(${name}) AS rank FROM ${name} WHERE ${name} MATCH ${query}`;
}

export interface SearchQuery {
  readonly projectId: ProjectId;
  readonly query: string;
  readonly limit: number;
  /** How the query's words select records; any word unless named. */
  readonly match?: SearchMatch;
  readonly scope?: KnowledgeScope;
  readonly area?: string;
  /** Also superseded, retired, withdrawn and proposed records. */
  readonly history?: boolean;
}

/** The project's rows and the builder's own, narrowed by scope and area; `alias` is the table's alias in the query. */
function narrow(alias: 'd' | 'p', q: SearchQuery): SQL[] {
  const column = (name: string) => sql.raw(`${alias}.${name}`);
  const parts: SQL[] = [
    sql`(${column('project_id')} = ${q.projectId} OR ${column('project_id')} IS NULL)`,
  ];
  if (q.scope) parts.push(sql`${column('scope')} = ${q.scope}`);
  if (q.area) parts.push(sql`${column('area')} = ${q.area}`);
  return parts;
}

const DecisionIdRows = z.array(z.object({ id: DecisionId }));

/** Decisions matching the query, best first; current ones unless `history`. */
export function searchDecisionIds(db: DbReader, q: SearchQuery): DecisionId[] {
  const match = ftsQuery(q.query, q.match);
  if (match === null) return [];
  const where = [sql`decisions_fts MATCH ${match}`, ...narrow('d', q)];
  if (!q.history) where.push(currentDecisionSql);
  const rows = db.all(sql`
    SELECT d.id AS id FROM decisions_fts f JOIN decisions d ON d.rowid = f.rowid
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY bm25(decisions_fts), d.id
    LIMIT ${q.limit}`);
  return DecisionIdRows.parse(rows).map((r) => r.id);
}

export function searchDecisions(
  db: DbReader,
  projectId: ProjectId,
  query: string,
  limit: number,
): KnowledgeHit[] {
  const match = ftsQuery(query);
  if (match === null) return [];
  // Rows are parsed against the contract so a schema drift fails here rather than downstream.
  const rows = db.all(sql`
    SELECT 'decision' AS kind, d.id AS id, d.question AS question, d.choice AS choice,
      d.rationale AS rationale, d.scope AS scope, d.area AS area
    FROM decisions_fts f JOIN decisions d ON d.rowid = f.rowid
    WHERE decisions_fts MATCH ${match} AND (d.project_id = ${projectId} OR d.project_id IS NULL)
      AND ${currentDecisionSql}
    ORDER BY bm25(decisions_fts), d.id
    LIMIT ${limit}
  `);
  return KnowledgeHit.array().parse(rows);
}

/**
 * Shape's `find_records` (spec §5.5): the current decisions and principles that apply to the project
 * (its own and the builder-wide `you` ones) matching the query, best match first, each with its scope
 * and the date it was made, so the conversation can cite it ("Decided 2026-10-30: …"). Withdrawn,
 * superseded, retired and proposed ones are left out.
 */
export function findRecords(
  db: DbReader,
  projectId: ProjectId,
  query: string,
  limit: number,
): RecordHit[] {
  const match = ftsQuery(query);
  if (match === null) return [];
  // One column list for both legs, so the union ranks them together; each leg's own columns are
  // NULL in the other's.
  const rows = db.all(sql`
    SELECT * FROM (
      SELECT 'decision' AS kind, d.id AS id, d.question AS question, d.choice AS choice,
        d.rationale AS rationale, d.scope AS scope, NULL AS area, NULL AS statement,
        NULL AS principleKind, NULL AS topicKey, d.created_at AS createdAt,
        bm25(decisions_fts) AS rank
      FROM decisions_fts f JOIN decisions d ON d.rowid = f.rowid
      WHERE decisions_fts MATCH ${match} AND (d.project_id = ${projectId} OR d.project_id IS NULL)
        AND ${currentDecisionSql}
      UNION ALL
      SELECT 'principle' AS kind, p.id AS id, NULL AS question, NULL AS choice,
        p.rationale AS rationale, p.scope AS scope, p.area AS area, p.statement AS statement,
        p.kind AS principleKind, p.topic_key AS topicKey, p.created_at AS createdAt,
        bm25(principles_fts) AS rank
      FROM principles_fts f JOIN principles p ON p.rowid = f.rowid
      WHERE principles_fts MATCH ${match} AND (p.project_id = ${projectId} OR p.project_id IS NULL)
        AND ${currentPrincipleSql}
    )
    ORDER BY rank, id
    LIMIT ${limit}
  `);
  return RecordHit.array().parse(rows);
}

const PrincipleIdRows = z.array(z.object({ id: PrincipleId }));

/** Principles matching the query, best first; current ones unless `history`. */
export function searchPrincipleIds(
  db: DbReader,
  q: SearchQuery & { readonly kind?: PrincipleKind },
): PrincipleId[] {
  const match = ftsQuery(q.query, q.match);
  if (match === null) return [];
  const where = [sql`principles_fts MATCH ${match}`, ...narrow('p', q)];
  if (q.kind) where.push(sql`p.kind = ${q.kind}`);
  if (!q.history) where.push(currentPrincipleSql);
  const rows = db.all(sql`
    SELECT p.id AS id FROM principles_fts f JOIN principles p ON p.rowid = f.rowid
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY bm25(principles_fts), p.id
    LIMIT ${q.limit}`);
  return PrincipleIdRows.parse(rows).map((r) => r.id);
}

/** The current principles in scope for the project that match `query`, best first. */
export function searchPrinciples(
  db: DbReader,
  projectId: ProjectId,
  query: string,
  limit: number,
): PrincipleDto[] {
  return listPrinciples(db, {
    projectId,
    ids: searchPrincipleIds(db, { projectId, query, limit }),
  });
}

export const KnowledgeIndex = { Decisions: 'decisions_fts', Principles: 'principles_fts' } as const;
export type KnowledgeIndex = (typeof KnowledgeIndex)[keyof typeof KnowledgeIndex];

function sqliteCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

/**
 * The FTS indexes that disagree with their tables. FTS5's integrity-check with rank 1 also compares
 * the index with its content table; a mismatch is SQLITE_CORRUPT_VTAB.
 */
export function checkKnowledgeIndex(db: TendbDatabase): KnowledgeIndex[] {
  const broken: KnowledgeIndex[] = [];
  for (const index of Object.values(KnowledgeIndex)) {
    try {
      db.$client
        .prepare(`INSERT INTO ${index}(${index}, rank) VALUES ('integrity-check', 1)`)
        .run();
    } catch (error) {
      if (!sqliteCode(error)?.startsWith('SQLITE_CORRUPT')) throw error;
      broken.push(index);
    }
  }
  return broken;
}

/** The indexed text columns of each table; writes compose them (`composed`), and this does the rest. */
const INDEXED_TEXT = [
  { table: 'decisions', columns: ['question', 'choice', 'rationale'] },
  { table: 'principles', columns: ['statement', 'topic_key', 'source_quote'] },
] as const;

/**
 * Composes (NFC) the indexed text of rows written before writes did, so a record stored decomposed is
 * found by a composed query. Each update goes through the table's FTS triggers, which drop the old
 * entry and add the new one. Answers the number of rows changed; run at start, it is cheap when the
 * answer is 0.
 */
export function composeKnowledgeText(db: TendbDatabase): number {
  const client = db.$client;
  let changed = 0;
  const run = client.transaction(() => {
    for (const { table, columns } of INDEXED_TEXT) {
      const rows = z
        .array(z.object({ id: z.string() }).catchall(z.string().nullable()))
        .parse(client.prepare(`SELECT id, ${columns.join(', ')} FROM ${table}`).all());
      for (const row of rows) {
        const stale = columns.flatMap((column) => {
          const text = row[column];
          return text != null && text !== composed(text) ? [{ column, text: composed(text) }] : [];
        });
        if (stale.length === 0) continue;
        client
          .prepare(
            `UPDATE ${table} SET ${stale.map((s) => `${s.column} = ?`).join(', ')} WHERE id = ?`,
          )
          .run(...stale.map((s) => s.text), row.id);
        changed += 1;
      }
    }
  });
  run();
  return changed;
}

/** Rebuilds an FTS index from its content table. */
export function rebuildKnowledgeIndex(db: TendbDatabase, index: KnowledgeIndex): void {
  db.$client.prepare(`INSERT INTO ${index}(${index}) VALUES ('rebuild')`).run();
}
