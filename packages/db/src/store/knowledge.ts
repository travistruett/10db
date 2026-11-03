import {
  EventType,
  mintId,
  NotFoundError,
  type DeviationId,
  type PrincipleId,
  type ProjectId,
  type ProposalDto,
  type ProposalId,
  type ProposalKind,
  type ProposalStatus,
  type Severity,
  type SourceId,
  type SourceKind,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { Json } from '../json';
import { getPrinciple } from './principles';
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

export type SourceRow = typeof schema.sources.$inferSelect;

/** The `sources` row a record points at, for its provenance. */
export function getSource(db: DbReader, id: SourceId): SourceRow {
  const row = db.select().from(schema.sources).where(eq(schema.sources.id, id)).get();
  if (!row) throw new NotFoundError('source', id);
  return row;
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
    /** The proposed principle, for a principle proposal. */
    readonly principleId?: PrincipleId | null;
  },
): ProposalId {
  const id = mintId('Proposal');
  ctx.tx
    .insert(schema.proposals)
    .values({
      id,
      ...input,
      principleId: input.principleId ?? null,
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

export function getProposal(db: DbReader, id: ProposalId): ProposalRow {
  const row = db.select().from(schema.proposals).where(eq(schema.proposals.id, id)).get();
  if (!row) throw new NotFoundError('proposal', id);
  return row;
}

function toProposalDto(db: DbReader, row: ProposalRow): ProposalDto {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    title: row.title,
    body: row.body,
    status: row.status,
    rationale: row.rationale,
    principle: row.principleId ? getPrinciple(db, row.principleId) : null,
    sourceId: row.sourceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A proposal with its proposed principle, if it has one. */
export function getProposalDto(db: DbReader, id: ProposalId): ProposalDto {
  return toProposalDto(db, getProposal(db, id));
}

/** A project's proposals in one status, oldest first, as the inbox orders them. */
export function listProposals(
  db: DbReader,
  filter: { readonly projectId: ProjectId; readonly status: ProposalStatus },
): ProposalDto[] {
  return db
    .select()
    .from(schema.proposals)
    .where(
      and(
        eq(schema.proposals.projectId, filter.projectId),
        eq(schema.proposals.status, filter.status),
      ),
    )
    .orderBy(asc(schema.proposals.id))
    .all()
    .map((row) => toProposalDto(db, row));
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
