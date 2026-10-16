import {
  EventType,
  KnowledgeHit,
  mintId,
  NotFoundError,
  type DecisionId,
  type DeviationId,
  type ProjectId,
  type ProposalId,
  type ProposalKind,
  type Severity,
  type SourceId,
  type SourceKind,
  type WorkstreamId,
} from '@10db/contracts';
import { desc, eq, isNull, or, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { Json } from '../json';
import type { DbReader, WriteContext } from './store';

export function insertSource(
  ctx: WriteContext,
  kind: SourceKind,
  ref: Record<string, Json>,
): SourceId {
  const id = mintId('Source');
  ctx.tx.insert(schema.sources).values({ id, kind, ref, createdAt: ctx.now }).run();
  return id;
}

export interface NewDecision {
  readonly projectId: ProjectId | null;
  readonly question: string;
  readonly choice: string;
  readonly rationale: string;
  readonly decidedBy: string;
  readonly scope: 'you' | 'project' | 'area';
  readonly area: string | null;
  readonly sourceId: SourceId;
}

export function insertDecision(ctx: WriteContext, input: NewDecision): DecisionId {
  const id = mintId('Decision');
  ctx.tx
    .insert(schema.decisions)
    .values({ id, ...input, supersedesId: null, createdAt: ctx.now, updatedAt: ctx.now })
    .run();
  ctx.emit({
    type: EventType.DecisionRecorded,
    entityType: 'decision',
    entityId: id,
    data: { projectId: input.projectId, question: input.question },
  });
  return id;
}

export function insertDeviation(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    readonly workstreamId: WorkstreamId | null;
    readonly cause: string;
    readonly severity: Severity;
    readonly signedReason: string;
    readonly sourceId: SourceId;
  },
): DeviationId {
  const id = mintId('Deviation');
  ctx.tx
    .insert(schema.deviations)
    .values({ id, ...input, resolution: null, createdAt: ctx.now, updatedAt: ctx.now })
    .run();
  ctx.emit({
    type: EventType.DeviationRecorded,
    entityType: 'deviation',
    entityId: id,
    data: { workstreamId: input.workstreamId, cause: input.cause },
  });
  return id;
}

export function insertProposal(
  ctx: WriteContext,
  input: {
    readonly projectId: ProjectId;
    readonly kind: ProposalKind;
    readonly title: string;
    readonly body: string;
    readonly sourceId: SourceId;
  },
): ProposalId {
  const id = mintId('Proposal');
  ctx.tx
    .insert(schema.proposals)
    .values({
      id,
      ...input,
      status: 'pending',
      rationale: null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .run();
  ctx.emit({
    type: EventType.ProposalCreated,
    entityType: 'proposal',
    entityId: id,
    data: { kind: input.kind, title: input.title },
  });
  return id;
}

export type ProposalRow = typeof schema.proposals.$inferSelect;
export type ProposalStatus = ProposalRow['status'];

export function getProposal(db: DbReader, id: ProposalId): ProposalRow {
  const row = db.select().from(schema.proposals).where(eq(schema.proposals.id, id)).get();
  if (!row) throw new NotFoundError('proposal', id);
  return row;
}

/** Records the builder's verdict on a proposal (spec §4: status plus the accept/reject rationale). */
export function resolveProposal(
  ctx: WriteContext,
  id: ProposalId,
  verdict: {
    readonly status: Exclude<ProposalStatus, 'pending'>;
    readonly rationale: string | null;
  },
): void {
  const result = ctx.tx
    .update(schema.proposals)
    .set({ ...verdict, updatedAt: ctx.now })
    .where(eq(schema.proposals.id, id))
    .run();
  if (result.changes === 0) throw new NotFoundError('proposal', id);
  ctx.emit({
    type: EventType.ProposalResolved,
    entityType: 'proposal',
    entityId: id,
    data: { status: verdict.status },
  });
}

/** Turns free text into an FTS5 query of quoted terms joined by OR, so user text is never parsed as syntax. */
function ftsQuery(text: string): string | null {
  const terms = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.length === 0 ? null : terms.map((t) => `"${t}"`).join(' OR ');
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
    ORDER BY bm25(decisions_fts), d.id
    LIMIT ${limit}
  `);
  return KnowledgeHit.array().parse(rows);
}

export function listRecentDecisions(
  db: DbReader,
  projectId: ProjectId,
  limit: number,
): KnowledgeHit[] {
  return db
    .select({
      id: schema.decisions.id,
      question: schema.decisions.question,
      choice: schema.decisions.choice,
      rationale: schema.decisions.rationale,
    })
    .from(schema.decisions)
    .where(or(eq(schema.decisions.projectId, projectId), isNull(schema.decisions.projectId)))
    .orderBy(desc(schema.decisions.id))
    .limit(limit)
    .all()
    .map((r) => ({ kind: 'decision', ...r }));
}
