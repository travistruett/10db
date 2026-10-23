import { EventType, WorkstreamId, WorkstreamState } from '@10db/contracts';
import { getWorkstreamRow, type DbReader } from '@10db/db';
import type { EventBus } from '../events';
import type { Shipper } from './ship';

/**
 * The ship trigger (batch delivery spec §4): when a workstream in a batch reaches DONE or CANCELLED,
 * the shipper re-reads the batch and moves it to SHIPPING once all its members settled. Startup
 * runs the same check (`checkOpenBatches`), so a missed event is caught.
 */
export function subscribeShipTrigger(bus: EventBus, db: DbReader, shipper: Shipper): () => void {
  return bus.subscribe((event) => {
    if (event.type !== EventType.WorkstreamChanged) return;
    const to = event.data['to'];
    if (to !== WorkstreamState.Done && to !== WorkstreamState.Cancelled) return;
    const id = WorkstreamId.safeParse(event.entityId);
    if (!id.success) return;
    const { batchId } = getWorkstreamRow(db, id.data);
    if (batchId === null) return;
    shipper.checkBatch(batchId);
  });
}
