import {
  DecisionId,
  KnowledgeHit,
  PrincipleId,
  RecordHit,
  type KnowledgeScope,
  type PrincipleDto,
  type PrincipleKind,
  type ProjectId,
} from '@10db/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { TendbDatabase } from '../database';
import { currentDecisionSql } from './decisions';
import { currentPrincipleSql, listPrinciples } from './principles';
import type { DbReader } from './store';

// Every full-text query lives here, so the storage engine can change later (packages/db/AGENTS.md).

/** Turns free text into an FTS5 query of quoted terms joined by OR, so user text is never parsed as syntax. */
function ftsQuery(text: string): string | null {
  const terms = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.length === 0 ? null : terms.map((t) => `"${t}"`).join(' OR ');
}

export interface SearchQuery {
  readonly projectId: ProjectId;
  readonly query: string;
  readonly limit: number;
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
  const match = ftsQuery(q.query);
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
    SELECT 'decision' AS kind, d.id AS id, d.question AS question, d.choice AS choice, d.rationale AS rationale
    FROM decisions_fts f JOIN decisions d ON d.rowid = f.rowid
    WHERE decisions_fts MATCH ${match} AND (d.project_id = ${projectId} OR d.project_id IS NULL)
      AND ${currentDecisionSql}
    ORDER BY bm25(decisions_fts), d.id
    LIMIT ${limit}
  `);
  return KnowledgeHit.array().parse(rows);
}

/**
 * Shape's `find_records` (spec §5.5): the current decisions that apply to the project (its own and
 * the builder-wide `you` ones) matching the query, each with its scope and the date it was made, so
 * the conversation can cite it ("Decided 2026-10-30: …"). Withdrawn and superseded ones are left out.
 */
export function findRecords(
  db: DbReader,
  projectId: ProjectId,
  query: string,
  limit: number,
): RecordHit[] {
  const match = ftsQuery(query);
  if (match === null) return [];
  const rows = db.all(sql`
    SELECT 'decision' AS kind, d.id AS id, d.question AS question, d.choice AS choice,
      d.rationale AS rationale, d.scope AS scope, d.created_at AS createdAt
    FROM decisions_fts f JOIN decisions d ON d.rowid = f.rowid
    WHERE decisions_fts MATCH ${match} AND (d.project_id = ${projectId} OR d.project_id IS NULL)
      AND ${currentDecisionSql}
    ORDER BY bm25(decisions_fts), d.id
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
  const match = ftsQuery(q.query);
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

/** Rebuilds an FTS index from its content table. */
export function rebuildKnowledgeIndex(db: TendbDatabase, index: KnowledgeIndex): void {
  db.$client.prepare(`INSERT INTO ${index}(${index}) VALUES ('rebuild')`).run();
}
