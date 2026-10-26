import type { EvidenceId, WorkstreamId } from '@10db/contracts';
import { listEvidence, type DbReader } from '@10db/db';

/** The lane's latest gate run failed and none has passed since: the evidence it is fixing. */
export function failedGateEvidence(reader: DbReader, id: WorkstreamId): EvidenceId | null {
  const lastGate = listEvidence(reader, id)
    .filter((e) => e.kind === 'gate')
    .at(-1);
  return lastGate && lastGate.exitCode !== 0 ? lastGate.id : null;
}
