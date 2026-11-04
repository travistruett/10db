import {
  checkKnowledgeIndex,
  composeKnowledgeText,
  KnowledgeIndex,
  rebuildKnowledgeIndex,
  type TendbDatabase,
} from '@10db/db';
import type { Logger } from '../log';

export interface KnowledgeIndexRepair {
  /** Indexes that disagreed with their tables and were rebuilt. */
  readonly rebuilt: readonly KnowledgeIndex[];
  /** Indexes that could not be rebuilt; search over them fails until they are repaired. */
  readonly failed: readonly KnowledgeIndex[];
}

/**
 * The runtime half of spec §12's knowledge check: an index out of step with its table is rebuilt at
 * start. A check or rebuild that fails is logged and returned, never thrown, so a broken index can't
 * stop the daemon. It raises no card: it asks the builder nothing
 * (`decisions/2026-10-31-notices-not-cards.md`), so the list route says search is unavailable instead.
 */
export function repairKnowledgeIndex(db: TendbDatabase, log: Logger): KnowledgeIndexRepair {
  let broken: readonly KnowledgeIndex[];
  try {
    broken = checkKnowledgeIndex(db);
  } catch (error) {
    // The check itself failed for a reason other than corruption; a rebuild is the only repair to try.
    log.error({ err: error }, 'checking the knowledge search indexes failed; rebuilding both');
    broken = Object.values(KnowledgeIndex);
  }
  const rebuilt: KnowledgeIndex[] = [];
  const failed: KnowledgeIndex[] = [];
  for (const index of broken) {
    log.error({ index }, 'knowledge search index disagreed with its table; rebuilding it');
    try {
      rebuildKnowledgeIndex(db, index);
      rebuilt.push(index);
    } catch (error) {
      log.error(
        { err: error, index },
        'rebuilding the knowledge search index failed; search over it fails until it is repaired',
      );
      failed.push(index);
    }
  }
  // Text stored before writes composed it (NFC) is composed now, through the FTS triggers, so a
  // composed search finds it. It runs after the rebuild: a corrupt index makes its update trigger
  // throw, which would roll back the other table too. A failure leaves the text stored as it was
  // and never stops the daemon.
  try {
    const composed = composeKnowledgeText(db);
    if (composed > 0) log.info({ rows: composed }, 'composed decomposed knowledge text');
  } catch (error) {
    log.error({ err: error }, 'composing the stored knowledge text failed; search may miss it');
  }
  return { rebuilt, failed };
}
