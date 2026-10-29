import { EvidenceKind, StepRole, currentStep, type EvidenceId } from '@10db/contracts';
import { listEvidence, type DbReader, type WorkstreamRow } from '@10db/db';

/**
 * The failure the lane is fixing: its latest gate run when that failed and none has passed since, or
 * the builder's note when they sent the work back and the implement step has not finished the fix yet.
 * A session that starts fresh needs it, since the conversation that held it is gone.
 */
export function outstandingFixEvidence(reader: DbReader, row: WorkstreamRow): EvidenceId | null {
  const latest = listEvidence(reader, row.id)
    .filter((e) => e.kind === EvidenceKind.Gate || e.kind === EvidenceKind.Builder)
    .at(-1);
  if (!latest) return null;
  if (latest.kind === EvidenceKind.Gate) return latest.exitCode !== 0 ? latest.id : null;
  // Once the work moves past the implement step the note has been acted on.
  return currentStep(row).role === StepRole.Implement ? latest.id : null;
}
