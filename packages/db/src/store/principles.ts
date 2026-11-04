import {
  ConflictError,
  EventType,
  InvalidError,
  KnowledgeScope,
  KnowledgeState,
  mintId,
  NotFoundError,
  PrincipleDto,
  PrincipleStatus,
  ProposalStatus,
  targetColumns,
  type KnowledgeTarget,
  type PrincipleId,
  type PrincipleKind,
  type ProjectId,
  type ProposalId,
  type SourceId,
} from '@10db/contracts';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Json } from '../json';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

/** A confirmed successor of `p`: it names `p`, isn't withdrawn and was confirmed (spec §4). */
const SUCCESSOR = sql`(SELECT s.id FROM principles s WHERE s.supersedes_id = p.id AND s.withdrawn_at IS NULL AND s.status <> ${PrincipleStatus.Proposed} ORDER BY s.id DESC LIMIT 1)`;

/** True for a current principle: confirmed, not withdrawn, not superseded (SQL over alias `p`). */
export const currentPrincipleSql = sql`(p.withdrawn_at IS NULL AND p.status = ${PrincipleStatus.Confirmed} AND ${SUCCESSOR} IS NULL)`;

// Column aliases match PrincipleDto, so each row parses as one; the state is derived here, never stored.
const SELECT_PRINCIPLE = sql`
  SELECT p.id AS id, p.project_id AS projectId, p.scope AS scope, p.area AS area,
    p.statement AS statement, p.rationale AS rationale, p.kind AS kind, p.topic_key AS topicKey,
    p.status AS status,
    CASE WHEN p.withdrawn_at IS NOT NULL THEN ${KnowledgeState.Withdrawn}
         WHEN p.status = ${PrincipleStatus.Proposed} THEN ${KnowledgeState.Proposed}
         WHEN ${SUCCESSOR} IS NOT NULL THEN ${KnowledgeState.Superseded}
         WHEN p.status = ${PrincipleStatus.Retired} THEN ${KnowledgeState.Retired}
         ELSE ${KnowledgeState.Current} END AS state,
    p.supersedes_id AS supersedesId, ${SUCCESSOR} AS supersededById, p.source_id AS sourceId,
    p.source_quote AS sourceQuote, p.speaker AS speaker, p.confirmed_by AS confirmedBy,
    p.confirmed_at AS confirmedAt, p.retired_at AS retiredAt, p.retired_by AS retiredBy,
    p.retired_reason AS retiredReason, p.withdrawn_at AS withdrawnAt, p.withdrawn_by AS withdrawnBy,
    p.withdrawn_reason AS withdrawnReason,
    p.created_at AS createdAt, p.updated_at AS updatedAt
  FROM principles p`;

function select(db: DbReader, where: SQL): PrincipleDto[] {
  return PrincipleDto.array().parse(
    db.all(sql`${SELECT_PRINCIPLE} WHERE ${where} ORDER BY p.id DESC`),
  );
}

function saved(ctx: WriteContext, id: PrincipleId, data: Record<string, Json>): void {
  ctx.emit({ type: EventType.PrincipleSaved, entityType: 'principle', entityId: id, data });
}

function requireReason(reason: string, what: string): string {
  const trimmed = reason.trim();
  if (trimmed === '') throw new InvalidError(`Say why the principle is ${what}`);
  return trimmed;
}

export function getPrinciple(db: DbReader, id: PrincipleId): PrincipleDto {
  const row = select(db, sql`p.id = ${id}`)[0];
  if (!row) throw new NotFoundError('principle', id);
  return row;
}

/** The stored row, for the columns a `PrincipleDto` leaves out: the source ids of its actions. */
export function getPrincipleRow(
  db: DbReader,
  id: PrincipleId,
): typeof schema.principles.$inferSelect {
  const row = db.select().from(schema.principles).where(eq(schema.principles.id, id)).get();
  if (!row) throw new NotFoundError('principle', id);
  return row;
}

/** The principle that replaced the chain `id` belongs to, or `id` itself when it is the head. */
export function principleHead(db: DbReader, id: PrincipleId): PrincipleId {
  let head = id;
  for (
    let next = getPrinciple(db, head).supersededById;
    next !== null;
    next = getPrinciple(db, head).supersededById
  )
    head = next;
  return head;
}

/**
 * The principle that is current now in `id`'s place, or null when none is. A withdrawn head hands its
 * chain back to its predecessor, so the walk goes back through `supersedes_id`. A retired head ends the
 * chain: its predecessors stay superseded, and only a later principle under the key can be current.
 */
export function currentPrincipleOf(db: DbReader, id: PrincipleId): PrincipleId | null {
  const head = getPrinciple(db, principleHead(db, id));
  if (head.state === KnowledgeState.Current) return head.id;
  if (head.state === KnowledgeState.Withdrawn && head.supersedesId !== null)
    return currentPrincipleOf(db, head.supersedesId);
  return currentPrincipleFor(db, head.topicKey, targetOf(head))?.id ?? null;
}

/** The pending proposal that decides a proposed principle, or null when none does. */
export function pendingProposalOf(db: DbReader, id: PrincipleId): ProposalId | null {
  return (
    db
      .select({ id: schema.proposals.id })
      .from(schema.proposals)
      .where(
        and(
          eq(schema.proposals.principleId, id),
          eq(schema.proposals.status, ProposalStatus.Pending),
        ),
      )
      .get()?.id ?? null
  );
}

/** What a 409 adds about a principle that isn't current: what to act on instead, or that nothing is. */
function currentOne(db: DbReader, p: PrincipleDto): string {
  const proposal = pendingProposalOf(db, p.id);
  if (proposal !== null) return ` (accept or reject proposal ${proposal} instead)`;
  const current = currentPrincipleOf(db, p.id);
  return current === null ? ' (none is current)' : ` (the current one is ${current})`;
}

/** The target a stored principle applies to. */
function targetOf(p: PrincipleDto): KnowledgeTarget {
  switch (p.scope) {
    case KnowledgeScope.You:
      return { scope: KnowledgeScope.You };
    case KnowledgeScope.Project:
    case KnowledgeScope.Area:
      if (p.projectId === null) throw new InvalidError(`Principle ${p.id} has no project`);
      if (p.scope === KnowledgeScope.Area) {
        if (p.area === null) throw new InvalidError(`Principle ${p.id} has no area`);
        return { scope: KnowledgeScope.Area, projectId: p.projectId, area: p.area };
      }
      return { scope: KnowledgeScope.Project, projectId: p.projectId };
  }
}

/** The current principle with this key at exactly this target, if any. */
export function currentPrincipleFor(
  db: DbReader,
  topicKey: string,
  target: KnowledgeTarget,
): PrincipleDto | undefined {
  const c = targetColumns(target);
  return select(
    db,
    sql`p.topic_key = ${topicKey} AND p.scope = ${c.scope} AND p.project_id IS ${c.projectId} AND p.area IS ${c.area} AND ${currentPrincipleSql}`,
  )[0];
}

export interface NewPrinciple {
  readonly target: KnowledgeTarget;
  readonly statement: string;
  readonly kind: PrincipleKind;
  readonly topicKey: string;
  readonly status: typeof PrincipleStatus.Proposed | typeof PrincipleStatus.Confirmed;
  readonly sourceId: SourceId;
  readonly sourceQuote: string | null;
  /** Why the rule holds; shown beside the statement, not searched. */
  readonly rationale?: string | null;
  /** Who stated it: `me`, or `agent:<session>`. */
  readonly speaker: string | null;
  readonly confirmedBy: string | null;
}

function insertRow(
  ctx: WriteContext,
  input: NewPrinciple,
  supersedesId: PrincipleId | null,
): PrincipleId {
  const id = mintId('Principle');
  const confirmed = input.status === PrincipleStatus.Confirmed;
  ctx.tx
    .insert(schema.principles)
    .values({
      id,
      ...targetColumns(input.target),
      statement: input.statement,
      rationale: input.rationale ?? null,
      kind: input.kind,
      topicKey: input.topicKey,
      status: input.status,
      supersedesId,
      sourceId: input.sourceId,
      sourceQuote: input.sourceQuote,
      speaker: input.speaker,
      confirmedBy: confirmed ? input.confirmedBy : null,
      confirmedAt: confirmed ? ctx.now : null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .run();
  saved(ctx, id, { status: input.status, topicKey: input.topicKey });
  return id;
}

/** Inserts a principle; a confirmed one supersedes the current one with its key and target (spec §4). */
export function insertPrinciple(ctx: WriteContext, input: NewPrinciple): PrincipleDto {
  const previous =
    input.status === PrincipleStatus.Confirmed
      ? currentPrincipleFor(ctx.tx, input.topicKey, input.target)
      : undefined;
  const id = insertRow(ctx, input, previous?.id ?? null);
  if (previous) saved(ctx, previous.id, { supersededBy: id });
  return getPrinciple(ctx.tx, id);
}

export interface ConfirmPrinciple {
  readonly target: KnowledgeTarget;
  readonly statement?: string | undefined;
  readonly kind?: PrincipleKind | undefined;
  readonly topicKey?: string | undefined;
  readonly confirmedBy: string;
  /** Where the confirmation came from, when the write named a source. */
  readonly confirmedSourceId?: SourceId | null | undefined;
}

/** Confirms a proposed principle at a target, with any edits; it supersedes like an insert does. */
export function confirmPrinciple(
  ctx: WriteContext,
  id: PrincipleId,
  input: ConfirmPrinciple,
): PrincipleDto {
  const current = getPrinciple(ctx.tx, id);
  if (current.state !== KnowledgeState.Proposed)
    throw new ConflictError(
      `Principle ${id} is ${current.state}; only a proposed principle can be confirmed`,
    );
  const topicKey = input.topicKey ?? current.topicKey;
  const previous = currentPrincipleFor(ctx.tx, topicKey, input.target);
  ctx.tx
    .update(schema.principles)
    .set({
      ...targetColumns(input.target),
      statement: input.statement ?? current.statement,
      kind: input.kind ?? current.kind,
      topicKey,
      status: PrincipleStatus.Confirmed,
      supersedesId: previous?.id ?? null,
      confirmedBy: input.confirmedBy,
      confirmedAt: ctx.now,
      confirmedSourceId: input.confirmedSourceId ?? null,
      updatedAt: ctx.now,
    })
    .where(eq(schema.principles.id, id))
    .run();
  saved(ctx, id, { status: PrincipleStatus.Confirmed, topicKey });
  if (previous) saved(ctx, previous.id, { supersededBy: id });
  return getPrinciple(ctx.tx, id);
}

export interface SupersedePrinciple {
  /** Where the successor applies; the predecessor's target when absent. */
  readonly target?: KnowledgeTarget | undefined;
  readonly statement?: string | undefined;
  readonly kind?: PrincipleKind | undefined;
  readonly topicKey?: string | undefined;
  readonly rationale?: string | null | undefined;
  readonly sourceId: SourceId;
  readonly sourceQuote?: string | null | undefined;
  readonly speaker?: string | null | undefined;
  readonly confirmedBy: string;
}

/**
 * Replaces a current principle by an explicit link: the successor names it in `supersedes_id` and may
 * change the statement, kind, topic key or target (spec §4). A successor whose key already has another
 * current principle at its target is refused; with the same check in `withdrawPrinciple`, a key never
 * has two current principles at one target.
 */
export function supersedePrinciple(
  ctx: WriteContext,
  id: PrincipleId,
  input: SupersedePrinciple,
): PrincipleDto {
  const old = getPrinciple(ctx.tx, id);
  if (old.state !== KnowledgeState.Current)
    throw new ConflictError(
      `Principle ${id} is ${old.state}; only a current principle can be superseded${currentOne(ctx.tx, old)}`,
    );
  const target = input.target ?? targetOf(old);
  const topicKey = input.topicKey ?? old.topicKey;
  const clash = currentPrincipleFor(ctx.tx, topicKey, target);
  if (clash && clash.id !== id)
    throw new ConflictError(
      `Principle ${clash.id} already holds the key ${topicKey} at that scope; supersede or retire it first`,
    );
  const next = insertRow(
    ctx,
    {
      target,
      statement: input.statement ?? old.statement,
      kind: input.kind ?? old.kind,
      topicKey,
      status: PrincipleStatus.Confirmed,
      sourceId: input.sourceId,
      sourceQuote: input.sourceQuote ?? null,
      rationale: input.rationale === undefined ? old.rationale : input.rationale,
      speaker: input.speaker ?? null,
      confirmedBy: input.confirmedBy,
    },
    id,
  );
  saved(ctx, id, { supersededBy: next });
  return getPrinciple(ctx.tx, next);
}

export function retirePrinciple(
  ctx: WriteContext,
  id: PrincipleId,
  by: string,
  reason: string,
  sourceId: SourceId | null = null,
): PrincipleDto {
  const why = requireReason(reason, 'retired');
  const current = getPrinciple(ctx.tx, id);
  if (current.state !== KnowledgeState.Current)
    throw new ConflictError(
      `Principle ${id} is ${current.state}; only a current principle can be retired${currentOne(ctx.tx, current)}`,
    );
  ctx.tx
    .update(schema.principles)
    .set({
      status: PrincipleStatus.Retired,
      retiredAt: ctx.now,
      retiredBy: by,
      retiredReason: why,
      retiredSourceId: sourceId,
      updatedAt: ctx.now,
    })
    .where(eq(schema.principles.id, id))
    .run();
  saved(ctx, id, { status: PrincipleStatus.Retired, by });
  return getPrinciple(ctx.tx, id);
}

/** Refuses to bring `p`'s predecessor back as current if its key and target now belong to another. */
function refuseRevivingClash(db: DbReader, p: PrincipleDto): void {
  if (p.state !== KnowledgeState.Current || p.supersedesId === null) return;
  const predecessor = getPrinciple(db, p.supersedesId);
  const clash = currentPrincipleFor(db, predecessor.topicKey, targetOf(predecessor));
  if (clash && clash.id !== p.id)
    throw new ConflictError(
      `Principle ${clash.id} now holds the key ${predecessor.topicKey} at the scope of ${predecessor.id}, which withdrawing ${p.id} would make current again; retire ${clash.id} first`,
    );
}

/**
 * Withdraws a current principle, or a proposed one when its proposal is rejected: the row stays as a
 * tombstone with who and why (spec §9). Only the head of a chain can go; withdrawing a superseded link
 * would make its predecessor current beside its successor, two current principles under one key. The
 * head is refused too if its predecessor's key and target have since gone to another principle, which
 * an explicit supersede that moved the key or target allows.
 */
export function withdrawPrinciple(
  ctx: WriteContext,
  id: PrincipleId,
  by: string,
  reason: string,
  sourceId: SourceId | null = null,
): PrincipleDto {
  const why = requireReason(reason, 'withdrawn');
  const current = getPrinciple(ctx.tx, id);
  if (current.supersededById !== null)
    throw new ConflictError(
      `A later principle (${current.supersededById}) supersedes principle ${id}; only the head of a chain can be withdrawn${currentOne(ctx.tx, current)}`,
    );
  if (current.state !== KnowledgeState.Current && current.state !== KnowledgeState.Proposed)
    throw new ConflictError(
      `Principle ${id} is ${current.state}; only a current or proposed principle can be withdrawn${currentOne(ctx.tx, current)}`,
    );
  refuseRevivingClash(ctx.tx, current);
  ctx.tx
    .update(schema.principles)
    .set({
      withdrawnAt: ctx.now,
      withdrawnBy: by,
      withdrawnReason: why,
      withdrawnSourceId: sourceId,
      updatedAt: ctx.now,
    })
    .where(eq(schema.principles.id, id))
    .run();
  saved(ctx, id, { withdrawn: true, by });
  return getPrinciple(ctx.tx, id);
}

export interface PrincipleFilter {
  readonly projectId: ProjectId;
  readonly scope?: KnowledgeScope;
  readonly area?: string;
  readonly kind?: PrincipleKind;
  /** Also proposed, superseded, retired and withdrawn principles. */
  readonly history?: boolean;
  /** Only these, in this order. */
  readonly ids?: readonly PrincipleId[];
}

/** The project's principles and the builder's own, newest first (or in `ids` order); current ones unless `history`. */
export function listPrinciples(db: DbReader, filter: PrincipleFilter): PrincipleDto[] {
  if (filter.ids?.length === 0) return [];
  const where: SQL[] = [sql`(p.project_id = ${filter.projectId} OR p.project_id IS NULL)`];
  if (filter.scope) where.push(sql`p.scope = ${filter.scope}`);
  if (filter.area) where.push(sql`p.area = ${filter.area}`);
  if (filter.kind) where.push(sql`p.kind = ${filter.kind}`);
  if (!filter.history) where.push(currentPrincipleSql);
  if (filter.ids)
    where.push(
      sql`p.id IN (${sql.join(
        filter.ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
  const rows = select(db, sql.join(where, sql` AND `));
  const ids = filter.ids;
  if (!ids) return rows;
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.toSorted((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}
