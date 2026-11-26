import {
  type AcceptanceDetail,
  type WatchpointDetail,
  type EvalCoverageDetail,
  EventType,
  EvidenceKind,
  mintId,
  NotFoundError,
  EvidenceDto,
  type EvidenceId,
  type TaskScreenId,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, desc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

interface NewEvidenceBase {
  readonly workstreamId: WorkstreamId;
  readonly summary: string;
  readonly logPath: string | null;
  readonly commitShas: readonly string[];
}

/** A gate or agent check records its command and exit code; a note or `no_revert` record has neither; a browser record names its picture. */
export type NewEvidence =
  | (NewEvidenceBase & {
      readonly kind: typeof EvidenceKind.Gate | typeof EvidenceKind.Agent;
      readonly command: string;
      readonly exitCode: number;
    })
  | (NewEvidenceBase & {
      readonly kind: typeof EvidenceKind.Builder | typeof EvidenceKind.NoRevert;
      readonly command: null;
      readonly exitCode: null;
    })
  | (NewEvidenceBase & {
      readonly kind: typeof EvidenceKind.Watchpoint;
      readonly command: null;
      readonly exitCode: null;
      readonly detail: WatchpointDetail;
    })
  | (NewEvidenceBase & {
      readonly kind: typeof EvidenceKind.EvalCoverage;
      readonly command: null;
      readonly exitCode: null;
      readonly detail: EvalCoverageDetail;
    })
  | (NewEvidenceBase & {
      readonly kind: typeof EvidenceKind.Acceptance;
      readonly command: null;
      readonly exitCode: null;
      readonly detail: AcceptanceDetail;
    })
  | (NewEvidenceBase & {
      readonly kind: typeof EvidenceKind.Browser;
      readonly command: null;
      readonly exitCode: null;
      readonly screenId: TaskScreenId;
    });

/** A stored evidence row does not satisfy the evidence contract. */
export class InvalidEvidenceRowError extends Error {
  override readonly name = 'InvalidEvidenceRowError';
  readonly evidenceId: string;

  constructor(evidenceId: string, cause: unknown) {
    super(`evidence ${evidenceId} is not a valid evidence record`, { cause });
    this.evidenceId = evidenceId;
  }
}

function parseRow(row: { readonly id: string }): EvidenceDto {
  const parsed = EvidenceDto.safeParse(row);
  if (!parsed.success) throw new InvalidEvidenceRowError(row.id, parsed.error);
  return parsed.data;
}

export function insertEvidence(ctx: WriteContext, input: NewEvidence): EvidenceDto {
  const stamp = { id: mintId('Evidence'), commitShas: [...input.commitShas], createdAt: ctx.now };
  // Acceptance, Watchpoint and EvalCoverage rows keep the reading they carry; every other kind has none.
  const row: EvidenceDto =
    input.kind === EvidenceKind.Acceptance ||
    input.kind === EvidenceKind.Watchpoint ||
    input.kind === EvidenceKind.EvalCoverage
      ? { ...input, ...stamp }
      : { ...input, ...stamp, detail: null };
  ctx.tx
    .insert(schema.evidence)
    .values({ ...row, screenId: input.kind === EvidenceKind.Browser ? input.screenId : null })
    .run();
  ctx.emit({
    type: EventType.EvidenceRecorded,
    entityType: 'evidence',
    entityId: row.id,
    data: { workstreamId: input.workstreamId, exitCode: input.exitCode, kind: input.kind },
  });
  return row;
}

export function getEvidence(db: DbReader, id: EvidenceId): EvidenceDto {
  const row = db.select().from(schema.evidence).where(eq(schema.evidence.id, id)).get();
  if (!row) throw new NotFoundError('evidence', id);
  return parseRow(row);
}

export function listEvidence(db: DbReader, workstreamId: WorkstreamId): EvidenceDto[] {
  return db
    .select()
    .from(schema.evidence)
    .where(eq(schema.evidence.workstreamId, workstreamId))
    .orderBy(asc(schema.evidence.id))
    .all()
    .map(parseRow);
}

/** A workstream's newest evidence row of one kind, read without parsing its other rows; null when it has none. */
export function newestEvidenceOfKind(
  db: DbReader,
  workstreamId: WorkstreamId,
  kind: EvidenceKind,
): EvidenceDto | null {
  const row = db
    .select()
    .from(schema.evidence)
    .where(and(eq(schema.evidence.workstreamId, workstreamId), eq(schema.evidence.kind, kind)))
    .orderBy(desc(schema.evidence.id))
    .get();
  return row === undefined ? null : parseRow(row);
}
