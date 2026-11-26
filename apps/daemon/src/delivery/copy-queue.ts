import { EventType } from '@10db/contracts';
import type { EventBus } from '../events';
import type { BatchStarter } from './start';

/**
 * Cuts a local project's next waiting copy when nothing else of it is unfinished, and drops a waiting
 * copy whose tasks were all cancelled. Looked at on every batch and run change, which is when a copy
 * ships or is abandoned, a refused cut deletes its row, or a waiting task is cancelled; startup runs
 * the same check after recovery, so a change missed while the daemon was down is caught.
 */
export function subscribeCopyQueue(bus: EventBus, starter: BatchStarter): () => void {
  let advancing = false;
  return bus.subscribe((event) => {
    if (event.type !== EventType.BatchUpdated && event.type !== EventType.WorkstreamChanged) return;
    // Cutting a copy writes its journal, which is a batch change: the check it triggers has nothing left to do.
    if (advancing) return;
    advancing = true;
    try {
      starter.advanceCopyQueue();
    } finally {
      advancing = false;
    }
  });
}
