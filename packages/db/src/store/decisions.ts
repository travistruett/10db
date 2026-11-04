import {
  ConflictError,
  DecisionDto,
  EventType,
  InvalidError,
  KnowledgeState,
  mintId,
  NotFoundError,
  type DecisionId,
  type KnowledgeHit,
  type KnowledgeScope,
  type ProjectId,
  type SourceId,
} from '@10db/contracts';
import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export interface NewDecision {
  readonly projectId: ProjectId | null;
  readonly question: string;
  readonly choice: string;
  readonly rationale: string;
  readonly decidedBy: string;
  readonly scope: KnowledgeScope;
  readonly area: string | null;
  readonly sourceId: SourceId;
  /** The decision this one replaces; absent or null for a new chain. */
  readonly supersedesId?: DecisionId | null;
}

/** The newest decision that replaces `d` and has not been withdrawn (SQL over alias `d`). */
const SUCCESSOR = sql`(SELECT s.id FROM decisions s WHERE s.supersedes_id = d.id AND s.withdrawn_at IS NULL ORDER BY s.id DESC LIMIT 1)`;

/** True for a current decision: not withdrawn and not replaced by a live successor (SQL over alias `d`). */
export const currentDecisionSql = sql`(d.withdrawn_at IS NULL AND ${SUCCESSOR} IS NULL)`;

// Column aliases match DecisionDto, so each row parses as one; the state is derived here, never stored.
const SELECT_DECISION = sql`
  SELECT d.id AS id, d.project_id AS projectId, d.scope AS scope, d.area AS area,
    d.question AS question, d.choice AS choice, d.rationale AS rationale, d.decided_by AS decidedBy,
    d.supersedes_id AS supersedesId, ${SUCCESSOR} AS supersededById,
    CASE WHEN d.withdrawn_at IS NOT NULL THEN ${KnowledgeState.Withdrawn}
         WHEN ${SUCCESSOR} IS NOT NULL THEN ${KnowledgeState.Superseded}
         ELSE ${KnowledgeState.Current} END AS state,
    d.source_id AS sourceId, d.withdrawn_at AS withdrawnAt, d.withdrawn_reason AS withdrawnReason,
    d.created_at AS createdAt, d.updated_at AS updatedAt
  FROM decisions d`;

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
    data: {
      projectId: input.projectId,
      question: input.question,
      supersedesId: input.supersedesId ?? null,
    },
  });
  return id;
}

export type DecisionRow = typeof schema.decisions.$inferSelect;

export function getDecision(db: DbReader, id: DecisionId): DecisionRow {
  const row = db.select().from(schema.decisions).where(eq(schema.decisions.id, id)).get();
  if (!row) throw new NotFoundError('decision', id);
  return row;
}

/** One decision with its derived state and the decision that replaced it. */
export function getDecisionDto(db: DbReader, id: DecisionId): DecisionDto {
  const row = DecisionDto.array().parse(db.all(sql`${SELECT_DECISION} WHERE d.id = ${id}`))[0];
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

/** The head of the chain `id` belongs to: `id` itself when nothing live replaced it. */
export function decisionHead(db: DbReader, id: DecisionId): DecisionId {
  let head = id;
  for (let next = decisionSuccessor(db, head); next !== null; next = decisionSuccessor(db, head))
    head = next;
  return head;
}

/**
 * The decision of `id`'s chain that is current now, or null when none is. A withdrawn head hands the
 * chain back to its predecessor, so the walk goes back through `supersedes_id` past each withdrawn one.
 */
export function currentDecisionOf(db: DbReader, id: DecisionId): DecisionId | null {
  const head = decisionHead(db, id);
  const row = getDecision(db, head);
  if (row.withdrawnAt === null) return head;
  return row.supersedesId === null ? null : currentDecisionOf(db, row.supersedesId);
}

/** Where a script is told which decision to use instead, when the one it named is not current. */
function currentOne(db: DbReader, id: DecisionId): string {
  const current = currentDecisionOf(db, id);
  return current === null ? ' (none is current)' : ` (the current one is ${current})`;
}

export interface DecisionFilter {
  readonly projectId: ProjectId;
  readonly scope?: KnowledgeScope;
  readonly area?: string;
  /** Also superseded and withdrawn decisions. */
  readonly history?: boolean;
  /** Only these, in this order. */
  readonly ids?: readonly DecisionId[];
}

/** The project's decisions and the builder's own, newest first (or in `ids` order); current ones unless `history`. */
export function listDecisions(db: DbReader, filter: DecisionFilter): DecisionDto[] {
  if (filter.ids?.length === 0) return [];
  const where: SQL[] = [sql`(d.project_id = ${filter.projectId} OR d.project_id IS NULL)`];
  if (filter.scope) where.push(sql`d.scope = ${filter.scope}`);
  if (filter.area) where.push(sql`d.area = ${filter.area}`);
  if (!filter.history) where.push(currentDecisionSql);
  if (filter.ids)
    where.push(
      sql`d.id IN (${sql.join(
        filter.ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  const rows = DecisionDto.array().parse(
    db.all(sql`${SELECT_DECISION} WHERE ${sql.join(where, sql` AND `)} ORDER BY d.id DESC`),
  );
  const ids = filter.ids;
  if (!ids) return rows;
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.toSorted((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/**
 * Records `input` as the successor of a current decision: the builder's explicit supersede, at any
 * target (spec §4). Only a current decision can be superseded, so a chain stays linear.
 */
export function supersedeDecision(
  ctx: WriteContext,
  id: DecisionId,
  input: NewDecision,
): DecisionId {
  const old = getDecisionDto(ctx.tx, id);
  if (old.state !== KnowledgeState.Current)
    throw new ConflictError(
      `Decision ${id} is ${old.state}; only a current decision can be superseded${currentOne(ctx.tx, id)}`,
    );
  return insertDecision(ctx, { ...input, supersedesId: id });
}

/**
 * Withdraws a decision: the row stays as a tombstone with who, when and why, and search and the
 * context pack skip it. Only the head of a supersede chain can be withdrawn, so withdrawing a link
 * never makes its predecessor current beside its successor (M3 plan K1, K3; Shape spec §11).
 */
export function withdrawDecision(
  ctx: WriteContext,
  id: DecisionId,
  input: {
    readonly by: string;
    readonly reason: string;
    /** Where the withdrawal came from, when the write named a source. */
    readonly sourceId?: SourceId | null;
  },
): void {
  const reason = input.reason.trim();
  if (reason === '') throw new InvalidError('Say why the decision is withdrawn');
  const decision = getDecision(ctx.tx, id);
  if (decision.withdrawnAt !== null)
    throw new ConflictError(`Decision ${id} is already withdrawn${currentOne(ctx.tx, id)}`);
  const successor = decisionSuccessor(ctx.tx, id);
  if (successor !== null)
    throw new ConflictError(
      `A later decision (${successor}) supersedes this one; withdraw that one first${currentOne(ctx.tx, id)}`,
    );
  ctx.tx
    .update(schema.decisions)
    .set({
      withdrawnAt: ctx.now,
      withdrawnBy: input.by,
      withdrawnReason: reason,
      withdrawnSourceId: input.sourceId ?? null,
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
      scope: schema.decisions.scope,
      area: schema.decisions.area,
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
