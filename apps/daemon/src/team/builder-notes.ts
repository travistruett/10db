import { EvidenceKind, type WorkstreamId } from '@10db/contracts';
import { listEvidence, type DbReader } from '@10db/db';
import { withoutRevertNote } from './reverted-work';

/** The builder's notes on a run the judges read: the latest ones, each cut to this many characters. */
export const BUILDER_NOTES_MAX = 3;
export const BUILDER_NOTE_MAX_CHARS = 1_000;

/**
 * What the builder wrote on a run when they retried it or sent it back, oldest first: the latest
 * `BUILDER_NOTES_MAX`, each cut to `BUILDER_NOTE_MAX_CHARS`, without the revert notes 10db writes beside them. Every
 * judge of the run's calls reads them as the builder's own words.
 */
export function builderNotesOf(db: DbReader, workstreamId: WorkstreamId): string[] {
  return listEvidence(db, workstreamId)
    .filter((e) => e.kind === EvidenceKind.Builder)
    .map((e) => withoutRevertNote(e.summary).slice(0, BUILDER_NOTE_MAX_CHARS))
    .filter((note) => note !== '')
    .slice(-BUILDER_NOTES_MAX);
}
