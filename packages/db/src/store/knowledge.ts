import {
  ConflictError,
  EventType,
  InvalidError,
  KnowledgeHit,
  mintId,
  NotFoundError,
  RecordHit,
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
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
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
  /** The decision this one replaces; absent or null for a new chain. */
  readonly supersedesId?: DecisionId | null;
}

export function insertDecision(ctx: WriteContext, input: NewDecision): DecisionId {
  const id = mintId('Decision');
  ctx.tx
    .insert(schema.decisions)
    .values({
      id,
      ...input,
      supersedesId: input.supersedesId ?? null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .run();
  ctx.emit({
    type: EventType.DecisionRecorded,
    entityType: 'decision',
    entityId: id,
    data: { projectId: input.projectId, question: input.question },
  });
  return id;
}

export type DecisionRow = typeof schema.decisions.$inferSelect;

export function getDecision(db: DbReader, id: DecisionId): DecisionRow {
  const row = db.select().from(schema.decisions).where(eq(schema.decisions.id, id)).get();
  if (!row) throw new NotFoundError('decision', id);
  return row;
}

/** The decision that replaced this one and has not been withdrawn, or null when this is the head. */
export function decisionSuccessor(db: DbReader, id: DecisionId): DecisionId | null {
  return (
    db
      .select({ id: schema.decisions.id })
      .from(schema.decisions)
      .where(and(eq(schema.decisions.supersedesId, id), isNull(schema.decisions.withdrawnAt)))
      .get()?.id ?? null
  );
}

/**
 * Withdraws a decision: the row stays as a tombstone with who, when and why, and search and the
 * context pack skip it. Only the head of a supersede chain can be withdrawn, so withdrawing a link
 * never makes its predecessor current beside its successor (M3 plan K1, K3; Shape spec §11).
 */
export function withdrawDecision(
  ctx: WriteContext,
  id: DecisionId,
  input: { readonly by: string; readonly reason: string },
): void {
  const reason = input.reason.trim();
  if (reason === '') throw new InvalidError('Say why the decision is withdrawn');
  const decision = getDecision(ctx.tx, id);
  if (decision.withdrawnAt !== null) throw new ConflictError('This decision is already withdrawn');
  const successor = decisionSuccessor(ctx.tx, id);
  if (successor !== null)
    throw new ConflictError(
      `A later decision (${successor}) supersedes this one; withdraw that one first`,
    );
  ctx.tx
    .update(schema.decisions)
    .set({
      withdrawnAt: ctx.now,
      withdrawnBy: input.by,
      withdrawnReason: reason,
      updatedAt: ctx.now,
    })
    .where(eq(schema.decisions.id, id))
    .run();
  ctx.emit({
    type: EventType.DecisionWithdrawn,
    entityType: 'decision',
    entityId: id,
    data: { projectId: decision.projectId, reason },
  });
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
      AND d.withdrawn_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM decisions s WHERE s.supersedes_id = d.id AND s.withdrawn_at IS NULL
      )
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
      AND d.withdrawn_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM decisions s WHERE s.supersedes_id = d.id AND s.withdrawn_at IS NULL
      )
    ORDER BY bm25(decisions_fts), d.id
    LIMIT ${limit}
  `);
  return RecordHit.array().parse(rows);
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
    .where(
      and(
        or(eq(schema.decisions.projectId, projectId), isNull(schema.decisions.projectId)),
        isNull(schema.decisions.withdrawnAt),
        // A decision a later one replaced is history, not context.
        sql`NOT EXISTS (
          SELECT 1 FROM decisions s WHERE s.supersedes_id = ${schema.decisions.id} AND s.withdrawn_at IS NULL
        )`,
      ),
    )
    .orderBy(desc(schema.decisions.id))
    .limit(limit)
    .all()
    .map((r) => ({ kind: 'decision', ...r }));
}
