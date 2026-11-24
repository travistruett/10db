import { WorkstreamState, type PassId } from '@10db/contracts';
import { getWorkstream, listPassTasks, type DbReader } from '@10db/db';

/** The pass's signed-off pages, in the order they joined it. */
export function signedOffTasks(db: DbReader, passId: PassId) {
  return listPassTasks(db, passId).filter(
    (task) =>
      task.workstreamId !== null &&
      getWorkstream(db, task.workstreamId).state === WorkstreamState.Done,
  );
}
