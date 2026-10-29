import { EvidenceKind, currentStep, type EvidenceId } from '@10db/contracts';
import { listEvidence, type DbReader, type WorkstreamRow } from '@10db/db';

/**
 * The failure the lane is fixing: its latest gate run when that failed and none has passed since, or
 * the builder's note when they sent the work back to a step that has not been entered again since.
 * Sending the work back stamps the target's start in the same write as the note, so a step that
 * started later has already acted on it. A session that starts fresh needs it, since the
 * conversation that held it is gone.
 */
export function outstandingFixEvidence(reader: DbReader, row: WorkstreamRow): EvidenceId | null {
  const latest = listEvidence(reader, row.id)
    .filter((e) => e.kind === EvidenceKind.Gate || e.kind === EvidenceKind.Builder)
    .at(-1);
  if (!latest) return null;
  if (latest.kind === EvidenceKind.Gate) return latest.exitCode !== 0 ? latest.id : null;
  const startedAt = currentStep(row).startedAt;
  return startedAt === null || latest.createdAt >= startedAt ? latest.id : null;
}
