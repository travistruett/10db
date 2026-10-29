import {
  EventType,
  mintId,
  NotFoundError,
  EvidenceDto,
  type EvidenceId,
  type EvidenceKind,
  type WorkstreamId,
} from '@10db/contracts';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

interface NewEvidenceBase {
  readonly workstreamId: WorkstreamId;
  readonly summary: string;
  readonly logPath: string | null;
  readonly commitShas: readonly string[];
}

/** A gate or agent check records its command and exit code; the builder's note has neither. */
export type NewEvidence =
  | (NewEvidenceBase & {
      readonly kind: typeof EvidenceKind.Gate | typeof EvidenceKind.Agent;
      readonly command: string;
      readonly exitCode: number;
    })
  | (NewEvidenceBase & {
      readonly kind: typeof EvidenceKind.Builder;
      readonly command: null;
      readonly exitCode: null;
    });

export function insertEvidence(ctx: WriteContext, input: NewEvidence): EvidenceDto {
  const row: EvidenceDto = {
    id: mintId('Evidence'),
    ...input,
    commitShas: [...input.commitShas],
    createdAt: ctx.now,
  };
  ctx.tx.insert(schema.evidence).values(row).run();
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
  return EvidenceDto.parse(row);
}

export function listEvidence(db: DbReader, workstreamId: WorkstreamId): EvidenceDto[] {
  return db
    .select()
    .from(schema.evidence)
    .where(eq(schema.evidence.workstreamId, workstreamId))
    .orderBy(asc(schema.evidence.id))
    .all()
    .map((row) => EvidenceDto.parse(row));
}
